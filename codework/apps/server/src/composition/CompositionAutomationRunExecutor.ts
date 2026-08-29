import * as NodeCrypto from "node:crypto";

import type { CompositionTask, CompositionTaskRun } from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isPersistenceError } from "../persistence/Errors.ts";
import {
  CompositionAutomationStore,
  type CompositionAutomationStoreShape,
} from "../persistence/Services/CompositionAutomationStore.ts";
import {
  CompositionTaskStore,
  type CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import {
  CompositionAutomationBackgroundRunner,
  type CompositionAutomationBackgroundRunnerShape,
} from "./CompositionAutomationBackgroundRunner.ts";
import {
  CompositionAutomationExecutionContextResolver,
  type CompositionAutomationExecutionContextResolverShape,
} from "./CompositionAutomationExecutionContext.ts";
import {
  CompositionAutomationRunExecutor,
  CompositionAutomationRunExecutorError,
  type CompositionAutomationRunExecutionInput,
  type CompositionAutomationRunExecutorShape,
} from "./CompositionAutomationScheduler.ts";
import { classifyCompositionFailure } from "./CompositionFailurePolicy.ts";
import {
  CompositionGoalLoopAutomationRunner,
  type CompositionGoalLoopAutomationRunnerShape,
} from "./CompositionGoalLoopAutomationRunner.ts";
import {
  CompositionAgentDriverFailure,
  CompositionTaskAlreadyExistsError,
} from "./CompositionOrchestrator.ts";
import {
  CompositionOrchestratorService,
  type CompositionOrchestratorServiceShape,
} from "./CompositionOrchestratorService.ts";
import {
  CompositionSquadRunner,
  type CompositionSquadRunnerShape,
} from "./CompositionSquadRunner.ts";
import {
  CompositionTaskRuntimeProjectionService,
  type CompositionTaskRuntimeProjectionServiceShape,
} from "./CompositionTaskRuntimeProjectionService.ts";

type AgentAutomationRuntime = {
  readonly runtime: Pick<CompositionTaskRuntimeProjectionServiceShape, "awaitTaskCompletion">;
  readonly background: Pick<CompositionAutomationBackgroundRunnerShape, "ensure">;
  readonly runs: Pick<CompositionAutomationStoreShape, "saveRunTransition">;
  readonly now?: () => number;
};

type SquadAutomationRuntime = {
  readonly runner: Pick<CompositionSquadRunnerShape, "run">;
  readonly background: Pick<CompositionAutomationBackgroundRunnerShape, "ensure">;
  readonly runs: Pick<CompositionAutomationStoreShape, "saveRunTransition">;
  readonly now?: () => number;
};

type GoalLoopAutomationRuntime = {
  readonly runner: Pick<CompositionGoalLoopAutomationRunnerShape, "run">;
  readonly background: Pick<CompositionAutomationBackgroundRunnerShape, "ensure">;
  readonly runs: Pick<CompositionAutomationStoreShape, "saveRunTransition">;
  readonly now?: () => number;
};

const isTaskAlreadyExistsError = Schema.is(CompositionTaskAlreadyExistsError);
const isAgentDriverFailure = Schema.is(CompositionAgentDriverFailure);
const terminalFailureStatuses: ReadonlySet<CompositionTaskRun["status"]> = new Set([
  "failed",
  "cancelled",
  "timed_out",
]);
const observedAgentTerminalStatuses: ReadonlySet<CompositionTaskRun["status"]> = new Set([
  "in_review",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export interface CompositionAutomationRunExecutorOptions {
  readonly orchestrator: Pick<CompositionOrchestratorServiceShape, "dispatchTask">;
  readonly store: Pick<CompositionTaskStoreShape, "getTask" | "getRun">;
  readonly contexts: Pick<CompositionAutomationExecutionContextResolverShape, "resolve">;
  readonly agent?: AgentAutomationRuntime;
  readonly squad?: SquadAutomationRuntime;
  readonly goalLoop?: GoalLoopAutomationRuntime;
}

type AgentExecutionScope = {
  readonly taskId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly threadId?: string;
  readonly agentId: string;
  readonly promptDigest: string;
};

const sha256 = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

const executorError = (
  code: string,
  detail: string,
  retryable: boolean,
): CompositionAutomationRunExecutorError =>
  new CompositionAutomationRunExecutorError({ code, detail, retryable });

const errorDetail = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const matchesAgentExecution = (
  task: CompositionTask,
  run: CompositionTaskRun,
  scope: AgentExecutionScope,
): boolean =>
  task.taskId === scope.taskId &&
  task.projectId === scope.projectId &&
  task.threadId === scope.threadId &&
  task.assigneeKind === "agent" &&
  task.assigneeId === scope.agentId &&
  task.mode === "serial" &&
  task.promptDigest === scope.promptDigest &&
  task.dependsOnTaskIds.length === 0 &&
  run.runId === scope.runId &&
  run.taskId === scope.taskId &&
  run.agentId === scope.agentId &&
  run.attempt === 1;

const terminalRunError = (
  run: CompositionTaskRun,
): CompositionAutomationRunExecutorError | undefined => {
  if (!terminalFailureStatuses.has(run.status)) return undefined;
  const failure = classifyCompositionFailure(run);
  return executorError(
    failure.code,
    run.resultSummary ?? `Composition Run 以状态 ${run.status} 终止。`,
    failure.retryable,
  );
};

const dispatchError = (cause: unknown): CompositionAutomationRunExecutorError => {
  if (isAgentDriverFailure(cause)) {
    const failure = classifyCompositionFailure({ status: "failed", failureCode: cause.code });
    return executorError(cause.code, cause.detail, failure.retryable);
  }
  if (isPersistenceError(cause)) {
    return executorError("automation_composition_persistence_failed", errorDetail(cause), true);
  }
  return executorError("automation_agent_dispatch_failed", errorDetail(cause), false);
};

export const makeCompositionAutomationRunExecutor = (
  options: CompositionAutomationRunExecutorOptions,
): CompositionAutomationRunExecutorShape => {
  const inspectExisting = Effect.fn("CompositionAutomationRunExecutor.inspectExisting")(function* (
    scope: AgentExecutionScope,
  ) {
    const [task, run] = yield* Effect.all(
      [options.store.getTask(scope.taskId), options.store.getRun(scope.runId)],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.mapError((cause) =>
        executorError("automation_composition_lookup_failed", errorDetail(cause), true),
      ),
    );
    if (Option.isNone(task) && Option.isNone(run)) return undefined;
    if (
      Option.isNone(task) ||
      Option.isNone(run) ||
      !matchesAgentExecution(task.value, run.value, scope)
    ) {
      return yield* executorError(
        "automation_composition_identity_conflict",
        `Automation 稳定身份 ${scope.taskId}/${scope.runId} 与既有 Composition 记录冲突。`,
        false,
      );
    }
    return { task: task.value, run: run.value };
  });

  const ensureAgentObserved = Effect.fn("CompositionAutomationRunExecutor.ensureAgentObserved")(
    function* (
      input: CompositionAutomationRunExecutionInput,
      initialRun: CompositionTaskRun,
      runtime: AgentAutomationRuntime,
    ) {
      const taskId = input.run.compositionTaskId!;
      const runId = input.run.compositionRunId!;
      const work = Effect.gen(function* () {
        const outcome = yield* Effect.result(
          observedAgentTerminalStatuses.has(initialRun.status)
            ? Effect.succeed(initialRun)
            : runtime.runtime.awaitTaskCompletion({ taskId, runId }),
        );
        const finishedAtUnixMs = yield* runtime.now === undefined
          ? Clock.currentTimeMillis
          : Effect.sync(runtime.now);
        let run: CompositionAutomationRunExecutionInput["run"];
        if (outcome._tag === "Failure") {
          run = {
            ...input.run,
            status: "failed",
            finishedAtUnixMs,
            outputSummary: null,
            errorCode: "automation_agent_wait_failed",
            errorDetail: errorDetail(outcome.failure),
          };
        } else {
          const compositionRun = outcome.success;
          const summary =
            compositionRun.resultSummary?.trim() ||
            (compositionRun.status === "completed"
              ? "Agent Automation 执行完成。"
              : `Agent Composition Run 以状态 ${compositionRun.status} 终止。`);
          switch (compositionRun.status) {
            case "completed":
              run = {
                ...input.run,
                status: "succeeded",
                finishedAtUnixMs,
                outputSummary: summary,
                errorCode: null,
                errorDetail: null,
              };
              break;
            case "cancelled":
              run = {
                ...input.run,
                status: "cancelled",
                finishedAtUnixMs,
                outputSummary: summary,
                errorCode: compositionRun.failureCode ?? "automation_agent_cancelled",
                errorDetail: summary,
              };
              break;
            case "in_review":
              run = {
                ...input.run,
                status: "failed",
                finishedAtUnixMs,
                outputSummary: summary,
                errorCode: "automation_agent_review_required",
                errorDetail: summary,
              };
              break;
            case "failed":
            case "timed_out": {
              const failure = classifyCompositionFailure(compositionRun);
              run = {
                ...input.run,
                status: "failed",
                finishedAtUnixMs,
                outputSummary: compositionRun.resultSummary ?? null,
                errorCode: failure.code,
                errorDetail: summary,
              };
              break;
            }
            default:
              run = {
                ...input.run,
                status: "failed",
                finishedAtUnixMs,
                outputSummary: compositionRun.resultSummary ?? null,
                errorCode: "automation_agent_terminal_invalid",
                errorDetail: summary,
              };
          }
        }
        yield* runtime.runs.saveRunTransition({ run, expectedStatus: "running" }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Automation Agent 终态回写失败", {
              automationId: input.automation.automationId,
              automationRunId: input.run.automationRunId,
              cause,
            }),
          ),
        );
      });
      yield* runtime.background.ensure(input.run.automationRunId, work);
    },
  );

  const ensureAgentStarted = Effect.fn("CompositionAutomationRunExecutor.ensureAgentStarted")(
    function* (input: CompositionAutomationRunExecutionInput) {
      const target = input.automation.target;
      if (target.type !== "agent") {
        return yield* executorError(
          "automation_target_unsupported",
          `当前执行适配器尚不支持 ${target.type} target。`,
          false,
        );
      }
      const taskId = input.run.compositionTaskId;
      const runId = input.run.compositionRunId;
      if (taskId === null || runId === null) {
        return yield* executorError(
          "automation_composition_identity_missing",
          "Automation Run 尚未绑定稳定 Composition Task/Run ID。",
          false,
        );
      }
      const runtime = options.agent;
      if (runtime === undefined) {
        return yield* executorError(
          "automation_agent_runtime_unavailable",
          "Agent Automation 后台终态观察服务尚未就绪。",
          true,
        );
      }
      const context = yield* options.contexts
        .resolve({
          projectId: input.automation.projectId,
          executionContext: target.executionContext,
        })
        .pipe(Effect.mapError((cause) => executorError(cause.code, cause.detail, cause.retryable)));
      const scope: AgentExecutionScope = {
        taskId,
        runId,
        projectId: input.automation.projectId,
        ...(context.threadId === undefined ? {} : { threadId: context.threadId }),
        agentId: target.agentId,
        promptDigest: sha256(input.automation.prompt),
      };
      const existing = yield* inspectExisting(scope);
      if (existing !== undefined) {
        yield* ensureAgentObserved(input, existing.run, runtime);
        return;
      }

      const dispatched = yield* Effect.result(
        options.orchestrator.dispatchTask({
          taskId,
          runId,
          projectId: input.automation.projectId,
          ...(context.threadId === undefined ? {} : { threadId: context.threadId }),
          assigneeKind: "agent",
          assigneeId: target.agentId,
          mode: "serial",
          promptDigest: scope.promptDigest,
          dependsOnTaskIds: [],
          workspaceRoot: context.workspaceRoot,
          prompt: input.automation.prompt,
          ...(target.model === undefined ? {} : { model: target.model }),
          capabilityIds: [...target.capabilityIds],
        }),
      );
      if (dispatched._tag === "Failure") {
        if (isTaskAlreadyExistsError(dispatched.failure)) {
          const raced = yield* inspectExisting(scope);
          if (raced !== undefined) {
            yield* ensureAgentObserved(input, raced.run, runtime);
            return;
          }
        }
        return yield* dispatchError(dispatched.failure);
      }
      if (!matchesAgentExecution(dispatched.success.task, dispatched.success.run, scope)) {
        return yield* executorError(
          "automation_composition_identity_conflict",
          "Composition Orchestrator 返回的 Task/Run 与 Automation 稳定身份不一致。",
          false,
        );
      }
      const failure = terminalRunError(dispatched.success.run);
      if (failure !== undefined) return yield* failure;
      yield* ensureAgentObserved(input, dispatched.success.run, runtime);
    },
  );

  const ensureSquadStarted = Effect.fn("CompositionAutomationRunExecutor.ensureSquadStarted")(
    function* (input: CompositionAutomationRunExecutionInput) {
      const target = input.automation.target;
      if (target.type !== "squad") {
        return yield* executorError(
          "automation_target_unsupported",
          `当前执行适配器尚不支持 ${target.type} target。`,
          false,
        );
      }
      if (input.run.compositionTaskId === null || input.run.compositionRunId === null) {
        return yield* executorError(
          "automation_composition_identity_missing",
          "Automation Run 尚未绑定稳定 Composition Task/Run ID。",
          false,
        );
      }
      const runtime = options.squad;
      if (runtime === undefined) {
        return yield* executorError(
          "automation_squad_runtime_unavailable",
          "Squad Automation 后台执行服务尚未就绪。",
          true,
        );
      }
      const context = yield* options.contexts
        .resolve({
          projectId: input.automation.projectId,
          executionContext: target.executionContext,
        })
        .pipe(Effect.mapError((cause) => executorError(cause.code, cause.detail, cause.retryable)));
      const work = Effect.gen(function* () {
        const outcome = yield* Effect.result(
          runtime.runner.run({
            executionId: input.run.automationRunId,
            squadId: target.squadId,
            squadRevision: target.squadRevision,
            projectId: input.automation.projectId,
            ...(context.threadId === undefined ? {} : { threadId: context.threadId }),
            goal: input.automation.prompt,
            workspaceRoot: context.workspaceRoot,
          }),
        );
        const finishedAtUnixMs = yield* runtime.now === undefined
          ? Clock.currentTimeMillis
          : Effect.sync(runtime.now);
        const run =
          outcome._tag === "Success"
            ? {
                ...input.run,
                status: "succeeded" as const,
                finishedAtUnixMs,
                outputSummary:
                  outcome.success.graph.leader.run.resultSummary ?? "Squad Automation 执行完成。",
                errorCode: null,
                errorDetail: null,
              }
            : {
                ...input.run,
                status: "failed" as const,
                finishedAtUnixMs,
                outputSummary: null,
                errorCode: outcome.failure.code,
                errorDetail: outcome.failure.detail,
              };
        yield* runtime.runs.saveRunTransition({ run, expectedStatus: "running" }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Automation Squad 终态回写失败", {
              automationId: input.automation.automationId,
              automationRunId: input.run.automationRunId,
              cause,
            }),
          ),
        );
      });
      yield* runtime.background.ensure(input.run.automationRunId, work);
    },
  );

  const ensureGoalLoopStarted = Effect.fn(
    "CompositionAutomationRunExecutor.ensureGoalLoopStarted",
  )(function* (input: CompositionAutomationRunExecutionInput) {
    const target = input.automation.target;
    if (target.type !== "goal_loop") {
      return yield* executorError(
        "automation_target_unsupported",
        `当前执行适配器尚不支持 ${target.type} target。`,
        false,
      );
    }
    const taskId = input.run.compositionTaskId;
    const runId = input.run.compositionRunId;
    const startedAtUnixMs = input.run.startedAtUnixMs;
    if (taskId === null || runId === null) {
      return yield* executorError(
        "automation_composition_identity_missing",
        "Automation Run 尚未绑定稳定 Composition Task/Run ID。",
        false,
      );
    }
    if (startedAtUnixMs === null) {
      return yield* executorError(
        "automation_run_start_missing",
        "Goal Loop Automation Run 缺少 startedAtUnixMs。",
        false,
      );
    }
    const runtime = options.goalLoop;
    if (runtime === undefined) {
      return yield* executorError(
        "automation_goal_loop_runtime_unavailable",
        "Goal Loop Automation 后台执行服务尚未就绪。",
        true,
      );
    }
    const context = yield* options.contexts
      .resolve({
        projectId: input.automation.projectId,
        executionContext: target.executionContext,
      })
      .pipe(Effect.mapError((cause) => executorError(cause.code, cause.detail, cause.retryable)));
    const work = Effect.gen(function* () {
      const outcome = yield* Effect.result(
        runtime.runner.run({
          taskId,
          runId,
          projectId: input.automation.projectId,
          ...(context.threadId === undefined ? {} : { threadId: context.threadId }),
          agentId: target.agentId,
          ...(target.reviewerAgentId === undefined
            ? {}
            : { reviewerAgentId: target.reviewerAgentId }),
          ...(target.model === undefined ? {} : { model: target.model }),
          capabilityIds: [...target.capabilityIds],
          workspaceRoot: context.workspaceRoot,
          goal: input.automation.prompt,
          maxAttempts: target.maxAttempts,
          ...(target.maxCostUnits === undefined ? {} : { maxCostUnits: target.maxCostUnits }),
          ...(target.stalePivotRounds === undefined
            ? {}
            : { stalePivotRounds: target.stalePivotRounds }),
          ...(target.deadlineDurationMs === undefined
            ? {}
            : { deadlineDurationMs: target.deadlineDurationMs }),
          startedAtUnixMs,
        }),
      );
      const finishedAtUnixMs = yield* runtime.now === undefined
        ? Clock.currentTimeMillis
        : Effect.sync(runtime.now);
      const run =
        outcome._tag === "Failure"
          ? {
              ...input.run,
              status: "failed" as const,
              finishedAtUnixMs,
              outputSummary: null,
              errorCode: outcome.failure.code,
              errorDetail: outcome.failure.detail,
            }
          : {
              ...input.run,
              status: outcome.success.automationStatus,
              finishedAtUnixMs,
              outputSummary: outcome.success.summary,
              errorCode:
                outcome.success.automationStatus === "succeeded"
                  ? null
                  : (outcome.success.errorCode ?? "goal_loop_execution_failed"),
              errorDetail:
                outcome.success.automationStatus === "succeeded"
                  ? null
                  : outcome.success.summary,
            };
      yield* runtime.runs.saveRunTransition({ run, expectedStatus: "running" }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Automation Goal Loop 终态回写失败", {
            automationId: input.automation.automationId,
            automationRunId: input.run.automationRunId,
            cause,
          }),
        ),
      );
    });
    yield* runtime.background.ensure(input.run.automationRunId, work);
  });

  const ensureStarted: CompositionAutomationRunExecutorShape["ensureStarted"] = (input) => {
    switch (input.automation.target.type) {
      case "agent":
        return ensureAgentStarted(input);
      case "squad":
        return ensureSquadStarted(input);
      case "goal_loop":
        return ensureGoalLoopStarted(input);
    }
  };

  return { ensureStarted };
};

const live = Effect.gen(function* () {
  const orchestrator = yield* CompositionOrchestratorService;
  const store = yield* CompositionTaskStore;
  const contexts = yield* CompositionAutomationExecutionContextResolver;
  const taskRuntime = yield* CompositionTaskRuntimeProjectionService;
  const squadRunner = yield* CompositionSquadRunner;
  const goalLoopRunner = yield* CompositionGoalLoopAutomationRunner;
  const background = yield* CompositionAutomationBackgroundRunner;
  const automationStore = yield* CompositionAutomationStore;
  return makeCompositionAutomationRunExecutor({
    orchestrator,
    store,
    contexts,
    agent: { runtime: taskRuntime, background, runs: automationStore },
    squad: { runner: squadRunner, background, runs: automationStore },
    goalLoop: { runner: goalLoopRunner, background, runs: automationStore },
  });
});

export const layer = Layer.effect(CompositionAutomationRunExecutor, live);
