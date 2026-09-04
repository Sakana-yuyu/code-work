import type {
  CompositionTaskRun,
  SpecWorkflowCapability,
  SpecWorkflowControlInput,
  SpecWorkflowDispatchInput,
  SpecWorkflowDispatchResult,
  SpecWorkflowLoopConfig,
  SpecWorkflowProposalReviewInput,
  SpecWorkflowStartInput,
  SpecWorkflowState,
  SpecWorkflowStateEvent,
} from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Stream from "effect/Stream";

import {
  SpecWorkflowCapabilityStore,
  type SpecWorkflowCapabilityStoreError,
} from "../persistence/Services/SpecWorkflowCapabilityStore.ts";
import {
  SpecWorkflowArtifactStore,
  SpecWorkflowArtifactStoreError,
} from "./SpecWorkflowArtifactStore.ts";
import {
  CompositionTaskInputStore,
  type CompositionTaskInputStoreError,
  type CompositionTaskRecoveryInput,
} from "../persistence/Services/CompositionTaskInputStore.ts";
import {
  SpecWorkflowStateStore,
  SpecWorkflowStateStoreDomainError,
  type SpecWorkflowStateStoreError,
} from "../persistence/Services/SpecWorkflowStateStore.ts";
import { CompositionOrchestratorService } from "../composition/CompositionOrchestratorService.ts";
import {
  CompositionGoalLoopAutomationRunner,
  type CompositionGoalLoopAutomationRunResult,
} from "../composition/CompositionGoalLoopAutomationRunner.ts";
import { CompositionTaskRuntimeProjectionService } from "../composition/CompositionTaskRuntimeProjectionService.ts";
import {
  SpecWorkflowCompositionBridgeError,
  dispatchSpecWorkflowStage,
  prepareSpecWorkflowLoop,
  transitionSpecWorkflowControl,
} from "./SpecWorkflowCompositionBridge.ts";
import {
  SpecWorkflowTransitionError,
  startSpecWorkflow,
  transitionSpecWorkflowState,
} from "./SpecWorkflowDecider.ts";
import {
  reactSpecWorkflowTaskCompletion,
  type SpecWorkflowStageHandoff,
} from "./SpecWorkflowReactor.ts";
import { routeSpecWorkflowIntent } from "./SpecWorkflowRouter.ts";

export interface SpecWorkflowServiceShape {
  readonly recover: () => Effect.Effect<SpecWorkflowRecoveryReceipt, SpecWorkflowServiceError>;
  readonly getState: (
    threadId: string,
  ) => Effect.Effect<Option.Option<SpecWorkflowState>, SpecWorkflowStateStoreError>;
  readonly start: (
    input: SpecWorkflowStartInput,
  ) => Effect.Effect<SpecWorkflowState, SpecWorkflowServiceError>;
  readonly dispatch: (
    input: SpecWorkflowDispatchInput,
  ) => Effect.Effect<SpecWorkflowDispatchResult, SpecWorkflowServiceError>;
  readonly reviewProposal: (
    input: SpecWorkflowProposalReviewInput,
  ) => Effect.Effect<SpecWorkflowState, SpecWorkflowServiceError>;
  readonly completeAcceptance: (
    input: SpecWorkflowControlInput,
  ) => Effect.Effect<SpecWorkflowState, SpecWorkflowServiceError>;
  readonly pause: (
    input: SpecWorkflowControlInput,
  ) => Effect.Effect<SpecWorkflowState, SpecWorkflowServiceError>;
  readonly resume: (
    input: SpecWorkflowControlInput,
  ) => Effect.Effect<SpecWorkflowState, SpecWorkflowServiceError>;
  readonly subscribe: (
    threadId: string,
  ) => Effect.Effect<Stream.Stream<SpecWorkflowStateEvent>, never>;
}

export type SpecWorkflowServiceError =
  | SpecWorkflowCapabilityStoreError
  | SpecWorkflowStateStoreError
  | SpecWorkflowCompositionBridgeError
  | SpecWorkflowTransitionError
  | CompositionTaskInputStoreError
  | SpecWorkflowArtifactStoreError
  | Effect.Error<ReturnType<typeof dispatchSpecWorkflowStage>>;

export type SpecWorkflowRecoveryReceipt = {
  readonly scanned: number;
  readonly rebound: number;
  readonly settled: number;
  readonly skipped: number;
};

