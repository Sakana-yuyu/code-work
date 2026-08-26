import type {
  CompositionTask,
  CompositionTaskReviewRequest,
  CompositionTaskReviewResult,
  CompositionTaskRun,
  CompositionTaskStatus,
  ProviderRuntimeEvent,
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
import {
  CompositionTaskInputStoreError,
  type CompositionTaskInputStoreShape,
} from "../persistence/Services/CompositionTaskInputStore.ts";
import type { CompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import type * as CapabilityGrantRegistry from "./CapabilityGrantRegistry.ts";
import * as CapabilityRegistry from "./CapabilityRegistry.ts";

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

export class CompositionSquadNotFoundError extends Schema.TaggedErrorClass<CompositionSquadNotFoundError>()(
  "CompositionSquadNotFoundError",
  {
    squadId: Schema.String,
  },
) {
  override get message(): string {
    return `协同组 ${this.squadId} 不存在。`;
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

export class CompositionTaskNotInReviewError extends Schema.TaggedErrorClass<CompositionTaskNotInReviewError>()(
  "CompositionTaskNotInReviewError",
  {
    taskId: Schema.String,
    runId: Schema.String,
    status: Schema.String,
  },
) {
  override get message(): string {
    return `任务 ${this.taskId}/${this.runId} 当前状态为 ${this.status}，不是待审核状态。`;
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
    readonly capabilityGrantIds?: ReadonlyArray<string>;
  }) => Effect.Effect<
    {
      readonly runtimeTaskId?: string;
      readonly capabilityHandshakeId?: string;
    },
    CompositionAgentDriverFailure
  >;
  /** 终态或取消后撤销 Runtime 已接受的 capability handshake。 */
  readonly revokeCapabilityHandshake?: (input: {
    readonly task: CompositionTask;
    readonly run: CompositionTaskRun;
  }) => Effect.Effect<void, CompositionAgentDriverFailure>;
  readonly cancelTask: (input: {
    readonly task: CompositionTask;
    readonly run: CompositionTaskRun;
    readonly reason: string;
  }) => Effect.Effect<
    { readonly status: "cancelled" | "cancel_requested" | "already_terminal" },
    CompositionAgentDriverFailure
  >;
  readonly reviewTask: (
    input: CompositionTaskReviewRequest,
  ) => Effect.Effect<
    CompositionTaskReviewResult,
    CompositionTaskStoreError | CompositionTaskNotFoundError | CompositionTaskNotInReviewError
  >;
  /** 将外部 runtime 事件归属到本驱动已启动的 Composition run。 */
  readonly resolveRuntimeEvent?: (event: ProviderRuntimeEvent) =>
    | {
        readonly taskId: string;
        readonly runId: string;
        readonly runtimeTaskId?: string;
      }
    | undefined;
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
  /** 用户请求的 capability ID；由 Orchestrator 转换为短期 grant。 */
  readonly capabilityIds?: ReadonlyArray<string>;
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

export type CompositionRecoveryResult = ReadonlyArray<CompositionDispatchResult>;

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
    | CompositionSquadNotFoundError
    | CompositionAgentDriverFailure
    | CompositionTaskInputStoreError
    | CapabilityGrantRegistry.CapabilityGrantInvalidError
    | CapabilityGrantRegistry.CapabilityGrantPersistenceError
    | CapabilityRegistry.CapabilityScopeNotFoundError
    | CapabilityRegistry.CapabilityRegistryUnavailableError
  >;
  readonly cancelTask: (input: {
    readonly taskId: string;
    readonly runId: string;
    readonly reason: string;
  }) => Effect.Effect<
    CompositionCancelResult,
    | CompositionTaskStoreError
    | CompositionTaskNotFoundError
    | CompositionAgentDriverFailure
    | CapabilityGrantRegistry.CapabilityGrantPersistenceError
  >;
  readonly resumeReadyTasks: () => Effect.Effect<
    CompositionRecoveryResult,
    | CompositionTaskStoreError
    | CompositionAgentDriverFailure
    | CompositionTaskInputStoreError
    | CapabilityGrantRegistry.CapabilityGrantPersistenceError
  >;
}

const makeOrchestrator = (
  store: CompositionTaskStoreShape,
  driverRegistry: CompositionAgentDriverRegistry,
  grantRegistry?: Pick<CapabilityGrantRegistry.CapabilityGrantRegistryShape, "issue"> &
    Partial<Pick<CapabilityGrantRegistry.CapabilityGrantRegistryShape, "revoke">>,
  inputStore?: CompositionTaskInputStoreShape,
): CompositionOrchestrator => {
  const resumingTaskIds = new Set<string>();

  const revokeRunCapabilities = (
    driver: CompositionAgentDriver | undefined,
    task: CompositionTask,
    run: CompositionTaskRun,
  ) =>
    Effect.gen(function* () {
      if (
        run.capabilityHandshakeId !== undefined &&
        driver?.revokeCapabilityHandshake !== undefined
      ) {
        yield* driver.revokeCapabilityHandshake({ task, run });
      }
      if (grantRegistry?.revoke !== undefined) {
        yield* Effect.forEach(run.capabilityGrantIds ?? [], (grantId) =>
          grantRegistry.revoke!({ grantId }).pipe(
            Effect.catchTag("CapabilityGrantNotFoundError", () => Effect.void),
          ),
        );
      }
    });

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
      const agentId = yield* Effect.gen(function* () {
        if (input.assigneeKind === "agent") return input.assigneeId;
        const squad = yield* store.getSquad(input.assigneeId);
        if (Option.isNone(squad)) {
          return yield* new CompositionSquadNotFoundError({ squadId: input.assigneeId });
        }
        return squad.value.leaderAgentId;
      });
      const driver = yield* driverRegistry.get(agentId);
      const runtimeId = driver?.runtimeId ?? "unresolved";
      if (
        inputStore !== undefined &&
        input.prompt !== undefined &&
        input.workspaceRoot !== undefined
      ) {
        yield* inputStore.save({
          taskId: input.taskId,
          prompt: input.prompt,
          workspaceRoot: input.workspaceRoot,
          ...(input.workspaceRootDigest === undefined
            ? {}
            : { workspaceRootDigest: input.workspaceRootDigest }),
          ...(input.model === undefined ? {} : { model: input.model }),
        });
      }
      const capabilityGrantIds =
        grantRegistry === undefined || input.capabilityIds === undefined
          ? []
          : yield* grantRegistry
              .issue({
                taskId: input.taskId,
                agentId,
                capabilityIds: input.capabilityIds,
              })
              .pipe(Effect.map((grants) => grants.map((grant) => grant.grantId)));
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
        agentId,
        runtimeId,
        status: initialStatus,
        attempt: 1,
        capabilityGrantIds,
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
        yield* revokeRunCapabilities(driver, failedTask, failedRun);
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
          capabilityGrantIds: run.capabilityGrantIds ?? [],
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
        yield* revokeRunCapabilities(driver, failedTask, failedRun);
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
        ...(startResult.success.capabilityHandshakeId === undefined
          ? {}
          : { capabilityHandshakeId: startResult.success.capabilityHandshakeId }),
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
        const driverResult = yield* driver.cancelTask({ task, run, reason: input.reason });
        if (driverResult.status === "already_terminal") {
          return { task, run, status: "already_terminal" as const };
        }
        if (driverResult.status === "cancel_requested") {
          const priorEvents = yield* store.listEvents(input.taskId, input.runId);
          yield* store.appendEvent({
            taskId: task.taskId,
            runId: run.runId,
            ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
            agentId: run.agentId,
            runtimeId: run.runtimeId,
            status: task.status,
            sequence: priorEvents.length,
            eventType: "message",
            summary: "取消请求已提交，等待 Runtime 确认",
          });
          return { task, run, status: "cancel_requested" as const };
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
      yield* revokeRunCapabilities(driver, cancelledTask, cancelledRun);
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

  const reviewTask: CompositionOrchestrator["reviewTask"] = (input) =>
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
      if (task.status !== "in_review" || run.status !== "in_review") {
        return yield* new CompositionTaskNotInReviewError({
          taskId: input.taskId,
          runId: input.runId,
          status: `${task.status}/${run.status}`,
        });
      }
      const now = yield* Clock.currentTimeMillis;
      const approved = input.decision === "approve";
      const nextStatus: CompositionTaskStatus = approved ? "completed" : "failed";
      const nextTask: CompositionTask = {
        ...task,
        status: nextStatus,
        updatedAtUnixMs: now,
        finishedAtUnixMs: now,
      };
      const nextRun: CompositionTaskRun = {
        ...run,
        status: nextStatus,
        finishedAtUnixMs: now,
        ...(approved ? {} : { failureCode: "review_rejected" }),
        resultSummary: input.reason,
      };
      yield* store.upsertTask(nextTask);
      yield* store.upsertRun(nextRun);
      const priorEvents = yield* store.listEvents(input.taskId, input.runId);
      yield* store.appendEvent({
        taskId: nextTask.taskId,
        runId: nextRun.runId,
        ...(nextTask.parentTaskId === undefined ? {} : { parentTaskId: nextTask.parentTaskId }),
        agentId: nextRun.agentId,
        runtimeId: nextRun.runtimeId,
        status: nextStatus,
        sequence: priorEvents.length,
        eventType: "status",
        summary: approved ? `审核通过：${input.reason}` : `审核拒绝：${input.reason}`,
      });
      return {
        task: nextTask,
        run: nextRun,
        status: approved ? "approved" : "rejected",
      };
    });

  const resumeReadyTasks: CompositionOrchestrator["resumeReadyTasks"] = () =>
    Effect.gen(function* () {
      if (inputStore === undefined) return [];
      const tasks = yield* store.listTasks();
      const resumed: Array<CompositionDispatchResult> = [];

      for (const task of tasks) {
        if (task.status !== "blocked" || resumingTaskIds.has(task.taskId)) continue;
        const dependencies = yield* Effect.forEach(task.dependsOnTaskIds, (dependencyId) =>
          store.getTask(dependencyId),
        );
        if (
          dependencies.length !== task.dependsOnTaskIds.length ||
          dependencies.some(
            (dependency) =>
              Option.isNone(dependency) || !dependencySatisfied(dependency.value.status),
          )
        ) {
          continue;
        }

        const recoveryInput = yield* inputStore.get(task.taskId);
        if (Option.isNone(recoveryInput)) continue;
        const runOption = yield* store.getLatestRun(task.taskId);
        if (Option.isNone(runOption)) continue;
        const run = runOption.value;
        const driver = yield* driverRegistry.get(run.agentId);
        if (driver === undefined) continue;

        resumingTaskIds.add(task.taskId);
        const result = yield* Effect.gen(function* () {
          const startResult = yield* Effect.result(
            driver.startTask({
              task,
              run,
              prompt: recoveryInput.value.prompt,
              workspaceRoot: recoveryInput.value.workspaceRoot,
              ...(recoveryInput.value.workspaceRootDigest === undefined
                ? {}
                : { workspaceRootDigest: recoveryInput.value.workspaceRootDigest }),
              ...(recoveryInput.value.model === undefined
                ? {}
                : { model: recoveryInput.value.model }),
              capabilityGrantIds: run.capabilityGrantIds,
            }),
          );
          if (startResult._tag === "Failure") {
            const failedAt = yield* Clock.currentTimeMillis;
            const failedTask: CompositionTask = {
              ...task,
              status: "failed",
              updatedAtUnixMs: failedAt,
              finishedAtUnixMs: failedAt,
            };
            const failedRun: CompositionTaskRun = {
              ...run,
              runtimeId: driver.runtimeId,
              status: "failed",
              finishedAtUnixMs: failedAt,
              failureCode: startResult.failure.code,
              resultSummary: startResult.failure.detail,
            };
            yield* revokeRunCapabilities(driver, failedTask, failedRun);
            yield* store.upsertTask(failedTask);
            yield* store.upsertRun(failedRun);
            const events = yield* store.listEvents(task.taskId, run.runId);
            yield* store.appendEvent(
              makeEvent({
                task: failedTask,
                run: failedRun,
                sequence: events.length,
                status: "failed",
                eventType: "status",
                summary: "恢复任务启动失败",
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
            ...(startResult.success.capabilityHandshakeId === undefined
              ? {}
              : { capabilityHandshakeId: startResult.success.capabilityHandshakeId }),
            status: "running",
            startedAtUnixMs: startedAt,
          };
          yield* store.upsertTask(runningTask);
          yield* store.upsertRun(runningRun);
          const events = yield* store.listEvents(task.taskId, run.runId);
          yield* store.appendEvent(
            makeEvent({
              task: runningTask,
              run: runningRun,
              sequence: events.length,
              status: "running",
              eventType: "status",
              summary: "依赖完成后已恢复任务",
            }),
          );
          return { task: runningTask, run: runningRun };
        }).pipe(Effect.ensuring(Effect.sync(() => resumingTaskIds.delete(task.taskId))));
        resumed.push(result);
      }

      return resumed;
    });

  return { dispatchTask, cancelTask, reviewTask, resumeReadyTasks };
};

export const makeCompositionOrchestrator = (
  store: CompositionTaskStoreShape,
  driverRegistry: CompositionAgentDriverRegistry,
  grantRegistry?: Pick<CapabilityGrantRegistry.CapabilityGrantRegistryShape, "issue"> &
    Partial<Pick<CapabilityGrantRegistry.CapabilityGrantRegistryShape, "revoke">>,
  inputStore?: CompositionTaskInputStoreShape,
): CompositionOrchestrator => makeOrchestrator(store, driverRegistry, grantRegistry, inputStore);
