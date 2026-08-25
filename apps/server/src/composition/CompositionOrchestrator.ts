import type {
  CompositionTask,
  CompositionTaskRun,
  CompositionTaskStatus,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  CompositionTaskStore,
  type CompositionTaskStoreError,
  type CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import type { CompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";

export class CompositionTaskDependencyMissingError extends Schema.TaggedErrorClass<CompositionTaskDependencyMissingError>()(
  "CompositionTaskDependencyMissingError",
  {
    taskId: Schema.String,
    dependsOnTaskId: Schema.String,
  },
) {
  override get message(): string {
    return `任务 ${this.taskId} 依赖的任务 ${this.dependsOnTaskId} 不存在。`;
  }
}

export class CompositionTaskDependencyCycleError extends Schema.TaggedErrorClass<CompositionTaskDependencyCycleError>()(
  "CompositionTaskDependencyCycleError",
  {
    taskId: Schema.String,
    dependsOnTaskId: Schema.String,
  },
) {
  override get message(): string {
    return `任务 ${this.taskId} 与依赖 ${this.dependsOnTaskId} 形成循环。`;
  }
}

export class CompositionTaskAlreadyExistsError extends Schema.TaggedErrorClass<CompositionTaskAlreadyExistsError>()(
  "CompositionTaskAlreadyExistsError",
  {
    taskId: Schema.String,
  },
) {
  override get message(): string {
    return `任务 ${this.taskId} 已存在，拒绝重复派发。`;
  }
}

export class CompositionTaskNotFoundError extends Schema.TaggedErrorClass<CompositionTaskNotFoundError>()(
  "CompositionTaskNotFoundError",
  {
    taskId: Schema.String,
    runId: Schema.String,
  },
) {
  override get message(): string {
    return `任务 ${this.taskId} 或运行 ${this.runId} 不存在。`;
  }
}

export class CompositionAgentDriverFailure extends Schema.TaggedErrorClass<CompositionAgentDriverFailure>()(
  "CompositionAgentDriverFailure",
  {
    code: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Agent Driver 启动失败：${this.code}: ${this.detail}`;
  }
}

export interface CompositionAgentDriver {
  readonly agentId: string;
  readonly runtimeId: string;
  readonly startTask: (input: {
    readonly task: CompositionTask;
    readonly run: CompositionTaskRun;
    readonly workspaceRootDigest?: string;
    /** 只在运行时传递，不写入 CompositionTask 持久化表。 */
    readonly workspaceRoot?: string;
    /** 只在运行时传递，不写入 CompositionTask 持久化表。 */
    readonly prompt?: string;
    readonly model?: string;
  }) => Effect.Effect<{ readonly runtimeTaskId?: string }, CompositionAgentDriverFailure>;
  readonly cancelTask: (input: {
    readonly task: CompositionTask;
    readonly run: CompositionTaskRun;
    readonly reason: string;
  }) => Effect.Effect<
    { readonly status: "cancelled" | "cancel_requested" | "already_terminal" },
    CompositionAgentDriverFailure
  >;
}

export type CompositionDispatchInput = {
  readonly taskId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly threadId?: string;
  readonly parentTaskId?: string;
  readonly assigneeKind: "agent" | "squad";
  readonly assigneeId: string;
  readonly mode: "serial" | "parallel" | "review";
  readonly promptDigest: string;
  readonly dependsOnTaskIds: ReadonlyArray<string>;
  readonly workspaceRootDigest?: string;
  /** 完整 prompt 只用于本次派发，不进入任务持久化投影。 */
  readonly workspaceRoot?: string;
  readonly prompt?: string;
  readonly model?: string;
};

export type CompositionDispatchResult = {
  readonly task: CompositionTask;
  readonly run: CompositionTaskRun;
};

export type CompositionCancelResult = {
  readonly task: CompositionTask;
  readonly run: CompositionTaskRun;
  readonly status: "cancelled" | "cancel_requested" | "already_terminal";
};

const terminalStatuses: ReadonlySet<CompositionTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

const dependencySatisfied = (status: CompositionTaskStatus): boolean => status === "completed";

const makeEvent = (input: {
  readonly task: CompositionTask;
  readonly run: CompositionTaskRun;
  readonly sequence: number;
  readonly status: CompositionTaskStatus;
  readonly eventType: "blocker" | "status";
  readonly summary: string;
  readonly blockerCode?: string;
}) => ({
  taskId: input.task.taskId,
  runId: input.run.runId,
  agentId: input.run.agentId,
  status: input.status,
  sequence: input.sequence,
  eventType: input.eventType,
  summary: input.summary,
  ...(input.blockerCode === undefined ? {} : { blockerCode: input.blockerCode }),
});

export interface CompositionOrchestrator {
  readonly dispatchTask: (
    input: CompositionDispatchInput,
  ) => Effect.Effect<
    CompositionDispatchResult,
    | CompositionTaskStoreError
    | CompositionTaskDependencyMissingError
    | CompositionTaskDependencyCycleError
    | CompositionTaskAlreadyExistsError
  >;
  readonly cancelTask: (input: {
    readonly taskId: string;
    readonly runId: string;
    readonly reason: string;
  }) => Effect.Effect<
    CompositionCancelResult,
    CompositionTaskStoreError | CompositionTaskNotFoundError
  >;
}

const makeOrchestrator = (
  store: CompositionTaskStoreShape,
  driverRegistry: CompositionAgentDriverRegistry,
): CompositionOrchestrator => {
  const validateDependencies = (
    taskId: string,
    dependencyIds: ReadonlyArray<string>,
  ): Effect.Effect<
    void,
    | CompositionTaskStoreError
    | CompositionTaskDependencyMissingError
    | CompositionTaskDependencyCycleError
  > => {
    const visiting = new Set<string>();
    const visited = new Set<string>();

    function visit(
      currentTaskId: string,
    ): Effect.Effect<
      void,
      | CompositionTaskStoreError
      | CompositionTaskDependencyMissingError
      | CompositionTaskDependencyCycleError
    > {
      return Effect.gen(function* () {
        if (visiting.has(currentTaskId)) {
          return yield* new CompositionTaskDependencyCycleError({
            taskId,
            dependsOnTaskId: currentTaskId,
          });
        }
        if (visited.has(currentTaskId)) {
          return;
        }
        visiting.add(currentTaskId);
        const dependency = yield* store.getTask(currentTaskId);
        if (Option.isNone(dependency)) {
          return yield* new CompositionTaskDependencyMissingError({
            taskId,
            dependsOnTaskId: currentTaskId,
          });
        }
        for (const nestedDependencyId of dependency.value.dependsOnTaskIds) {
          yield* visit(nestedDependencyId);
        }
        visiting.delete(currentTaskId);
        visited.add(currentTaskId);
      });
    }

    return Effect.gen(function* () {
      for (const dependencyId of dependencyIds) {
        if (dependencyId === taskId) {
          return yield* new CompositionTaskDependencyCycleError({
            taskId,
            dependsOnTaskId: dependencyId,
          });
        }
        yield* visit(dependencyId);
      }
    });
  };

  const dispatchTask: CompositionOrchestrator["dispatchTask"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* store.getTask(input.taskId);
      if (Option.isSome(existing)) {
        return yield* new CompositionTaskAlreadyExistsError({ taskId: input.taskId });
      }

      yield* validateDependencies(input.taskId, input.dependsOnTaskIds);
      const now = yield* Clock.currentTimeMillis;
      const dependencies = yield* Effect.forEach(input.dependsOnTaskIds, (dependencyId) =>
        store.getTask(dependencyId).pipe(Effect.map((task) => ({ dependencyId, task }))),
      );
      const blockedDependency = dependencies.find(
        (dependency) =>
          Option.isSome(dependency.task) && !dependencySatisfied(dependency.task.value.status),
      );
      const initialStatus: CompositionTaskStatus =
        blockedDependency === undefined ? "queued" : "blocked";
      const driver = yield* driverRegistry.get(input.assigneeId);
      const runtimeId = driver?.runtimeId ?? "unresolved";
      const task: CompositionTask = {
        taskId: input.taskId,
        projectId: input.projectId,
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
        assigneeKind: input.assigneeKind,
        assigneeId: input.assigneeId,
        mode: input.mode,
        status: initialStatus,
        promptDigest: input.promptDigest,
        dependsOnTaskIds: [...input.dependsOnTaskIds],
        createdAtUnixMs: now,
        updatedAtUnixMs: now,
      };
      const run: CompositionTaskRun = {
        runId: input.runId,
        taskId: input.taskId,
        agentId: input.assigneeId,
        runtimeId,
        status: initialStatus,
        attempt: 1,
      };

      yield* store.upsertTask(task);
      yield* store.upsertRun(run);
      for (const dependency of input.dependsOnTaskIds) {
        yield* store.upsertDependency({
          taskId: input.taskId,
          dependsOnTaskId: dependency,
          condition: "success",
          createdAtUnixMs: now,
        });
      }
      yield* store.appendEvent(
        makeEvent({
          task,
          run,
          sequence: 0,
          status: initialStatus,
          eventType: initialStatus === "blocked" ? "blocker" : "status",
          summary: initialStatus === "blocked" ? "等待依赖任务完成" : "任务已排队",
          ...(initialStatus === "blocked" ? { blockerCode: "dependency_pending" } : {}),
        }),
      );

      if (blockedDependency !== undefined) {
        return { task, run };
      }

      if (driver === undefined) {
        const failedAt = yield* Clock.currentTimeMillis;
        const failedTask: CompositionTask = {
          ...task,
          status: "failed",
          updatedAtUnixMs: failedAt,
        };
        const failedRun: CompositionTaskRun = {
          ...run,
          status: "failed",
          finishedAtUnixMs: failedAt,
          failureCode: "agent_driver_unavailable",
          resultSummary: "未找到可用的 Agent Driver",
        };
        yield* store.upsertTask(failedTask);
        yield* store.upsertRun(failedRun);
        yield* store.appendEvent(
          makeEvent({
            task: failedTask,
            run: failedRun,
            sequence: 1,
            status: "failed",
            eventType: "status",
            summary: "Agent Driver 不可用",
          }),
        );
        return { task: failedTask, run: failedRun };
      }

      const startResult = yield* Effect.result(
        driver.startTask({
          task,
          run,
          ...(input.workspaceRootDigest === undefined
            ? {}
            : { workspaceRootDigest: input.workspaceRootDigest }),
          ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
          ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
          ...(input.model === undefined ? {} : { model: input.model }),
        }),
      );
      if (startResult._tag === "Failure") {
        const failedAt = yield* Clock.currentTimeMillis;
        const failedTask: CompositionTask = {
          ...task,
          status: "failed",
          updatedAtUnixMs: failedAt,
        };
        const failedRun: CompositionTaskRun = {
          ...run,
          status: "failed",
          runtimeId: driver.runtimeId,
          finishedAtUnixMs: failedAt,
          failureCode: startResult.failure.code,
          resultSummary: startResult.failure.detail,
        };
        yield* store.upsertTask(failedTask);
        yield* store.upsertRun(failedRun);
        yield* store.appendEvent(
          makeEvent({
            task: failedTask,
            run: failedRun,
            sequence: 1,
            status: "failed",
            eventType: "status",
            summary: "Agent Driver 启动失败",
          }),
        );
        return { task: failedTask, run: failedRun };
      }

      const startedAt = yield* Clock.currentTimeMillis;
      const runningTask: CompositionTask = {
        ...task,
        status: "running",
        updatedAtUnixMs: startedAt,
      };
      const runningRun: CompositionTaskRun = {
        ...run,
        runtimeId: driver.runtimeId,
        runtimeTaskId: startResult.success.runtimeTaskId,
        status: "running",
        startedAtUnixMs: startedAt,
      };
      yield* store.upsertTask(runningTask);
      yield* store.upsertRun(runningRun);
      yield* store.appendEvent(
        makeEvent({
          task: runningTask,
          run: runningRun,
          sequence: 1,
          status: "running",
          eventType: "status",
          summary: "任务已交给 Agent Driver 执行",
        }),
      );
      return { task: runningTask, run: runningRun };
    });

  const cancelTask: CompositionOrchestrator["cancelTask"] = (input) =>
    Effect.gen(function* () {
      const taskOption = yield* store.getTask(input.taskId);
      const runOption = yield* store.getRun(input.runId);
      if (Option.isNone(taskOption) || Option.isNone(runOption)) {
        return yield* new CompositionTaskNotFoundError({
          taskId: input.taskId,
          runId: input.runId,
        });
      }
      const task = taskOption.value;
      const run = runOption.value;
      if (terminalStatuses.has(task.status)) {
        return { task, run, status: "already_terminal" as const };
      }
      const driver = yield* driverRegistry.get(run.agentId);
      if (driver !== undefined) {
        const driverResult = yield* Effect.result(
          driver.cancelTask({ task, run, reason: input.reason }),
        );
        if (driverResult._tag === "Success" && driverResult.success.status === "already_terminal") {
          return { task, run, status: "already_terminal" as const };
        }
      }
      const now = yield* Clock.currentTimeMillis;
      const cancelledTask: CompositionTask = {
        ...task,
        status: "cancelled",
        updatedAtUnixMs: now,
        finishedAtUnixMs: now,
      };
      const cancelledRun: CompositionTaskRun = {
        ...run,
        status: "cancelled",
        finishedAtUnixMs: now,
        resultSummary: input.reason,
      };
      yield* store.upsertTask(cancelledTask);
      yield* store.upsertRun(cancelledRun);
      const priorEvents = yield* store.listEvents(input.taskId, input.runId);
      yield* store.appendEvent(
        makeEvent({
          task: cancelledTask,
          run: cancelledRun,
          sequence: priorEvents.length,
          status: "cancelled",
          eventType: "status",
          summary: "任务已取消",
        }),
      );
      return { task: cancelledTask, run: cancelledRun, status: "cancelled" as const };
    });

  return { dispatchTask, cancelTask };
};

export const makeCompositionOrchestrator = (
  store: CompositionTaskStoreShape,
  driverRegistry: CompositionAgentDriverRegistry,
): CompositionOrchestrator => makeOrchestrator(store, driverRegistry);