type TerminalTaskStatus = "completed" | "failed" | "cancelled" | "timed_out";
const terminalTaskStatuses: ReadonlySet<TerminalTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);
const isTerminalTaskStatus = (status: CompositionTaskRun["status"]): status is TerminalTaskStatus =>
  terminalTaskStatuses.has(status as TerminalTaskStatus);

export class SpecWorkflowService extends Context.Service<
  SpecWorkflowService,
  SpecWorkflowServiceShape
>()("codework/specWorkflow/SpecWorkflowService") {}

const workflowIdentityMatches = (
  state: SpecWorkflowState,
  input: Pick<
    SpecWorkflowDispatchInput,
    "workflowId" | "projectId" | "threadId" | "changeName" | "mode"
  >,
): boolean =>
  state.workflowId === input.workflowId &&
  state.projectId === input.projectId &&
  state.threadId === input.threadId &&
  state.changeName === input.changeName &&
  state.mode === input.mode;

const identityError = (input: { readonly threadId: string; readonly workflowId: string }) =>
  new SpecWorkflowCompositionBridgeError({
    code: "identity-conflict",
    detail: "请求的 workflow、project、thread 或 change 身份与现有状态不一致。",
    workflowId: input.workflowId,
  });

export const layer = Layer.effect(
  SpecWorkflowService,
  Effect.gen(function* () {
    const capabilities = yield* SpecWorkflowCapabilityStore;
    const states = yield* SpecWorkflowStateStore;
    const composition = yield* CompositionOrchestratorService;
    const runtime = yield* CompositionTaskRuntimeProjectionService;
    const completionWatchers = new Set<string>();
    const activeLoops = new Map<string, { cancelled: boolean }>();
    const loopRunner = yield* Effect.serviceOption(CompositionGoalLoopAutomationRunner);
    const taskInputs = yield* Effect.serviceOption(CompositionTaskInputStore);
    const artifacts = yield* Effect.serviceOption(SpecWorkflowArtifactStore);

    const requireEnabled = (capability: SpecWorkflowCapability, workflowId: string) =>
      capability.enabled
        ? Effect.succeed(capability)
        : Effect.fail(
            new SpecWorkflowCompositionBridgeError({
              code: "not-enabled",
              detail: "Spec Workflow 能力未显式启用，不能创建或推进工作流。",
              workflowId,
            }),
          );

    const getState: SpecWorkflowServiceShape["getState"] = (threadId) => states.get(threadId);

    const settleTaskStatus = (input: {
      readonly threadId: string;
      readonly taskId: string;
      readonly status: "completed" | "failed" | "cancelled" | "timed_out";
      readonly error?: string;
    }): Effect.Effect<Option.Option<SpecWorkflowState>, SpecWorkflowServiceError> =>
      Effect.gen(function* () {
        const current = yield* states.get(input.threadId);
        if (Option.isNone(current)) {
          yield* Effect.logWarning("Spec Workflow Task 回写跳过：workflow 不存在", {
            threadId: input.threadId,
            taskId: input.taskId,
          });
          return Option.none();
        }
        if (current.value.activeTaskId !== input.taskId) return Option.none();
        const error =
          input.status === "completed"
            ? undefined
            : (input.error ??
              (input.status === "cancelled"
                ? "Composition Task 已取消。"
                : input.status === "timed_out"
                  ? "Composition Task 执行超时。"
                  : "Composition Task 执行失败。"));
        const event = transitionSpecWorkflowState(
          current.value,
          {
            type: "record-task-result",
            taskId: input.taskId,
            status: input.status,
            ...(error === undefined ? {} : { error }),
            expectedRevision: current.value.revision,
          },
          yield* Clock.currentTimeMillis,
        );
        const saved = yield* states.append({
          threadId: input.threadId,
          event,
          expectedRevision: current.value.revision,
        });
        return Option.some(saved);
      });

    const settleTaskResult = (input: {
      readonly threadId: string;
      readonly taskId: string;
      readonly run: CompositionTaskRun;
    }): Effect.Effect<Option.Option<SpecWorkflowState>, SpecWorkflowServiceError> => {
      if (!isTerminalTaskStatus(input.run.status)) {
        return Effect.logWarning("Spec Workflow Task 回写跳过：Runtime 返回了非终态", {
          threadId: input.threadId,
          taskId: input.taskId,
          status: input.run.status,
        }).pipe(Effect.as(Option.none()));
      }
      const error =
        input.run.status === "completed"
          ? undefined
          : input.run.status === "failed"
            ? `Composition Task 执行失败：${input.run.failureCode ?? "unknown"}`
            : input.run.status === "cancelled"
              ? "Composition Task 已取消。"
              : "Composition Task 执行超时。";
      return settleTaskStatus({
        threadId: input.threadId,
        taskId: input.taskId,
        status: input.run.status,
        ...(error === undefined ? {} : { error }),
      });
    };

    const reactTaskCompletion = (input: {
      readonly state: SpecWorkflowState;
      readonly completedStage: "apply" | "verify";
      readonly run: CompositionTaskRun;
      readonly handoff?: SpecWorkflowStageHandoff;
    }): Effect.Effect<void, SpecWorkflowServiceError> =>
      Effect.gen(function* () {
        const capability = yield* capabilities.get(input.state.threadId);
        if (!capability.enabled) {
          yield* Effect.logInfo("Spec Workflow Reactor 因能力已关闭而跳过后续唤醒", {
            workflowId: input.state.workflowId,
            taskId: input.run.taskId,
          });
          return;
        }
        const reaction = reactSpecWorkflowTaskCompletion(input);
        switch (reaction.type) {
          case "none":
            if (reaction.reason === "independent-verifier-required") {
              yield* Effect.logWarning(
                "Spec Workflow 未自动唤醒 verify：缺少独立验证者或阶段输入。",
                {
                  workflowId: input.state.workflowId,
                  taskId: input.run.taskId,
                },
              );
            }
            return;
          case "advance-acceptance": {
            const event = transitionSpecWorkflowState(
              input.state,
              {
                type: "advance",
                to: "acceptance",
                expectedRevision: input.state.revision,
              },
              yield* Clock.currentTimeMillis,
            );
            yield* states.append({
              threadId: input.state.threadId,
              event,
              expectedRevision: input.state.revision,
            });
            return;
          }
          case "dispatch":
            yield* dispatch({ ...reaction.input, intent: reaction.intent });
            return;
        }
      });

    const stageHandoffFromRecovery = (
      state: SpecWorkflowState,
      run: CompositionTaskRun,
      input: CompositionTaskRecoveryInput,
    ): SpecWorkflowStageHandoff | undefined =>
      input.promptDigest === undefined
        ? undefined
        : {
            workflowId: state.workflowId,
            projectId: state.projectId,
            threadId: state.threadId,
            changeName: state.changeName,
            mode: state.mode,
            workspaceRoot: input.workspaceRoot,
            assigneeId: run.agentId,
            prompt: input.prompt,
            promptDigest: input.promptDigest,
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.capabilityIds === undefined ? {} : { capabilityIds: input.capabilityIds }),
            ...(input.implementationAssigneeId === undefined
              ? {}
              : { implementationAssigneeId: input.implementationAssigneeId }),
            ...(input.independentVerifierId === undefined
              ? {}
              : { independentVerifierId: input.independentVerifierId }),
          };

    const watchTaskCompletion = (input: {
      readonly threadId: string;
      readonly taskId: string;
      readonly runId: string;
      readonly completedStage: "apply" | "verify";
      readonly handoff?: SpecWorkflowStageHandoff;
    }): Effect.Effect<boolean, never> =>
      Effect.gen(function* () {
        const key = `${input.taskId}:${input.runId}`;
        if (completionWatchers.has(key)) return false;
        completionWatchers.add(key);
        yield* Effect.forkDetach(
          runtime.awaitTaskCompletion({ taskId: input.taskId, runId: input.runId }).pipe(
            Effect.flatMap((run) =>
              Effect.gen(function* () {
                const settled = yield* settleTaskResult({
                  threadId: input.threadId,
                  taskId: input.taskId,
                  run,
                });
                if (Option.isSome(settled)) {
                  yield* reactTaskCompletion({
                    state: settled.value,
                    completedStage: input.completedStage,
                    run,
                    ...(input.handoff === undefined ? {} : { handoff: input.handoff }),
                  });
                }
                return settled;
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logError("Spec Workflow Task 终态等待失败", {
                threadId: input.threadId,
                taskId: input.taskId,
                runId: input.runId,
                cause,
              }),
            ),
            Effect.ensuring(Effect.sync(() => completionWatchers.delete(key))),
          ),
        );
        return true;
      });

    const loopTaskStatus = (
      result: CompositionGoalLoopAutomationRunResult,
    ): "completed" | "failed" | "cancelled" | "timed_out" =>
      result.goalStatus === "completed"
        ? "completed"
        : result.goalStatus === "cancelled"
          ? "cancelled"
          : result.goalStatus === "deadline_exceeded"
            ? "timed_out"
            : "failed";

    const launchLoop = (input: {
      readonly state: SpecWorkflowState;
      readonly taskId: string;
      readonly runId: string;
      readonly agentId: string;
      readonly reviewerAgentId?: string;
      readonly prompt: string;
      readonly workspaceRoot: string;
      readonly model?: string;
      readonly capabilityIds?: ReadonlyArray<string>;
      readonly loopConfig: SpecWorkflowLoopConfig;
      readonly startedAtUnixMs: number;
      readonly cancellation?: { cancelled: boolean };
    }) =>
      Effect.gen(function* () {
        if (Option.isNone(loopRunner) || Option.isNone(taskInputs)) return false;
        if (activeLoops.has(input.taskId)) return false;
        const cancellation = input.cancellation ?? { cancelled: false };
        activeLoops.set(input.taskId, cancellation);
        yield* Effect.forkDetach(
          Effect.gen(function* () {
            const outcome = yield* Effect.result(
              loopRunner.value.run({
                taskId: input.taskId,
                runId: input.runId,
                projectId: input.state.projectId,
                threadId: input.state.threadId,
                agentId: input.agentId,
                ...(input.reviewerAgentId === undefined
                  ? {}
                  : { reviewerAgentId: input.reviewerAgentId }),
                ...(input.model === undefined ? {} : { model: input.model }),
                capabilityIds: [...(input.capabilityIds ?? [])],
                workspaceRoot: input.workspaceRoot,
                goal: input.prompt,
                maxAttempts: input.loopConfig.maxAttempts,
                ...(input.loopConfig.maxCostUnits === undefined
                  ? {}
                  : { maxCostUnits: input.loopConfig.maxCostUnits }),
                ...(input.loopConfig.stalePivotRounds === undefined
                  ? {}
                  : { stalePivotRounds: input.loopConfig.stalePivotRounds }),
                ...(input.loopConfig.deadlineDurationMs === undefined
                  ? {}
                  : { deadlineDurationMs: input.loopConfig.deadlineDurationMs }),
                isCancelled: () => cancellation.cancelled,
                startedAtUnixMs: input.startedAtUnixMs,
              }),
            );
            if (outcome._tag === "Success") {
              yield* settleTaskStatus({
                threadId: input.state.threadId,
                taskId: input.taskId,
                status: loopTaskStatus(outcome.success),
                ...(outcome.success.automationStatus === "succeeded"
                  ? {}
                  : { error: outcome.success.summary }),
              });
            } else {
              yield* settleTaskStatus({
                threadId: input.state.threadId,
                taskId: input.taskId,
                status: "failed",
                error: `${outcome.failure.code}: ${outcome.failure.detail}`,
              });
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Spec Workflow Goal Loop 终态回写失败", {
                workflowId: input.state.workflowId,
                taskId: input.taskId,
                runId: input.runId,
                cause,
              }),
            ),
            Effect.ensuring(Effect.sync(() => activeLoops.delete(input.taskId))),
          ),
        );
        return true;
      });

    const recover: SpecWorkflowServiceShape["recover"] = () =>
      Effect.gen(function* () {
        const persistedStates = yield* states.listStates();
        let scanned = 0;
        let rebound = 0;
        let settled = 0;
        let skipped = 0;

        for (const state of persistedStates) {
          if (state.activeTaskId === null) continue;
          scanned += 1;

          const capability = yield* capabilities.get(state.threadId);
          if (!capability.enabled) {
            skipped += 1;
            yield* Effect.logWarning("Spec Workflow 启动恢复跳过：能力未启用", {
              workflowId: state.workflowId,
              threadId: state.threadId,
              taskId: state.activeTaskId,
            });
            continue;
          }

          const loopConfig = state.loopConfig;
          const snapshots = yield* composition.listTaskSnapshots(state.projectId);
          const snapshot = snapshots.find(
            (candidate) => candidate.task.taskId === state.activeTaskId,
          );
          if (snapshot === undefined) {
            if (
              loopConfig !== undefined &&
              loopConfig !== null &&
              state.status !== "paused" &&
              Option.isSome(loopRunner) &&
              Option.isSome(taskInputs)
            ) {
              const recoveryInput = yield* taskInputs.value.get(state.activeTaskId);
              if (Option.isSome(recoveryInput) && recoveryInput.value.agentId !== undefined) {
                const started = yield* launchLoop({
                  state,
                  taskId: state.activeTaskId,
                  runId: `${state.activeTaskId}:run`,
                  agentId: recoveryInput.value.agentId,
                  ...(loopConfig.reviewerAgentId === undefined
                    ? {}
                    : { reviewerAgentId: loopConfig.reviewerAgentId }),
                  prompt: recoveryInput.value.prompt,
                  workspaceRoot: recoveryInput.value.workspaceRoot,
                  ...(recoveryInput.value.model === undefined
                    ? {}
                    : { model: recoveryInput.value.model }),
                  ...(recoveryInput.value.capabilityIds === undefined
                    ? {}
                    : { capabilityIds: recoveryInput.value.capabilityIds }),
                  loopConfig,
                  startedAtUnixMs: state.updatedAt,
                });
                if (started) {
                  rebound += 1;
                } else {
                  skipped += 1;
                }
                continue;
              }
            }
            skipped += 1;
            yield* Effect.logWarning("Spec Workflow 启动恢复跳过：active Task 不存在", {
              workflowId: state.workflowId,
              threadId: state.threadId,
              taskId: state.activeTaskId,
            });
            continue;
          }
          if (
            snapshot.task.projectId !== state.projectId ||
            snapshot.task.threadId !== state.threadId
          ) {
            skipped += 1;
            yield* Effect.logWarning("Spec Workflow 启动恢复跳过：Task 身份不一致", {
              workflowId: state.workflowId,
              threadId: state.threadId,
              taskId: state.activeTaskId,
              taskProjectId: snapshot.task.projectId,
              taskThreadId: snapshot.task.threadId,
            });
            continue;
          }
          const run = snapshot.latestRun;
          if (run === undefined || run.taskId !== state.activeTaskId) {
            skipped += 1;
            yield* Effect.logWarning("Spec Workflow 启动恢复跳过：active Task 缺少匹配 Run", {
              workflowId: state.workflowId,
              threadId: state.threadId,
              taskId: state.activeTaskId,
            });
            continue;
          }

          if (loopConfig !== undefined && loopConfig !== null) {
            if (isTerminalTaskStatus(run.status)) {
              const settledState = yield* settleTaskResult({
                threadId: state.threadId,
                taskId: state.activeTaskId,
                run,
              });
              if (Option.isSome(settledState)) {
                settled += 1;
              } else {
                skipped += 1;
              }
              continue;
            }
            if (
              state.status === "paused" ||
              Option.isNone(loopRunner) ||
              Option.isNone(taskInputs)
            ) {
              skipped += 1;
              continue;
            }
            const recoveryInput = yield* taskInputs.value.get(state.activeTaskId);
            if (Option.isNone(recoveryInput)) {
              skipped += 1;
              yield* Effect.logWarning("Spec Workflow Loop 恢复跳过：缺少加密输入", {
                workflowId: state.workflowId,
                taskId: state.activeTaskId,
              });
              continue;
            }
            if (
              yield* launchLoop({
                state,
                taskId: state.activeTaskId,
                runId: run.runId,
                agentId: run.agentId,
                ...(loopConfig.reviewerAgentId === undefined
                  ? {}
                  : { reviewerAgentId: loopConfig.reviewerAgentId }),
                prompt: recoveryInput.value.prompt,
                workspaceRoot: recoveryInput.value.workspaceRoot,
                ...(recoveryInput.value.model === undefined
                  ? {}
                  : { model: recoveryInput.value.model }),
                ...(recoveryInput.value.capabilityIds === undefined
                  ? {}
                  : { capabilityIds: recoveryInput.value.capabilityIds }),
                loopConfig,
                startedAtUnixMs: state.updatedAt,
              })
            ) {
              rebound += 1;
            } else {
              skipped += 1;
            }
            continue;
          }

          if (isTerminalTaskStatus(run.status)) {
            const recoveryInput = Option.isSome(taskInputs)
              ? yield* taskInputs.value.get(state.activeTaskId)
              : Option.none<CompositionTaskRecoveryInput>();
            const settledState = yield* settleTaskResult({
              threadId: state.threadId,
              taskId: state.activeTaskId,
              run,
            });
            if (Option.isSome(settledState)) {
              settled += 1;
              yield* reactTaskCompletion({
                state: settledState.value,
                completedStage: state.stage === "verify" ? "verify" : "apply",
                run,
                ...(Option.isSome(recoveryInput)
                  ? (() => {
                      const handoff = stageHandoffFromRecovery(state, run, recoveryInput.value);
                      return handoff === undefined ? {} : { handoff };
                    })()
                  : {}),
              });
            } else {
              skipped += 1;
            }
            continue;
          }

          if (state.stage !== "apply" && state.stage !== "verify") {
            skipped += 1;
            continue;
          }
          const recoveryInput = Option.isSome(taskInputs)
            ? yield* taskInputs.value.get(state.activeTaskId)
            : Option.none<CompositionTaskRecoveryInput>();
          const handoff = Option.isSome(recoveryInput)
            ? stageHandoffFromRecovery(state, run, recoveryInput.value)
            : undefined;

          if (
            yield* watchTaskCompletion({
              threadId: state.threadId,
              taskId: state.activeTaskId,
              runId: run.runId,
              completedStage: state.stage,
              ...(handoff === undefined ? {} : { handoff }),
            })
          ) {
            rebound += 1;
          }
        }

        return { scanned, rebound, settled, skipped } satisfies SpecWorkflowRecoveryReceipt;
      });

    const start: SpecWorkflowServiceShape["start"] = (input) =>
      Effect.gen(function* () {
        const capability = yield* capabilities.get(input.threadId);
        yield* requireEnabled(capability, input.workflowId);
        const existing = yield* states.get(input.threadId);
        if (Option.isSome(existing)) {
          if (!workflowIdentityMatches(existing.value, input)) {
            return yield* identityError(input);
          }
          return existing.value;
        }

        const now = yield* Clock.currentTimeMillis;
        const event = startSpecWorkflow({ ...input, updatedAt: now });
        return yield* states.append({
          threadId: input.threadId,
          event,
          expectedRevision: 0,
        });
      });

    const requireFixBatchArtifact = (state: SpecWorkflowState, input: SpecWorkflowDispatchInput) =>
      Effect.gen(function* () {
        if (
          state.mode !== "fix" ||
          (input.intent !== "fix" && input.intent !== "ship" && input.intent !== "archive")
        ) {
          return;
        }
        if (Option.isNone(artifacts)) {
          return yield* new SpecWorkflowCompositionBridgeError({
            code: "composition-unavailable",
            detail: "轻量修复批次产物存储尚未就绪，不能执行 fix/ship/archive。",
            workflowId: state.workflowId,
          });
        }
        const artifact = yield* artifacts.value
          .read({
            workspaceRoot: input.workspaceRoot,
            changeName: state.changeName,
            artifact: "fix.md",
          })
          .pipe(
            Effect.catchTag("SpecWorkflowArtifactStoreError", (error) =>
              error.code === "artifact-not-found" ? Effect.succeed(null) : Effect.fail(error),
            ),
          );
        if (artifact === null || artifact.contents.trim().length === 0) {
          return yield* new SpecWorkflowCompositionBridgeError({
            code: "stage-not-dispatchable",
            detail: "轻量修复批次为空，必须先在 fix.md 中记录至少一项实际修复后才能继续。",
            workflowId: state.workflowId,
          });
        }
      });

    function dispatch(
      input: SpecWorkflowDispatchInput,
    ): Effect.Effect<SpecWorkflowDispatchResult, SpecWorkflowServiceError> {
      return Effect.gen(function* () {
        const capability = yield* capabilities.get(input.threadId);
        yield* requireEnabled(capability, input.workflowId);
        const current = yield* states.get(input.threadId);
        if (Option.isNone(current)) {
          const state = yield* start({
            workflowId: input.workflowId,
            projectId: input.projectId,
            threadId: input.threadId,
            changeName: input.changeName,
            mode: input.mode,
            updatedAt: 0,
          });
          if (input.mode === "fix" && input.intent === "fix") {
            return yield* dispatch(input);
          }
          return {
            route: routeSpecWorkflowIntent({ capability, intent: input.intent }),
            state,
            stateEvent: {
              type: "started" as const,
              state,
            },
            task: null,
          };
        }

        const state = current.value;
        if (!workflowIdentityMatches(state, input)) {
          return yield* identityError(input);
        }
        const route = routeSpecWorkflowIntent({
          capability,
          state,
          intent: input.intent,
          ...(input.loopConfig === undefined ? {} : { loopConfig: input.loopConfig }),
        });
        const now = yield* Clock.currentTimeMillis;

        if (route.action === "advance" && (input.intent === "ship" || input.intent === "archive")) {
          yield* requireFixBatchArtifact(state, input);
        }

        if (route.action === "show-status") {
          return { route, state, stateEvent: null, task: null };
        }
        if (input.intent === "loop") {
          if (input.loopConfig === undefined) {
            return yield* new SpecWorkflowCompositionBridgeError({
              code: "composition-unavailable",
              detail: "受控自主迭代必须提供正整数 maxAttempts 预算。",
              workflowId: state.workflowId,
            });
          }
          if (Option.isNone(loopRunner) || Option.isNone(taskInputs)) {
            return yield* new SpecWorkflowCompositionBridgeError({
              code: "composition-unavailable",
              detail: "Goal Loop Runner 或加密任务输入存储尚未就绪。",
              workflowId: state.workflowId,
            });
          }
          const prepared = yield* prepareSpecWorkflowLoop({
            capability,
            state,
            intent: input.intent,
            loopConfig: input.loopConfig,
            now,
            projectId: input.projectId,
            threadId: input.threadId,
          });
          yield* taskInputs.value.save({
            taskId: prepared.taskId,
            agentId: input.assigneeId,
            prompt: input.prompt,
            workspaceRoot: input.workspaceRoot,
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.capabilityIds === undefined ? {} : { capabilityIds: input.capabilityIds }),
          });
          const saved = yield* states.append({
            threadId: input.threadId,
            event: prepared.stateEvent,
            expectedRevision: state.revision,
          });
          const reviewerAgentId = input.loopConfig.reviewerAgentId ?? input.independentVerifierId;
          yield* launchLoop({
            state: saved,
            taskId: prepared.taskId,
            runId: prepared.runId,
            agentId: input.assigneeId,
            ...(reviewerAgentId === undefined ? {} : { reviewerAgentId }),
            prompt: input.prompt,
            workspaceRoot: input.workspaceRoot,
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.capabilityIds === undefined ? {} : { capabilityIds: input.capabilityIds }),
            loopConfig: input.loopConfig,
            startedAtUnixMs: now,
          });
          return {
            route: prepared.route,
            state: saved,
            stateEvent: prepared.stateEvent,
            task: null,
          };
        }
        if (route.action === "pause" || route.action === "resume") {
          const event = yield* transitionSpecWorkflowControl({
            capability,
            state,
            command: {
              type: route.action,
              expectedRevision: state.revision,
            },
            now,
          });
          if (route.action === "pause" && state.activeTaskId !== null) {
            const cancellation = activeLoops.get(state.activeTaskId);
            if (cancellation !== undefined) cancellation.cancelled = true;
          }
          const saved = yield* states.append({
            threadId: input.threadId,
            event: event.event,
            expectedRevision: state.revision,
          });
          return { route, state: saved, stateEvent: event.event, task: null };
        }
        if (route.action !== "advance" || route.targetStage === null) {
          return yield* new SpecWorkflowCompositionBridgeError({
            code: "stage-not-dispatchable",
            detail: `当前路由 ${route.action} 不产生可执行的工作流状态事件。`,
            workflowId: state.workflowId,
          });
        }

        if (route.targetStage === "apply" || route.targetStage === "verify") {
          const stageAssigneeId =
            route.targetStage === "verify" && input.independentVerifierId !== undefined
              ? input.independentVerifierId
              : input.assigneeId;
          const dispatched = yield* dispatchSpecWorkflowStage(composition, {
            capability,
            state,
            intent: input.intent,
            now,
            projectId: input.projectId,
            threadId: input.threadId,
            workspaceRoot: input.workspaceRoot,
            assigneeId: stageAssigneeId,
            prompt: input.prompt,
            promptDigest: input.promptDigest,
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.capabilityIds === undefined ? {} : { capabilityIds: input.capabilityIds }),
            ...(input.implementationAssigneeId === undefined
              ? {}
              : { implementationAssigneeId: input.implementationAssigneeId }),
            ...(input.independentVerifierId === undefined
              ? {}
              : { independentVerifierId: input.independentVerifierId }),
          });
          const saved = yield* states.append({
            threadId: input.threadId,
            event: dispatched.stateEvent,
            expectedRevision: state.revision,
          });
          const handoff: SpecWorkflowStageHandoff = {
            workflowId: input.workflowId,
            projectId: input.projectId,
            threadId: input.threadId,
            changeName: input.changeName,
            mode: input.mode,
            workspaceRoot: input.workspaceRoot,
            assigneeId: stageAssigneeId,
            prompt: input.prompt,
            promptDigest: input.promptDigest,
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.capabilityIds === undefined ? {} : { capabilityIds: input.capabilityIds }),
            implementationAssigneeId:
              input.implementationAssigneeId ??
              (route.targetStage === "apply" ? input.assigneeId : undefined),
            ...(input.independentVerifierId === undefined
              ? {}
              : { independentVerifierId: input.independentVerifierId }),
          };
          if (Option.isSome(taskInputs)) {
            yield* taskInputs.value.save({
              taskId: dispatched.task.taskId,
              agentId: stageAssigneeId,
              prompt: input.prompt,
              promptDigest: input.promptDigest,
              workspaceRoot: input.workspaceRoot,
              ...(input.model === undefined ? {} : { model: input.model }),
              ...(input.capabilityIds === undefined ? {} : { capabilityIds: input.capabilityIds }),
              ...(handoff.implementationAssigneeId === undefined
                ? {}
                : { implementationAssigneeId: handoff.implementationAssigneeId }),
              ...(handoff.independentVerifierId === undefined
                ? {}
                : { independentVerifierId: handoff.independentVerifierId }),
            });
          }
          yield* watchTaskCompletion({
            threadId: input.threadId,
            taskId: dispatched.task.taskId,
            runId: dispatched.run.runId,
            completedStage: route.targetStage,
            handoff,
          });
          return {
            route: dispatched.route,
            state: saved,
            stateEvent: dispatched.stateEvent,
            task: { task: dispatched.task, run: dispatched.run },
          };
        }

        const event = transitionSpecWorkflowState(
          state,
          {
            type: "advance",
            to: route.targetStage,
            expectedRevision: state.revision,
          },
          now,
        );
        const saved = yield* states.append({
          threadId: input.threadId,
          event,
          expectedRevision: state.revision,
        });
        return { route, state: saved, stateEvent: event, task: null };
      });
    }

    const control = (input: SpecWorkflowControlInput, type: "pause" | "resume") =>
      Effect.gen(function* () {
        const capability = yield* capabilities.get(input.threadId);
        yield* requireEnabled(capability, `thread:${input.threadId}`);
        const current = yield* states.get(input.threadId);
        if (Option.isNone(current)) {
          return yield* new SpecWorkflowStateStoreDomainError({
            code: "workflow-not-found",
            detail: "线程没有可操作的 Spec Workflow。",
            threadId: input.threadId,
          });
        }
        if (type === "pause" && current.value.activeTaskId !== null) {
          const cancellation = activeLoops.get(current.value.activeTaskId);
          if (cancellation !== undefined) cancellation.cancelled = true;
        }
        const event = yield* transitionSpecWorkflowControl({
          capability,
          state: current.value,
          command: { type, expectedRevision: input.expectedRevision },
          now: yield* Clock.currentTimeMillis,
        });
        return yield* states.append({
          threadId: input.threadId,
          event: event.event,
          expectedRevision: input.expectedRevision,
        });
      });

    const reviewProposal: SpecWorkflowServiceShape["reviewProposal"] = (input) =>
      Effect.gen(function* () {
        const capability = yield* capabilities.get(input.threadId);
        yield* requireEnabled(capability, `thread:${input.threadId}`);
        const current = yield* states.get(input.threadId);
        if (Option.isNone(current)) {
          return yield* new SpecWorkflowStateStoreDomainError({
            code: "workflow-not-found",
            detail: "线程没有可审核的 Spec Workflow 方案。",
            threadId: input.threadId,
          });
        }
        const event = transitionSpecWorkflowState(
          current.value,
          {
            type: input.decision === "approve" ? "approve-proposal" : "reject-proposal",
            expectedRevision: input.expectedRevision,
          },
          yield* Clock.currentTimeMillis,
        );
        return yield* states.append({
          threadId: input.threadId,
          event,
          expectedRevision: input.expectedRevision,
        });
      });

    const completeAcceptance: SpecWorkflowServiceShape["completeAcceptance"] = (input) =>
      Effect.gen(function* () {
        const capability = yield* capabilities.get(input.threadId);
        yield* requireEnabled(capability, `thread:${input.threadId}`);
        const current = yield* states.get(input.threadId);
        if (Option.isNone(current)) {
          return yield* new SpecWorkflowStateStoreDomainError({
            code: "workflow-not-found",
            detail: "线程没有可验收的 Spec Workflow。",
            threadId: input.threadId,
          });
        }
        const event = transitionSpecWorkflowState(
          current.value,
          { type: "complete-acceptance", expectedRevision: input.expectedRevision },
          yield* Clock.currentTimeMillis,
        );
        return yield* states.append({
          threadId: input.threadId,
          event,
          expectedRevision: input.expectedRevision,
        });
      });

    return {
      recover,
      getState,
      start,
      dispatch,
      reviewProposal,
      completeAcceptance,
      pause: (input) => control(input, "pause"),
      resume: (input) => control(input, "resume"),
      subscribe: (threadId) => states.subscribe(threadId),
    } satisfies SpecWorkflowServiceShape;
  }),
);
