import type {
  CompositionCapabilityGrant,
  CompositionTask,
  CompositionTaskRun,
} from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { CompositionRunStartIntent } from "../persistence/Services/CompositionRunStartStore.ts";
import type { CompositionTaskRecoveryInput } from "../persistence/Services/CompositionTaskInputStore.ts";
import {
  CompositionAgentDriverFailure,
  CompositionTaskNotFoundError,
  CompositionTaskRetryInvalidError,
} from "./CompositionOrchestratorErrors.ts";
import { dispatchCompositionClaimedRunStart } from "./CompositionClaimedRunStart.ts";
import { recoverCompositionDispatchingRunStart } from "./CompositionDispatchingRunStartRecovery.ts";
import type { CompositionAgentDriver } from "./CompositionOrchestrator.ts";
import { makeCompositionRetryRunStartRecovery } from "./CompositionRetryRunStartRecovery.ts";
import {
  makeCompositionRunStartDigests,
  makeCompositionRunStartLifecycle,
} from "./CompositionRunStartLifecycle.ts";
import type {
  CompositionRetryTask,
  CompositionRetryTaskOptions,
} from "./CompositionRetryTaskTypes.ts";

export type {
  CompositionRetryTask,
  CompositionRetryTaskOperations,
  CompositionRetryTaskOptions,
} from "./CompositionRetryTaskTypes.ts";

export type CompositionRetryTaskMode = "retry" | "recover-only";

const makeRetryEvent = (input: {
  readonly task: CompositionTask;
  readonly run: CompositionTaskRun;
  readonly summary: string;
}) => ({
  taskId: input.task.taskId,
  runId: input.run.runId,
  agentId: input.run.agentId,
  status: input.run.status,
  sequence: 0,
  eventType: "status" as const,
  summary: input.summary,
});

