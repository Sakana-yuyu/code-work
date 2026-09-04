import * as NodeCrypto from "node:crypto";

import type {
  CompositionTask,
  CompositionTaskRun,
  CompositionTaskStatus,
  ThreadGoalStatus,
} from "@codework/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isPersistenceError } from "../persistence/Errors.ts";
import {
  CompositionTaskStore,
  type CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import { CompositionAgentDriverRegistryService } from "./CompositionAgentDriverRegistry.ts";
import {
  classifyCompositionFailure,
  toCompositionFailureInput,
} from "./CompositionFailurePolicy.ts";
import { composeGoalLoopRoundPrompt } from "./CompositionGoalLoopAttemptAdapters.ts";
import {
  describeGoalLoopTerminal,
  goalLoopEventPrefix,
  runCompositionGoalLoopWithLedger,
} from "./CompositionGoalLoopRunner.ts";
import type { CompositionGoalLoopStatus } from "./CompositionGoalLoop.ts";
import {
  composeGoalValidatorPrompt,
  parseGoalValidatorVerdict,
} from "./CompositionGoalValidator.ts";
import {
  CompositionTaskAlreadyExistsError,
  type CompositionDispatchInput,
  type CompositionDispatchResult,
  type CompositionOrchestrator,
} from "./CompositionOrchestrator.ts";
import { CompositionOrchestratorService } from "./CompositionOrchestratorService.ts";
import { recoverCompositionTaskOutput } from "./CompositionSquadPlanner.ts";
import {
  CompositionTaskRuntimeProjectionService,
  type CompositionTaskRuntimeProjectionServiceShape,
} from "./CompositionTaskRuntimeProjectionService.ts";
import {
  ThreadGoalStore,
  type ThreadGoalStoreShape,
} from "../persistence/Services/ThreadGoalStore.ts";

export class CompositionGoalLoopAutomationRunnerError extends Schema.TaggedErrorClass<CompositionGoalLoopAutomationRunnerError>()(
  "CompositionGoalLoopAutomationRunnerError",
  {
    code: Schema.String,
    detail: Schema.String,
    retryable: Schema.Boolean,
  },
) {
  override get message(): string {
    return `Goal Loop Automation 执行失败：${this.code}: ${this.detail}`;
  }
}

const isGoalLoopAutomationRunnerError = Schema.is(CompositionGoalLoopAutomationRunnerError);

export type CompositionGoalLoopAutomationRunInput = {
  readonly taskId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly threadId?: string;
  readonly agentId: string;
  readonly reviewerAgentId?: string;
  readonly model?: string;
  readonly capabilityIds: ReadonlyArray<string>;
  readonly workspaceRoot: string;
  readonly goal: string;
  readonly maxAttempts: number;
  readonly maxCostUnits?: number;
  readonly stalePivotRounds?: number;
  readonly deadlineDurationMs?: number;
  /** 外部控制面取消当前 Loop；每轮开始前由底层 Goal Loop 检查。 */
  readonly isCancelled?: () => boolean;
  readonly startedAtUnixMs: number;
};

export type CompositionGoalLoopAutomationRunResult = {
  readonly goalStatus: CompositionGoalLoopStatus;
  readonly automationStatus: "succeeded" | "failed" | "cancelled";
  readonly summary: string;
  readonly errorCode?: string;
};

export interface CompositionGoalLoopAutomationRunnerShape {
  readonly run: (
    input: CompositionGoalLoopAutomationRunInput,
  ) => Effect.Effect<
    CompositionGoalLoopAutomationRunResult,
    CompositionGoalLoopAutomationRunnerError
  >;
}

export class CompositionGoalLoopAutomationRunner extends Context.Service<
  CompositionGoalLoopAutomationRunner,
  CompositionGoalLoopAutomationRunnerShape
>()("codework/composition/CompositionGoalLoopAutomationRunner") {}

type AgentResolution = {
  readonly agentId: string;
  readonly runtimeId: string;
};

type AgentResolver = {
  readonly resolve: (agentId: string) => Effect.Effect<Option.Option<AgentResolution>>;
};

type GoalLoopStore = Pick<
  CompositionTaskStoreShape,
  | "getTask"
  | "getRun"
  | "upsertTask"
  | "upsertRun"
  | "appendEventIfNew"
  | "listEvents"
  | "withTransaction"
>;

export interface CompositionGoalLoopAutomationRunnerOptions {
  readonly agents: AgentResolver;
  readonly orchestrator: Pick<CompositionOrchestrator, "dispatchTask">;
  readonly runtime: Pick<CompositionTaskRuntimeProjectionServiceShape, "awaitTaskCompletion">;
  readonly store: GoalLoopStore;
  readonly threadGoalStore?: Pick<ThreadGoalStoreShape, "get" | "setStatus" | "clear">;
  readonly now?: () => number;
}

const parentTerminalStatuses: ReadonlySet<CompositionTaskStatus> = new Set([
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

const childTerminalStatuses: ReadonlySet<CompositionTaskStatus> = new Set([
  "in_review",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

const isTaskAlreadyExistsError = Schema.is(CompositionTaskAlreadyExistsError);

const sha256 = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");

const errorDetail = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const taggedErrorCode = (cause: unknown, fallback: string): string => {
  if (typeof cause !== "object" || cause === null) return fallback;
  if ("code" in cause && typeof cause.code === "string" && cause.code.trim().length > 0) {
    return cause.code.trim();
  }
  if ("_tag" in cause && typeof cause._tag === "string" && cause._tag.trim().length > 0) {
    return cause._tag.trim();
  }
  return fallback;
};

const runnerError = (
  code: string,
  detail: string,
  retryable: boolean,
): CompositionGoalLoopAutomationRunnerError =>
  new CompositionGoalLoopAutomationRunnerError({ code, detail, retryable });

const persistenceError = (operation: string, cause: unknown) =>
  runnerError("goal_loop_persistence_failed", `${operation}失败：${errorDetail(cause)}`, true);

const goalTerminalCode = (status: CompositionGoalLoopStatus): string | undefined => {
  switch (status) {
    case "completed":
      return undefined;
    case "budget_exhausted":
      return "goal_loop_budget_exhausted";
    case "deadline_exceeded":
      return "goal_loop_deadline_exceeded";
    case "cancelled":
      return "goal_loop_cancelled";
    case "pivot_required":
      return "goal_loop_pivot_required";
  }
};

const automationStatusFor = (
  status: CompositionGoalLoopStatus,
): CompositionGoalLoopAutomationRunResult["automationStatus"] =>
  status === "completed" ? "succeeded" : status === "cancelled" ? "cancelled" : "failed";

const threadGoalStatusFor = (status: CompositionGoalLoopStatus): ThreadGoalStatus => {
  switch (status) {
    case "completed":
      return "complete";
    case "budget_exhausted":
      return "budgetLimited";
    case "cancelled":
      return "paused";
    case "deadline_exceeded":
    case "pivot_required":
      return "blocked";
  }
};

const goalStatusFromParent = (run: CompositionTaskRun): CompositionGoalLoopStatus | undefined => {
  if (run.status === "completed") return "completed";
  switch (run.failureCode) {
    case "goal_loop_budget_exhausted":
      return "budget_exhausted";
    case "goal_loop_deadline_exceeded":
      return "deadline_exceeded";
    case "goal_loop_cancelled":
      return "cancelled";
    case "goal_loop_pivot_required":
      return "pivot_required";
    default:
      return undefined;
  }
};

const resultFromParent = (
  run: CompositionTaskRun,
): CompositionGoalLoopAutomationRunResult | undefined => {
  const goalStatus = goalStatusFromParent(run);
  if (goalStatus === undefined || run.resultSummary === undefined) return undefined;
  const errorCode = goalTerminalCode(goalStatus);
  return {
    goalStatus,
    automationStatus: automationStatusFor(goalStatus),
    summary: run.resultSummary,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
};

const syncThreadGoalStatus = (
  input: CompositionGoalLoopAutomationRunInput,
  status: CompositionGoalLoopStatus,
  store: CompositionGoalLoopAutomationRunnerOptions["threadGoalStore"],
): Effect.Effect<void, CompositionGoalLoopAutomationRunnerError> =>
  input.threadId === undefined || store === undefined
    ? Effect.void
    : store.get(input.threadId).pipe(
        Effect.mapError((cause) => persistenceError("读取线程 Goal 终态", cause)),
        Effect.flatMap((current) => {
          if (Option.isNone(current)) return Effect.void;
          if (status === "completed") {
            const markComplete =
              current.value.status === "complete"
                ? Effect.succeed(current.value)
                : store.setStatus({ threadId: input.threadId!, status: "complete" });
            return markComplete.pipe(
              Effect.mapError((cause) => persistenceError("同步线程 Goal 完成态", cause)),
              Effect.flatMap(() =>
                store.clear(input.threadId!).pipe(
                  Effect.asVoid,
                  Effect.mapError((cause) => persistenceError("清除已完成线程 Goal", cause)),
                ),
              ),
            );
          }
          return store
            .setStatus({ threadId: input.threadId!, status: threadGoalStatusFor(status) })
            .pipe(
              Effect.asVoid,
              Effect.mapError((cause) => persistenceError("同步线程 Goal 终态", cause)),
            );
        }),
      );

const sameIds = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const matchesParentIdentity = (
  task: CompositionTask,
  run: CompositionTaskRun,
  input: CompositionGoalLoopAutomationRunInput,
  runtimeId: string,
): boolean =>
  task.taskId === input.taskId &&
  task.projectId === input.projectId &&
  task.threadId === input.threadId &&
  task.parentTaskId === undefined &&
  task.assigneeKind === "agent" &&
  task.assigneeId === input.agentId &&
  task.mode === "serial" &&
  task.promptDigest === sha256(input.goal) &&
  task.dependsOnTaskIds.length === 0 &&
  run.runId === input.runId &&
  run.taskId === input.taskId &&
  run.agentId === input.agentId &&
  run.runtimeId === runtimeId &&
  run.attempt === 1;

const matchesChildIdentity = (
  task: CompositionTask,
  run: CompositionTaskRun,
  input: CompositionDispatchInput,
): boolean =>
  task.taskId === input.taskId &&
  task.projectId === input.projectId &&
  task.threadId === input.threadId &&
  task.parentTaskId === input.parentTaskId &&
  task.assigneeKind === input.assigneeKind &&
  task.assigneeId === input.assigneeId &&
  task.mode === input.mode &&
  task.promptDigest === input.promptDigest &&
  sameIds(task.dependsOnTaskIds, input.dependsOnTaskIds) &&
  run.runId === input.runId &&
  run.taskId === input.taskId &&
  run.agentId === input.assigneeId &&
  run.attempt === 1;

const validateInput = (
  input: CompositionGoalLoopAutomationRunInput,
): CompositionGoalLoopAutomationRunnerError | undefined => {
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts <= 0) {
    return runnerError("goal_loop_input_invalid", "maxAttempts 必须为正整数。", false);
  }
  if (input.maxCostUnits !== undefined && input.maxCostUnits < 0) {
    return runnerError("goal_loop_input_invalid", "maxCostUnits 不能为负数。", false);
  }
  if (
    input.stalePivotRounds !== undefined &&
    (!Number.isInteger(input.stalePivotRounds) || input.stalePivotRounds <= 0)
  ) {
    return runnerError("goal_loop_input_invalid", "stalePivotRounds 必须为正整数。", false);
  }
  if (
    input.deadlineDurationMs !== undefined &&
    (!Number.isInteger(input.deadlineDurationMs) || input.deadlineDurationMs <= 0)
  ) {
    return runnerError("goal_loop_input_invalid", "deadlineDurationMs 必须为正整数。", false);
  }
  if (input.reviewerAgentId !== undefined && input.reviewerAgentId === input.agentId) {
    return runnerError(
      "goal_loop_reviewer_invalid",
      "reviewerAgentId 必须与执行 Agent 不同。",
      false,
    );
  }
  return undefined;
};

export const makeCompositionGoalLoopAutomationRunner = (
  options: CompositionGoalLoopAutomationRunnerOptions,
): CompositionGoalLoopAutomationRunnerShape => {
  const now = options.now ?? Date.now;

  const loadPersistedParent = Effect.fn("CompositionGoalLoopAutomationRunner.loadPersistedParent")(
    function* (input: CompositionGoalLoopAutomationRunInput) {
      const [taskOption, runOption] = yield* Effect.all([
        options.store.getTask(input.taskId),
        options.store.getRun(input.runId),
      ]).pipe(Effect.mapError((cause) => persistenceError("读取 Goal Loop 父身份", cause)));
      if (Option.isNone(taskOption) && Option.isNone(runOption)) return undefined;
      if (
        Option.isNone(taskOption) ||
        Option.isNone(runOption) ||
        !matchesParentIdentity(taskOption.value, runOption.value, input, runOption.value.runtimeId)
      ) {
        return yield* runnerError(
          "goal_loop_parent_identity_conflict",
          `Goal Loop 稳定身份 ${input.taskId}/${input.runId} 与既有记录冲突。`,
          false,
        );
      }
      return { task: taskOption.value, run: runOption.value };
    },
  );

  const resolveAgent = Effect.fn("CompositionGoalLoopAutomationRunner.resolveAgent")(function* (
    agentId: string,
    role: "executor" | "reviewer",
  ) {
    const resolved = yield* options.agents.resolve(agentId);
    if (Option.isNone(resolved)) {
      return yield* runnerError(
        role === "executor"
          ? "goal_loop_agent_driver_unavailable"
          : "goal_loop_reviewer_driver_unavailable",
        `未找到 ${role === "executor" ? "执行" : "评审"} Agent Driver：${agentId}。`,
        true,
      );
    }
    return resolved.value;
  });

  const ensureParent = Effect.fn("CompositionGoalLoopAutomationRunner.ensureParent")(function* (
    input: CompositionGoalLoopAutomationRunInput,
    agent: AgentResolution,
  ) {
    return yield* options.store
      .withTransaction(
        Effect.gen(function* () {
          const [taskOption, runOption] = yield* Effect.all([
            options.store.getTask(input.taskId),
            options.store.getRun(input.runId),
          ]);
          if (Option.isNone(taskOption) !== Option.isNone(runOption)) {
            return yield* runnerError(
              "goal_loop_parent_identity_conflict",
              "Goal Loop 父 Task/Run 持久化状态不完整。",
              false,
            );
          }
          if (Option.isSome(taskOption) && Option.isSome(runOption)) {
            if (!matchesParentIdentity(taskOption.value, runOption.value, input, agent.runtimeId)) {
              return yield* runnerError(
                "goal_loop_parent_identity_conflict",
                `Goal Loop 稳定身份 ${input.taskId}/${input.runId} 与既有记录冲突。`,
                false,
              );
            }
            return { task: taskOption.value, run: runOption.value };
          }

          const observedAtUnixMs = Math.max(input.startedAtUnixMs, now());
          const task: CompositionTask = {
            taskId: input.taskId,
            projectId: input.projectId,
            ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
            assigneeKind: "agent",
            assigneeId: input.agentId,
            mode: "serial",
            status: "running",
            promptDigest: sha256(input.goal),
            dependsOnTaskIds: [],
            createdAtUnixMs: observedAtUnixMs,
            updatedAtUnixMs: observedAtUnixMs,
          };
          const run: CompositionTaskRun = {
            runId: input.runId,
            taskId: input.taskId,
            agentId: input.agentId,
            runtimeId: agent.runtimeId,
            status: "running",
            attempt: 1,
            capabilityGrantIds: [],
            startedAtUnixMs: input.startedAtUnixMs,
          };
          yield* options.store.upsertTask(task);
          yield* options.store.upsertRun(run);
          return { task, run };
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isGoalLoopAutomationRunnerError(cause)
            ? cause
            : persistenceError("创建或读取 Goal Loop 父身份", cause),
        ),
      );
  });

  const loadExistingChild = Effect.fn("CompositionGoalLoopAutomationRunner.loadExistingChild")(
    function* (dispatch: CompositionDispatchInput) {
      const [taskOption, runOption] = yield* Effect.all([
        options.store.getTask(dispatch.taskId),
        options.store.getRun(dispatch.runId),
      ]).pipe(Effect.mapError((cause) => persistenceError("读取 Goal Loop 子任务", cause)));
      if (Option.isNone(taskOption) && Option.isNone(runOption)) return undefined;
      if (
        Option.isNone(taskOption) ||
        Option.isNone(runOption) ||
        !matchesChildIdentity(taskOption.value, runOption.value, dispatch)
      ) {
        return yield* runnerError(
          "goal_loop_child_identity_conflict",
          `Goal Loop 子任务 ${dispatch.taskId}/${dispatch.runId} 与既有记录冲突。`,
          false,
        );
      }
      return { task: taskOption.value, run: runOption.value } satisfies CompositionDispatchResult;
    },
  );

  const dispatchOrReuse = Effect.fn("CompositionGoalLoopAutomationRunner.dispatchOrReuse")(
    function* (dispatch: CompositionDispatchInput) {
      const existing = yield* loadExistingChild(dispatch);
      if (existing !== undefined) return existing;
      const dispatched = yield* Effect.result(options.orchestrator.dispatchTask(dispatch));
      if (dispatched._tag === "Success") {
        if (!matchesChildIdentity(dispatched.success.task, dispatched.success.run, dispatch)) {
          return yield* runnerError(
            "goal_loop_child_identity_conflict",
            "Composition Orchestrator 返回的 Goal Loop 子任务身份不一致。",
            false,
          );
        }
        return dispatched.success;
      }
      if (isTaskAlreadyExistsError(dispatched.failure)) {
        const raced = yield* loadExistingChild(dispatch);
        if (raced !== undefined) return raced;
      }
      const code = taggedErrorCode(dispatched.failure, "goal_loop_child_dispatch_failed");
      const failure = classifyCompositionFailure({ status: "failed", failureCode: code });
      return yield* runnerError(code, errorDetail(dispatched.failure), failure.retryable);
    },
  );

  const runChild = Effect.fn("CompositionGoalLoopAutomationRunner.runChild")(function* (input: {
    readonly parent: CompositionGoalLoopAutomationRunInput;
    readonly kind: "attempt" | "review";
    readonly round: number;
    readonly agentId: string;
    readonly prompt: string;
    readonly capabilityIds: ReadonlyArray<string>;
  }) {
    const taskId = `${input.parent.taskId}:${input.kind}:${input.round}`;
    const runId = `${input.parent.runId}:${input.kind}:${input.round}`;
    const dispatch: CompositionDispatchInput = {
      taskId,
      runId,
      projectId: input.parent.projectId,
      ...(input.parent.threadId === undefined ? {} : { threadId: input.parent.threadId }),
      parentTaskId: input.parent.taskId,
      assigneeKind: "agent",
      assigneeId: input.agentId,
      mode: "serial",
      promptDigest: sha256(input.prompt),
      dependsOnTaskIds: [],
      workspaceRoot: input.parent.workspaceRoot,
      prompt: input.prompt,
      ...(input.parent.model === undefined ? {} : { model: input.parent.model }),
      capabilityIds: [...input.capabilityIds],
    };
    const dispatched = yield* dispatchOrReuse(dispatch);
    const run = childTerminalStatuses.has(dispatched.run.status)
      ? dispatched.run
      : yield* options.runtime
          .awaitTaskCompletion({ taskId, runId })
          .pipe(
            Effect.mapError((cause) =>
              runnerError(
                taggedErrorCode(cause, "goal_loop_child_wait_failed"),
                errorDetail(cause),
                true,
              ),
            ),
          );
    if (run.status !== "completed") {
      const failure = classifyCompositionFailure(
        toCompositionFailureInput(run.status, run.failureCode),
      );
      return yield* runnerError(
        run.failureCode ?? `goal_loop_${input.kind}_${run.status}`,
        run.resultSummary ?? `Goal Loop ${input.kind} 子任务以状态 ${run.status} 终止。`,
        failure.retryable,
      );
    }
    const events = yield* options.store
      .listEvents(taskId, runId)
      .pipe(Effect.mapError((cause) => persistenceError("读取 Goal Loop 子任务输出", cause)));
    const output = recoverCompositionTaskOutput(events).trim() || run.resultSummary?.trim() || "";
    if (output.length === 0) {
      return yield* runnerError(
        `goal_loop_${input.kind}_output_missing`,
        `Goal Loop ${input.kind} 子任务已完成，但没有持久化输出。`,
        false,
      );
    }
    return output;
  });

  const persistParentTerminal = Effect.fn(
    "CompositionGoalLoopAutomationRunner.persistParentTerminal",
  )(function* (
    input: CompositionGoalLoopAutomationRunInput,
    status: CompositionGoalLoopStatus,
    summary: string,
  ) {
    const taskStatus: CompositionTaskStatus =
      status === "completed"
        ? "completed"
        : status === "deadline_exceeded"
          ? "timed_out"
          : status === "cancelled"
            ? "cancelled"
            : status === "pivot_required"
              ? "blocked"
              : "failed";
    const errorCode = goalTerminalCode(status);
    const finishedAtUnixMs = now();
    return yield* options.store
      .withTransaction(
        Effect.gen(function* () {
          const [taskOption, runOption] = yield* Effect.all([
            options.store.getTask(input.taskId),
            options.store.getRun(input.runId),
          ]);
          if (Option.isNone(taskOption) || Option.isNone(runOption)) {
            return yield* runnerError(
              "goal_loop_parent_identity_conflict",
              "写入 Goal Loop 终态时父 Task/Run 不存在。",
              false,
            );
          }
          const existingResult = resultFromParent(runOption.value);
          if (existingResult !== undefined) return existingResult;
          const task: CompositionTask = {
            ...taskOption.value,
            status: taskStatus,
            updatedAtUnixMs: finishedAtUnixMs,
            finishedAtUnixMs,
          };
          const run: CompositionTaskRun = {
            ...runOption.value,
            status: taskStatus,
            finishedAtUnixMs,
            resultSummary: summary,
            ...(errorCode === undefined ? {} : { failureCode: errorCode }),
          };
          yield* options.store.upsertTask(task);
          yield* options.store.upsertRun(run);
          return {
            goalStatus: status,
            automationStatus: automationStatusFor(status),
            summary,
            ...(errorCode === undefined ? {} : { errorCode }),
          } satisfies CompositionGoalLoopAutomationRunResult;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isGoalLoopAutomationRunnerError(cause)
            ? cause
            : persistenceError("写入 Goal Loop 父终态", cause),
        ),
      );
  });

  const persistExecutionFailure = (
    input: CompositionGoalLoopAutomationRunInput,
    failure: CompositionGoalLoopAutomationRunnerError,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const finishedAtUnixMs = now();
      yield* options.store.appendEventIfNew({
        taskId: input.taskId,
        runId: input.runId,
        agentId: input.agentId,
        sourceEventId: `${goalLoopEventPrefix(input.taskId, input.runId)}:terminal:error:${failure.code}`,
        status: "failed",
        sequence: 0,
        eventType: "status",
        summary: `目标循环执行失败：${failure.code}`,
      });
      const [taskOption, runOption] = yield* Effect.all([
        options.store.getTask(input.taskId),
        options.store.getRun(input.runId),
      ]);
      if (Option.isNone(taskOption) || Option.isNone(runOption)) return;
      yield* options.store.upsertTask({
        ...taskOption.value,
        status: "failed",
        updatedAtUnixMs: finishedAtUnixMs,
        finishedAtUnixMs,
      });
      yield* options.store.upsertRun({
        ...runOption.value,
        status: "failed",
        finishedAtUnixMs,
        failureCode: failure.code,
        resultSummary: failure.detail,
      });
    }).pipe(Effect.ignore);

  const run: CompositionGoalLoopAutomationRunnerShape["run"] = Effect.fn(
    "CompositionGoalLoopAutomationRunner.run",
  )(function* (input) {
    const invalid = validateInput(input);
    if (invalid !== undefined) return yield* invalid;
    const persistedParent = yield* loadPersistedParent(input);
    if (persistedParent !== undefined && parentTerminalStatuses.has(persistedParent.run.status)) {
      const existing = resultFromParent(persistedParent.run);
      if (existing !== undefined) {
        yield* syncThreadGoalStatus(input, existing.goalStatus, options.threadGoalStore);
        return existing;
      }
      return yield* runnerError(
        "goal_loop_parent_terminal_unknown",
        `Goal Loop 父 Run 已终止，但无法识别终态：${persistedParent.run.status}/${persistedParent.run.failureCode ?? "none"}。`,
        false,
      );
    }
    const agent = yield* resolveAgent(input.agentId, "executor");
    if (input.reviewerAgentId !== undefined) {
      yield* resolveAgent(input.reviewerAgentId, "reviewer");
    }
    const parent = yield* ensureParent(input, agent);
    if (parentTerminalStatuses.has(parent.run.status)) {
      const existing = resultFromParent(parent.run);
      if (existing !== undefined) {
        yield* syncThreadGoalStatus(input, existing.goalStatus, options.threadGoalStore);
        return existing;
      }
      return yield* runnerError(
        "goal_loop_parent_terminal_unknown",
        `Goal Loop 父 Run 已终止，但无法识别终态：${parent.run.status}/${parent.run.failureCode ?? "none"}。`,
        false,
      );
    }

    const loop = runCompositionGoalLoopWithLedger<string, CompositionGoalLoopAutomationRunnerError>(
      {
        taskId: input.taskId,
        runId: input.runId,
        agentId: input.agentId,
        runtimeId: agent.runtimeId,
        store: options.store,
        maxAttempts: input.maxAttempts,
        ...(input.maxCostUnits === undefined ? {} : { maxCostUnits: input.maxCostUnits }),
        ...(input.stalePivotRounds === undefined
          ? {}
          : { stalePivotRounds: input.stalePivotRounds }),
        ...(input.deadlineDurationMs === undefined
          ? {}
          : { deadlineUnixMs: input.startedAtUnixMs + input.deadlineDurationMs }),
        now,
        ...(input.isCancelled === undefined ? {} : { isCancelled: input.isCancelled }),
        attempt: (round) =>
          runChild({
            parent: input,
            kind: "attempt",
            round,
            agentId: input.agentId,
            prompt: composeGoalLoopRoundPrompt(input.goal, round),
            capabilityIds: input.capabilityIds,
          }).pipe(Effect.map((output) => ({ value: output, outputText: output, costUnits: 1 }))),
        ...(input.reviewerAgentId === undefined
          ? {}
          : {
              validateCompletion: (claim) =>
                runChild({
                  parent: input,
                  kind: "review",
                  round: claim.round,
                  agentId: input.reviewerAgentId!,
                  prompt: composeGoalValidatorPrompt({ goal: input.goal, claim }),
                  capabilityIds: [],
                }).pipe(Effect.map(parseGoalValidatorVerdict)),
            }),
      },
    ).pipe(
      Effect.mapError((cause) =>
        isGoalLoopAutomationRunnerError(cause)
          ? cause
          : isPersistenceError(cause)
            ? persistenceError("写入 Goal Loop 台账", cause)
            : runnerError(
                taggedErrorCode(cause, "goal_loop_execution_failed"),
                errorDetail(cause),
                false,
              ),
      ),
    );
    const outcome = yield* Effect.result(loop);
    if (outcome._tag === "Failure") {
      yield* persistExecutionFailure(input, outcome.failure);
      return yield* outcome.failure;
    }
    const terminal = describeGoalLoopTerminal(outcome.success, (text) => {
      const trimmed = text.trim();
      return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
    });
    const result = yield* persistParentTerminal(input, outcome.success.status, terminal.summary);
    yield* syncThreadGoalStatus(input, result.goalStatus, options.threadGoalStore);
    return result;
  });

  return { run };
};

const live = Effect.gen(function* () {
  const orchestrator = yield* CompositionOrchestratorService;
  const runtime = yield* CompositionTaskRuntimeProjectionService;
  const store = yield* CompositionTaskStore;
  const threadGoalStore = yield* Effect.serviceOption(ThreadGoalStore);
  const drivers = yield* CompositionAgentDriverRegistryService;
  const agents: AgentResolver = {
    resolve: (agentId) =>
      drivers.get(agentId).pipe(
        Effect.map((driver) =>
          Option.fromNullishOr(driver).pipe(
            Option.map((resolved) => ({
              agentId: resolved.agentId,
              runtimeId: resolved.runtimeId,
            })),
          ),
        ),
      ),
  };
  return makeCompositionGoalLoopAutomationRunner({
    agents,
    orchestrator,
    runtime,
    store,
    ...(Option.isNone(threadGoalStore) ? {} : { threadGoalStore: threadGoalStore.value }),
  });
});

export const layer = Layer.effect(CompositionGoalLoopAutomationRunner, live);
