import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { runStartStoreLayer } from "../persistence/Layers/CompositionRunStartStoreTestSupport.ts";
import { CompositionRunStartStore } from "../persistence/Services/CompositionRunStartStore.ts";
import {
  claimCompositionRunStartSetup,
  runCompositionWithPersistedStart,
  type CompositionRunStartSetup,
} from "./CompositionRunStartCoordinator.ts";

const setup: CompositionRunStartSetup = {
  taskId: "task-run-start-coordinator-cancelled",
  projectId: "project-run-start-coordinator-cancelled",
  threadId: null,
  parentTaskId: null,
  runId: "run-run-start-coordinator-cancelled",
  previousRunId: null,
  assigneeKind: "agent",
  assigneeId: "agent-run-start-coordinator-cancelled",
  mode: "serial",
  dependsOnTaskIds: [],
  agentId: "agent-run-start-coordinator-cancelled",
  runtimeId: "runtime-run-start-coordinator-cancelled",
  attempt: 1,
  promptDigest: "sha256:prompt-run-start-coordinator-cancelled",
  workspaceRootDigest: null,
  model: null,
  externalTargetIdentity: null,
  capabilityIds: [],
};

runStartStoreLayer("Composition Run Start 协调器", (it) => {
  it.effect("已完成取消的 settled winner 不得再次投影 accepted", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const claimed = yield* claimCompositionRunStartSetup(store, setup);
      assert.isTrue(claimed.claimed);
      const dispatching = yield* store.markDispatching({
        runId: setup.runId,
        expectedRevision: claimed.intent.revision,
        claimId: claimed.intent.claimId ?? "",
        ownerEpoch: claimed.intent.ownerEpoch,
        dispatchedAtUnixMs: claimed.intent.updatedAtUnixMs + 1,
      });
      const accepted = yield* store.recordAccepted({
        runId: setup.runId,
        expectedRevision: dispatching.revision,
        claimId: dispatching.claimId ?? "",
        ownerEpoch: dispatching.ownerEpoch,
        runtimeTaskId: "runtime-task-run-start-coordinator-cancelled",
        capabilityHandshakeId: null,
        acceptedAtUnixMs: dispatching.updatedAtUnixMs + 1,
      });
      const acceptedSettled = yield* store.settleAccepted({
        runId: setup.runId,
        expectedRevision: accepted.revision,
        claimId: accepted.claimId ?? "",
        ownerEpoch: accepted.ownerEpoch,
        settledAtUnixMs: accepted.updatedAtUnixMs + 1,
      });
      const cancellation = yield* store.requestCancellation({
        runId: setup.runId,
        expectedRevision: acceptedSettled.revision,
        requestedAtUnixMs: acceptedSettled.updatedAtUnixMs + 1,
        reason: "用户请求取消。",
      });
      const cancellationClaim = yield* store.claimCancellationRecovery({
        runId: setup.runId,
        expectedRevision: cancellation.revision,
        claimId: "claim-run-start-coordinator-cancelled",
        claimedAtUnixMs: cancellation.updatedAtUnixMs + 1,
        leaseExpiresAtUnixMs: cancellation.updatedAtUnixMs + 1_000,
      });
      assert.isTrue(cancellationClaim.claimed);
      const terminal = yield* store.markCancellationTerminalObserved({
        runId: setup.runId,
        expectedRevision: cancellationClaim.intent.revision,
        sourceRevision: cancellationClaim.intent.cancelSourceRevision ?? 0,
        sourceClaimId: cancellationClaim.intent.cancelSourceClaimId ?? null,
        sourceOwnerEpoch: cancellationClaim.intent.cancelSourceOwnerEpoch ?? 0,
        runtimeTaskId: cancellationClaim.intent.runtimeTaskId,
        capabilityHandshakeId: cancellationClaim.intent.capabilityHandshakeId,
        terminalStatus: "cancelled",
        sourceEventId: "event-run-start-coordinator-cancelled",
        observedAtUnixMs: cancellationClaim.intent.updatedAtUnixMs + 1,
      });
      yield* store.settleCancellation({
        runId: setup.runId,
        expectedRevision: terminal.revision,
        claimId: terminal.claimId ?? "",
        ownerEpoch: terminal.ownerEpoch,
        settledAtUnixMs: terminal.updatedAtUnixMs + 1,
      });

      let starts = 0;
      let acceptedProjections = 0;
      const result = yield* Effect.result(
        runCompositionWithPersistedStart({
          store,
          setup,
          capabilityGrantIds: [],
          start: Effect.sync(() => {
            starts += 1;
            return {};
          }),
          onAccepted: () =>
            Effect.sync(() => {
              acceptedProjections += 1;
              return "accepted";
            }),
          onRejected: () => Effect.succeed("rejected"),
          makeFailure: (failure) => failure,
        }),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(
          (result.failure as { readonly code?: string }).code,
          "run_start_cancellation_settled",
        );
      }
      assert.equal(starts, 0);
      assert.equal(acceptedProjections, 0);
    }),
  );
});