export const makeCompositionRetryTask = (
  options: CompositionRetryTaskOptions,
  mode: CompositionRetryTaskMode = "retry",
): CompositionRetryTask => {
  const { store, driverRegistry, grantRegistry, inputStore, runStartStore, operations } = options;
  const runStartLifecycle =
    runStartStore === undefined ? undefined : makeCompositionRunStartLifecycle(runStartStore);

  /** setup 失败时的最佳努力补偿：撤销本次已签发但尚未投影成功的 grant。 */
  const compensateIssuedGrants = (
    grants: ReadonlyArray<CompositionCapabilityGrant>,
  ): Effect.Effect<void> => {
    const revoke = grantRegistry?.revoke;
    if (revoke === undefined || grants.length === 0) return Effect.void;
    return Effect.forEach(grants, (grant) =>
      revoke({ grantId: grant.grantId }).pipe(
        Effect.catchTag("CapabilityGrantNotFoundError", () => Effect.void),
      ),
    ).pipe(
      Effect.asVoid,
      Effect.catch(() =>
        Effect.logWarning("撤销孤儿 Run Start 授权失败", { taskId: grants[0]?.taskId }).pipe(
          Effect.asVoid,
        ),
      ),
    );
  };

  return (input) =>
    Effect.gen(function* () {
      const retryInvalid = (reason: string) =>
        new CompositionTaskRetryInvalidError({
          taskId: input.taskId,
          previousRunId: input.previousRunId,
          reason,
        });

      if (runStartStore === undefined || runStartLifecycle === undefined) {
        return yield* retryInvalid("run_start_store_unavailable");
      }
      const startStore = runStartStore;
      const startLifecycle = runStartLifecycle;

      const { recoverAccepted, resolvePersistedStart } = makeCompositionRetryRunStartRecovery({
        input,
        store,
        driverRegistry,
        ...(inputStore === undefined ? {} : { inputStore }),
        lifecycle: startLifecycle,
        makeInvalid: retryInvalid,
        persistStartedRun: operations.persistStartedRun,
      });

      const quarantineDispatching = (intent: CompositionRunStartIntent, outcomeCode: string) =>
        startLifecycle
          .markIndeterminate(intent, outcomeCode)
          .pipe(
            Effect.flatMap((marked) =>
              Effect.fail(
                retryInvalid(`run_start_indeterminate_${marked.outcomeCode ?? "unknown"}`),
              ),
            ),
          );

      /** 接管 prepared 所有权后补偿已完成本地 setup 的 grant/lease，再隔离为 indeterminate。 */
      const quarantinePreparedRecovery = (
        intent: CompositionRunStartIntent,
        outcomeCode: string,
      ) =>
        Effect.gen(function* () {
          const claimResult = yield* startLifecycle.claim(intent);
          if (!claimResult.claimed) {
            // 其他恢复者已接管该意图；补偿责任归当前 claim owner。
            return yield* retryInvalid("run_start_recovery_claim_conflict");
          }
          const claimedIntent = claimResult.intent;
          const setupRunOption = yield* store.getRun(input.runId);
          if (Option.isSome(setupRunOption)) {
            const setupTaskOption = yield* store.getTask(input.taskId);
            if (Option.isSome(setupTaskOption)) {
              const setupDriver = yield* driverRegistry.get(setupRunOption.value.agentId);
              yield* operations.revokeRunCapabilities(
                setupDriver,
                setupTaskOption.value,
                setupRunOption.value,
              );
            }
            yield* operations.releaseRunLease(setupRunOption.value);
          }
          return yield* quarantineDispatching(claimedIntent, outcomeCode);
        });

      const dispatchClaimedRun = (dispatch: {
        readonly task: CompositionTask;
        readonly run: CompositionTaskRun;
        readonly driver: CompositionAgentDriver;
        readonly intent: CompositionRunStartIntent;
        readonly recoveryInput: CompositionTaskRecoveryInput;
      }) =>
        dispatchCompositionClaimedRunStart({
          ...dispatch,
          startStore,
          lifecycle: startLifecycle,
          recoverAccepted,
          persistStartedRun: operations.persistStartedRun,
        });

      const existingStart = yield* startStore.getStart(input.runId);
      if (mode === "recover-only" && Option.isNone(existingStart)) {
        return yield* retryInvalid("run_start_recovery_intent_missing");
      }
      if (
        Option.isSome(existingStart) &&
        existingStart.value.state !== "prepared" &&
        (existingStart.value.state !== "dispatching" || mode !== "recover-only")
      ) {
        return yield* resolvePersistedStart(existingStart.value);
      }

      const taskOption = yield* store.getTask(input.taskId);
      const previousRunOption = yield* store.getRun(input.previousRunId);
      if (Option.isNone(taskOption) || Option.isNone(previousRunOption)) {
        if (Option.isSome(existingStart) && existingStart.value.state === "dispatching") {
          return yield* quarantineDispatching(
            existingStart.value,
            "run_start_previous_projection_missing",
          );
        }
        return yield* new CompositionTaskNotFoundError({
          taskId: input.taskId,
          runId: input.previousRunId,
        });
      }
      const task = taskOption.value;
      const previousRun = previousRunOption.value;

      if (Option.isNone(existingStart)) {
        const latestRunOption = yield* store.getLatestRun(input.taskId);
        const existingRunOption = yield* store.getRun(input.runId);
        if (Option.isNone(latestRunOption)) {
          return yield* retryInvalid("latest_run_missing");
        }
        if (task.status !== "failed" && task.status !== "timed_out") {
          return yield* retryInvalid(`task_status_${task.status}`);
        }
        if (previousRun.status !== "failed" && previousRun.status !== "timed_out") {
          return yield* retryInvalid(`run_status_${previousRun.status}`);
        }
        if (latestRunOption.value.runId !== input.previousRunId) {
          return yield* retryInvalid("previous_run_is_not_latest");
        }
        if (input.runId === input.previousRunId || Option.isSome(existingRunOption)) {
          return yield* retryInvalid("run_id_conflict");
        }
      }

      if (input.capabilityIds.length === 0) {
        if (Option.isSome(existingStart) && existingStart.value.state === "dispatching") {
          return yield* quarantineDispatching(
            existingStart.value,
            "run_start_recovery_capability_ids_missing",
          );
        }
        if (mode === "recover-only" && Option.isSome(existingStart)) {
          // 启动恢复读到不兼容输入时不得让 prepared setup 的 grant/lease 悬挂。
          return yield* quarantinePreparedRecovery(
            existingStart.value,
            "run_start_recovery_capability_ids_missing",
          );
        }
        return yield* retryInvalid("capability_ids_required");
      }
      if (inputStore === undefined) {
        if (Option.isSome(existingStart) && existingStart.value.state === "dispatching") {
          return yield* quarantineDispatching(
            existingStart.value,
            "run_start_recovery_input_store_unavailable",
          );
        }
        return yield* retryInvalid("recovery_input_store_unavailable");
      }
      const recoveryInputOption = yield* inputStore.get(input.taskId);
      if (Option.isNone(recoveryInputOption)) {
        if (Option.isSome(existingStart) && existingStart.value.state === "dispatching") {
          return yield* quarantineDispatching(
            existingStart.value,
            "run_start_recovery_input_missing",
          );
        }
        return yield* retryInvalid("recovery_input_missing");
      }
      const recoveryInput = recoveryInputOption.value;
      const targetAgentId = input.agentId ?? previousRun.agentId;
      const previousDriver = yield* driverRegistry.get(previousRun.agentId);
      const targetDriver =
        targetAgentId === previousRun.agentId
          ? previousDriver
          : yield* driverRegistry.get(targetAgentId);
      if (targetDriver === undefined) {
        if (Option.isSome(existingStart) && existingStart.value.state === "dispatching") {
          return yield* quarantineDispatching(existingStart.value, "agent_driver_unavailable");
        }
        return yield* new CompositionAgentDriverFailure({
          code: "agent_driver_unavailable",
          detail: `未找到目标 Agent Driver：${targetAgentId}`,
        });
      }

      const startDigests = makeCompositionRunStartDigests({
        prompt: recoveryInput.prompt,
        workspaceRoot: recoveryInput.workspaceRoot,
        ...(recoveryInput.workspaceRootDigest === undefined
          ? {}
          : { workspaceRootDigest: recoveryInput.workspaceRootDigest }),
        ...(recoveryInput.model === undefined ? {} : { model: recoveryInput.model }),
        capabilityIds: input.capabilityIds,
      });
      const startIdentity = {
        runId: input.runId,
        taskId: input.taskId,
        agentId: targetAgentId,
        runtimeId: targetDriver.runtimeId,
        attempt: previousRun.attempt + 1,
        payloadDigest: startDigests.payloadDigest,
        capabilityDigest: startDigests.capabilityDigest,
      } as const;
      if (
        Option.isSome(existingStart) &&
        existingStart.value.state === "dispatching" &&
        (existingStart.value.taskId !== startIdentity.taskId ||
          existingStart.value.agentId !== startIdentity.agentId ||
          existingStart.value.runtimeId !== startIdentity.runtimeId ||
          existingStart.value.attempt !== startIdentity.attempt ||
          existingStart.value.payloadDigest !== startIdentity.payloadDigest ||
          existingStart.value.capabilityDigest !== startIdentity.capabilityDigest)
      ) {
        return yield* quarantineDispatching(
          existingStart.value,
          "run_start_recovery_identity_conflict",
        );
      }
      const preparedAtUnixMs = Option.isSome(existingStart)
        ? existingStart.value.createdAtUnixMs
        : yield* Clock.currentTimeMillis;
      const startIntent = yield* startStore.prepareStart({
        ...startIdentity,
        createdAtUnixMs: preparedAtUnixMs,
      });

      if (startIntent.state === "dispatching") {
        const recovery = yield* recoverCompositionDispatchingRunStart({
          intent: startIntent,
          store,
          driver: targetDriver,
          lifecycle: startLifecycle,
          makeInvalid: retryInvalid,
          resolvePersistedStart,
        });
        if (recovery._tag === "Completed") return recovery.result;
        const leasedRunOption = yield* operations.prepareRunLease(
          recovery.task,
          recovery.run,
          recoveryInput.workspaceRootDigest,
        );
        if (Option.isNone(leasedRunOption)) {
          return yield* quarantineDispatching(startIntent, "run_start_recovery_lease_unavailable");
        }
        return yield* dispatchClaimedRun({
          task: recovery.task,
          run: leasedRunOption.value,
          driver: targetDriver,
          intent: startIntent,
          recoveryInput,
        });
      }
      if (startIntent.state !== "prepared") {
        return yield* resolvePersistedStart(startIntent);
      }
      // 本地 setup 在 claim 之前完成：授权签发与 queued 投影未落定前不持有
      // dispatch 所有权，失败或中断只留下可被安全接管的 prepared 意图。

      const setupResult = yield* Effect.result(
        Effect.gen(function* () {
          const currentTaskOption = yield* store.getTask(input.taskId);
          const currentPreviousRunOption = yield* store.getRun(input.previousRunId);
          const currentNewRunOption = yield* store.getRun(input.runId);
          if (Option.isNone(currentTaskOption) || Option.isNone(currentPreviousRunOption)) {
            return yield* new CompositionTaskNotFoundError({
              taskId: input.taskId,
              runId: input.previousRunId,
            });
          }
          const currentTask = currentTaskOption.value;
          const currentPreviousRun = currentPreviousRunOption.value;

          let queuedTask: CompositionTask;
          let queuedRun: CompositionTaskRun;
          if (Option.isSome(currentNewRunOption)) {
            queuedTask = currentTask;
            queuedRun = currentNewRunOption.value;
            if (
              queuedRun.taskId !== input.taskId ||
              queuedRun.agentId !== targetAgentId ||
              queuedRun.runtimeId !== targetDriver.runtimeId ||
              queuedRun.attempt !== previousRun.attempt + 1 ||
              queuedRun.status !== "queued" ||
              queuedTask.status !== "queued"
            ) {
              return yield* retryInvalid("run_start_projection_identity_conflict");
            }
          } else {
            const currentLatestRun = yield* store.getLatestRun(input.taskId);
            if (Option.isNone(currentLatestRun)) {
              return yield* retryInvalid("latest_run_missing");
            }
            if (currentTask.status !== "failed" && currentTask.status !== "timed_out") {
              return yield* retryInvalid(`task_status_${currentTask.status}`);
            }
            if (
              currentPreviousRun.status !== "failed" &&
              currentPreviousRun.status !== "timed_out"
            ) {
              return yield* retryInvalid(`run_status_${currentPreviousRun.status}`);
            }
            if (currentLatestRun.value.runId !== input.previousRunId) {
              return yield* retryInvalid("previous_run_is_not_latest");
            }

            // claim 成功后才允许撤销旧授权、签发新授权和创建新 Run。
            yield* operations.revokeRunCapabilities(
              previousDriver,
              currentTask,
              currentPreviousRun,
            );
            yield* operations.releaseRunLease(currentPreviousRun);
            const issuedGrants =
              grantRegistry === undefined
                ? []
                : yield* grantRegistry.issue({
                    taskId: input.taskId,
                    agentId: targetAgentId,
                    capabilityIds: startDigests.capabilityIds,
                  });
            const queuedAt = yield* Clock.currentTimeMillis;
            const { finishedAtUnixMs: _finishedAtUnixMs, ...taskWithoutFinishedAt } = currentTask;
            queuedTask = {
              ...taskWithoutFinishedAt,
              assigneeId: targetAgentId,
              status: "queued",
              updatedAtUnixMs: queuedAt,
            };
            queuedRun = {
              runId: input.runId,
              taskId: input.taskId,
              agentId: targetAgentId,
              runtimeId: targetDriver.runtimeId,
              status: "queued",
              attempt: currentPreviousRun.attempt + 1,
              capabilityGrantIds: issuedGrants.map((grant) => grant.grantId),
            };
            const queuedProjection = yield* Effect.result(
              store.withTransaction(
                Effect.gen(function* () {
                  yield* store.upsertTask(queuedTask);
                  yield* store.upsertRun(queuedRun);
                  yield* store.appendEvent(
                    makeRetryEvent({
                      task: queuedTask,
                      run: queuedRun,
                      summary:
                        targetAgentId === currentPreviousRun.agentId
                          ? `任务已请求重试：${input.reason}`
                          : `任务已从 Agent ${currentPreviousRun.agentId} 重派至 ${targetAgentId}：${input.reason}`,
                    }),
                  );
                  if (issuedGrants.length > 0) {
                    yield* operations.persistCapabilityGrantProjection({
                      task: queuedTask,
                      run: queuedRun,
                      sourceEventId: `capgrant:${queuedTask.taskId}:${queuedRun.runId}:issued`,
                      summary: operations.describeIssuedGrants(issuedGrants),
                    });
                  }
                }),
              ),
            );
            if (queuedProjection._tag === "Failure") {
              // queued 投影事务失败时不得留下孤儿授权；立即撤销本次签发的 grant。
              yield* compensateIssuedGrants(issuedGrants);
              return yield* queuedProjection.failure;
            }
          }

          const leasedRunOption = yield* operations.prepareRunLease(
            queuedTask,
            queuedRun,
            recoveryInput.workspaceRootDigest,
          );
          if (Option.isNone(leasedRunOption)) {
            const failed = yield* operations.persistFailedStart({
              task: queuedTask,
              run: queuedRun,
              driver: targetDriver,
              failure: new CompositionAgentDriverFailure({
                code: "capacity_exceeded",
                detail: "工作区已有未过期的 Runtime 租约，拒绝重复派发。",
              }),
              summary: "重试任务未获得工作区租约",
              finishTask: true,
            });
            return { _tag: "Completed" as const, result: failed };
          }
          return {
            _tag: "Ready" as const,
            task: queuedTask,
            run: leasedRunOption.value,
          };
        }),
      );
      if (setupResult._tag === "Failure") {
        return yield* setupResult.failure;
      }
      if (setupResult.success._tag === "Completed") {
        return setupResult.success.result;
      }
      const queuedTask = setupResult.success.task;
      const leasedRun = setupResult.success.run;
      const claimResult = yield* startLifecycle.claim(startIntent);
      if (!claimResult.claimed) {
        // 其他恢复者已接管本次启动；以持久赢家为准补齐结果。
        return yield* resolvePersistedStart(claimResult.intent);
      }
      return yield* dispatchClaimedRun({
        task: queuedTask,
        run: leasedRun,
        driver: targetDriver,
        intent: claimResult.intent,
        recoveryInput,
      });
    });
};
