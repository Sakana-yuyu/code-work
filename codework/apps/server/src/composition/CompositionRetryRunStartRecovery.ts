import type { CompositionTaskRetryRequest, CompositionTaskRetryResult } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  CompositionRunStartIntent,
  CompositionRunStartStoreError,
} from "../persistence/Services/CompositionRunStartStore.ts";
import type {
  CompositionTaskStoreError,
  CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import type { CompositionTaskRetryInvalidError } from "./CompositionOrchestratorErrors.ts";
import type { CompositionRunStartLifecycle } from "./CompositionRunStartLifecycle.ts";
import type { CompositionRetryTaskOperations } from "./CompositionRetryTaskTypes.ts";

export const makeCompositionRetryRunStartRecovery = (options: {
  readonly input: CompositionTaskRetryRequest;
  readonly store: CompositionTaskStoreShape;
  readonly lifecycle: CompositionRunStartLifecycle;
  readonly makeInvalid: (reason: string) => CompositionTaskRetryInvalidError;
  readonly persistStartedRun: CompositionRetryTaskOperations["persistStartedRun"];
}) => {
  const { input, store, lifecycle, makeInvalid, persistStartedRun } = options;

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
        currentRun.value.taskId !== intent.taskId ||
        currentRun.value.agentId !== intent.agentId ||
        currentRun.value.runtimeId !== intent.runtimeId ||
        currentRun.value.attempt !== intent.attempt
      ) {
        return yield* makeInvalid("run_start_projection_identity_conflict");
      }
      return { task: currentTask.value, run: currentRun.value };
    });

  const recoverAccepted = (
    accepted: CompositionRunStartIntent,
  ): Effect.Effect<
    CompositionTaskRetryResult,
    CompositionTaskStoreError | CompositionTaskRetryInvalidError | CompositionRunStartStoreError
  > =>
    Effect.gen(function* () {
      const persisted = yield* readPersistedResult(accepted);
      const recovered = yield* persistStartedRun({
        task: persisted.task,
        run: persisted.run,
        runtimeId: accepted.runtimeId,
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

  const resolvePersistedStart = (
    intent: CompositionRunStartIntent,
  ): Effect.Effect<
    CompositionTaskRetryResult,
    CompositionTaskStoreError | CompositionTaskRetryInvalidError | CompositionRunStartStoreError
  > => {
    if (
      intent.taskId !== input.taskId ||
      (input.agentId !== undefined && intent.agentId !== input.agentId)
    ) {
      return Effect.fail(makeInvalid("run_start_identity_conflict"));
    }
    switch (intent.state) {
      case "accepted":
        return recoverAccepted(intent);
      case "settled":
        return readPersistedResult(intent);
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
