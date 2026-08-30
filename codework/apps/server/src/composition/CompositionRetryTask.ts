import type { CompositionTask, CompositionTaskRun } from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  CompositionAgentDriverFailure,
  CompositionTaskNotFoundError,
  CompositionTaskRetryInvalidError,
} from "./CompositionOrchestratorErrors.ts";
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
): CompositionRetryTask => {
  const { store, driverRegistry, grantRegistry, inputStore, runStartStore, operations } = options;
  const runStartLifecycle =
    runStartStore === undefined ? undefined : makeCompositionRunStartLifecycle(runStartStore);

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
        lifecycle: startLifecycle,
        makeInvalid: retryInvalid,
        persistStartedRun: operations.persistStartedRun,
      });

      const existingStart = yield* startStore.getStart(input.runId);
      if (Option.isSome(existingStart) && existingStart.value.state !== "prepared") {
        return yield* resolvePersistedStart(existingStart.value);
      }

      const taskOption = yield* store.getTask(input.taskId);
      const previousRunOption = yield* store.getRun(input.previousRunId);
      if (Option.isNone(taskOption) || Option.isNone(previousRunOption)) {
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
        return yield* retryInvalid("capability_ids_required");
      }
      if (inputStore === undefined) {
        return yield* retryInvalid("recovery_input_store_unavailable");
      }
      const recoveryInputOption = yield* inputStore.get(input.taskId);
      if (Option.isNone(recoveryInputOption)) {
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
      const preparedAtUnixMs = Option.isSome(existingStart)
        ? existingStart.value.createdAtUnixMs
        : yield* Clock.currentTimeMillis;
      const startIntent = yield* startStore.prepareStart({
        ...startIdentity,
        createdAtUnixMs: preparedAtUnixMs,
      });

      if (startIntent.state !== "prepared") {
        return yield* resolvePersistedStart(startIntent);
      }
      const claimResult = yield* startLifecycle.claim(startIntent);
      if (!claimResult.claimed) {
        return yield* resolvePersistedStart(claimResult.intent);
      }
      const claimedIntent = claimResult.intent;

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
            yield* store.withTransaction(
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
            );
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
        yield* startLifecycle.release(claimedIntent);
        return yield* setupResult.failure;
      }
      if (setupResult.success._tag === "Completed") {
        yield* startLifecycle.release(claimedIntent);
        return setupResult.success.result;
      }
      const queuedTask = setupResult.success.task;
      const leasedRun = setupResult.success.run;

      const startResult = yield* Effect.result(
        targetDriver.startTask({
          task: queuedTask,
          run: leasedRun,
          prompt: recoveryInput.prompt,
          workspaceRoot: recoveryInput.workspaceRoot,
          ...(recoveryInput.workspaceRootDigest === undefined
            ? {}
            : { workspaceRootDigest: recoveryInput.workspaceRootDigest }),
          ...(recoveryInput.model === undefined ? {} : { model: recoveryInput.model }),
          capabilityGrantIds: leasedRun.capabilityGrantIds,
        }),
      );
      if (startResult._tag === "Failure") {
        yield* startLifecycle.markIndeterminate(claimedIntent, "driver_start_result_indeterminate");
        return yield* startResult.failure;
      }

      const acceptedResult = yield* Effect.result(
        startLifecycle.accept(claimedIntent, startResult.success),
      );
      if (acceptedResult._tag === "Failure") {
        const currentIntent = yield* startStore.getStart(input.runId);
        if (
          Option.isSome(currentIntent) &&
          currentIntent.value.state === "accepted" &&
          currentIntent.value.claimId === claimedIntent.claimId
        ) {
          return yield* recoverAccepted(currentIntent.value);
        }
        if (
          Option.isSome(currentIntent) &&
          currentIntent.value.state === "dispatching" &&
          currentIntent.value.claimId === claimedIntent.claimId
        ) {
          yield* startLifecycle.markIndeterminate(
            currentIntent.value,
            "driver_acceptance_receipt_persist_failed",
          );
        }
        return yield* acceptedResult.failure;
      }

      const persisted = yield* operations.persistStartedRun({
        task: queuedTask,
        run: leasedRun,
        runtimeId: targetDriver.runtimeId,
        startResult: startResult.success,
        summary: "重试任务已交给 Agent Driver 执行",
      });
      yield* startLifecycle.settle(acceptedResult.success);
      return persisted;
    });
};
