import type { CompositionTaskRetryRequest, CompositionTaskRetryResult } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  CompositionRunStartIntent,
  CompositionRunStartStoreError,
} from "../persistence/Services/CompositionRunStartStore.ts";
import type {
  CompositionTaskInputStoreError,
  CompositionTaskInputStoreShape,
} from "../persistence/Services/CompositionTaskInputStore.ts";
import type {
  CompositionTaskStoreError,
  CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import type { CompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import type { CompositionTaskRetryInvalidError } from "./CompositionOrchestratorErrors.ts";
import {
  makeCompositionRunStartDigests,
  type CompositionRunStartLifecycle,
} from "./CompositionRunStartLifecycle.ts";
import { isCompositionRunStartedProjectionStatus } from "./CompositionRunStartProjectionStatus.ts";
import { validateCompositionRunStartReceipt } from "./CompositionRunStartReceiptPolicy.ts";
import type { CompositionRetryTaskOperations } from "./CompositionRetryTaskTypes.ts";

export const makeCompositionRetryRunStartRecovery = (options: {
  readonly input: CompositionTaskRetryRequest;
  readonly store: CompositionTaskStoreShape;
  readonly driverRegistry: CompositionAgentDriverRegistry;
  readonly inputStore?: CompositionTaskInputStoreShape;
  readonly lifecycle: CompositionRunStartLifecycle;
  readonly makeInvalid: (reason: string) => CompositionTaskRetryInvalidError;
  readonly persistStartedRun: CompositionRetryTaskOperations["persistStartedRun"];
}) => {
  const { input, store, driverRegistry, inputStore, lifecycle, makeInvalid, persistStartedRun } =
    options;

  const validatePersistedInput = (
    intent: CompositionRunStartIntent,
  ): Effect.Effect<void, CompositionTaskInputStoreError | CompositionTaskRetryInvalidError> =>
    Effect.gen(function* () {
      if (input.capabilityIds.length === 0) {
        return yield* makeInvalid("capability_ids_required");
      }
      if (inputStore === undefined) {
        return yield* makeInvalid("recovery_input_store_unavailable");
      }
      const recoveryInput = yield* inputStore.get(input.taskId);
      if (Option.isNone(recoveryInput)) {
        return yield* makeInvalid("recovery_input_missing");
      }
      const digests = makeCompositionRunStartDigests({
        prompt: recoveryInput.value.prompt,
        workspaceRoot: recoveryInput.value.workspaceRoot,
        ...(recoveryInput.value.workspaceRootDigest === undefined
          ? {}
          : { workspaceRootDigest: recoveryInput.value.workspaceRootDigest }),
        ...(recoveryInput.value.model === undefined ? {} : { model: recoveryInput.value.model }),
        capabilityIds: input.capabilityIds,
      });
      if (
        intent.payloadDigest !== digests.payloadDigest ||
        intent.capabilityDigest !== digests.capabilityDigest
      ) {
        return yield* makeInvalid("run_start_identity_conflict");
      }
    });

  const readPersistedResult = (
    intent: CompositionRunStartIntent,
  ): Effect.Effect<
    CompositionTaskRetryResult,
    CompositionTaskStoreError | CompositionTaskRetryInvalidError
  > =>
    Effect.gen(function* () {
      if (
        intent.taskId !== input.taskId ||
        (input.agentId !== undefined && intent.agentId !== input.agentId)
      ) {
        return yield* makeInvalid("run_start_identity_conflict");
      }
      const currentTask = yield* store.getTask(intent.taskId);
      const currentRun = yield* store.getRun(intent.runId);
      if (Option.isNone(currentTask) || Option.isNone(currentRun)) {
        return yield* makeInvalid("run_start_projection_missing");
      }
      if (
        currentTask.value.assigneeKind !== "agent" ||
        currentTask.value.assigneeId !== intent.agentId ||
        currentRun.value.taskId !== intent.taskId ||
        currentRun.value.agentId !== intent.agentId ||
        currentRun.value.runtimeId !== intent.runtimeId ||
        currentRun.value.attempt !== intent.attempt
      ) {
        return yield* makeInvalid("run_start_projection_identity_conflict");
      }
      return { task: currentTask.value, run: currentRun.value };
    });

  const validatePersistedReceipt = Effect.fn(
    "CompositionRetryRunStartRecovery.validatePersistedReceipt",
  )(function* (intent: CompositionRunStartIntent, run: CompositionTaskRetryResult["run"]) {
    const driver = yield* driverRegistry.get(intent.agentId);
    if (driver === undefined) return yield* makeInvalid("agent_driver_unavailable");
    if (driver.agentId !== intent.agentId || driver.runtimeId !== intent.runtimeId) {
      return yield* makeInvalid("run_start_driver_identity_conflict");
    }
    const receiptError = validateCompositionRunStartReceipt({
      policy: driver.startRecoveryPolicy,
      capabilityGrantIds: run.capabilityGrantIds ?? [],
      receipt: {
        ...(intent.runtimeTaskId === null ? {} : { runtimeTaskId: intent.runtimeTaskId }),
        ...(intent.capabilityHandshakeId === null
          ? {}
          : { capabilityHandshakeId: intent.capabilityHandshakeId }),
      },
    });
    if (receiptError !== undefined) return yield* makeInvalid(receiptError);
  });

  const recoverAccepted = (
    accepted: CompositionRunStartIntent,
  ): Effect.Effect<
    CompositionTaskRetryResult,
    CompositionTaskStoreError | CompositionTaskRetryInvalidError | CompositionRunStartStoreError
  > =>
    Effect.gen(function* () {
      const persisted = yield* readPersistedResult(accepted);
      yield* validatePersistedReceipt(accepted, persisted.run);
      const recovered = yield* persistStartedRun({
        task: persisted.task,
        run: persisted.run,
        runtimeId: accepted.runtimeId,
        expectedPreStartStatus: "queued",
        startResult: {
          ...(accepted.runtimeTaskId === null ? {} : { runtimeTaskId: accepted.runtimeTaskId }),
          ...(accepted.capabilityHandshakeId === null
            ? {}
            : { capabilityHandshakeId: accepted.capabilityHandshakeId }),
        },
        summary: "已从持久 Run Start 收据恢复重试任务",
      });
      yield* lifecycle.settle(accepted);
      return recovered;
    });

  const recoverSettled = (
    settled: CompositionRunStartIntent,
  ): Effect.Effect<
    CompositionTaskRetryResult,
    CompositionTaskStoreError | CompositionTaskRetryInvalidError
  > =>
    Effect.gen(function* () {
      const persisted = yield* readPersistedResult(settled);
      if (
        persisted.task.status !== persisted.run.status ||
        !isCompositionRunStartedProjectionStatus(persisted.task.status)
      ) {
        return yield* makeInvalid("run_start_settled_projection_not_started");
      }
      yield* validatePersistedReceipt(settled, persisted.run);
      if (
        (persisted.run.runtimeTaskId !== undefined &&
          persisted.run.runtimeTaskId !== settled.runtimeTaskId) ||
        (persisted.run.capabilityHandshakeId !== undefined &&
          persisted.run.capabilityHandshakeId !== settled.capabilityHandshakeId)
      ) {
        return yield* makeInvalid("run_start_receipt_conflict");
      }
      return yield* persistStartedRun({
        task: persisted.task,
        run: persisted.run,
        runtimeId: settled.runtimeId,
        startResult: {
          ...(settled.runtimeTaskId === null ? {} : { runtimeTaskId: settled.runtimeTaskId }),
          ...(settled.capabilityHandshakeId === null
            ? {}
            : { capabilityHandshakeId: settled.capabilityHandshakeId }),
        },
        summary: "已校验持久 Run Start 结果并补齐启动收据",
      });
    });

  const resolvePersistedStart = (
    intent: CompositionRunStartIntent,
  ): Effect.Effect<
    CompositionTaskRetryResult,
    | CompositionTaskStoreError
    | CompositionTaskInputStoreError
    | CompositionTaskRetryInvalidError
    | CompositionRunStartStoreError
  > => {
    if (
      intent.taskId !== input.taskId ||
      (input.agentId !== undefined && intent.agentId !== input.agentId)
    ) {
      return Effect.fail(makeInvalid("run_start_identity_conflict"));
    }
    switch (intent.state) {
      case "accepted":
        return validatePersistedInput(intent).pipe(Effect.andThen(recoverAccepted(intent)));
      case "settled":
        return validatePersistedInput(intent).pipe(Effect.andThen(recoverSettled(intent)));
      case "dispatching":
        return Effect.fail(makeInvalid("run_start_dispatching_recovery_forbidden"));
      case "indeterminate":
        return Effect.fail(
          makeInvalid(`run_start_indeterminate_${intent.outcomeCode ?? "unknown"}`),
        );
      case "prepared":
        return Effect.fail(makeInvalid("run_start_not_claimed"));
    }
  };

  return { recoverAccepted, resolvePersistedStart } as const;
};
