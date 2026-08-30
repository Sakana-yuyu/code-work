import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import type {
  CompositionRunStartIntent,
  CompositionRunStartExecutionStoreShape,
  CompositionRunStartStoreError,
} from "../persistence/Services/CompositionRunStartStore.ts";
import {
  normalizeCompositionRunStartRejectedOutcome,
  validateCompositionRunStartReceipt,
  type CompositionRunStartReceipt,
  type CompositionRunStartReceiptError,
  type CompositionRunStartRecoveryPolicy,
} from "./CompositionRunStartLifecycle.ts";

type StartFailure = {
  readonly code: string;
  readonly detail: string;
};

type CompositionRunStartAcceptedProjection<A> = {
  readonly accepted: CompositionRunStartIntent;
  readonly result: A;
};

type CompositionRunStartDispatchInput<A, F extends StartFailure, EAccepted, ERejected> = {
  readonly store: CompositionRunStartExecutionStoreShape;
  readonly intent: CompositionRunStartIntent;
  readonly policy: CompositionRunStartRecoveryPolicy;
  readonly capabilityGrantIds: ReadonlyArray<string>;
  readonly start: Effect.Effect<
    { readonly runtimeTaskId?: string; readonly capabilityHandshakeId?: string },
    F
  >;
  readonly onAccepted: (receipt: CompositionRunStartReceipt) => Effect.Effect<A, EAccepted>;
  /** 将 receipt 记录与业务投影置于同一持久化事务；未提供时沿用兼容路径。 */
  readonly onAcceptedWithReceipt?: (
    receipt: CompositionRunStartReceipt,
    recordAccepted: Effect.Effect<CompositionRunStartIntent, CompositionRunStartStoreError>,
  ) => Effect.Effect<CompositionRunStartAcceptedProjection<A>, EAccepted>;
  readonly onRejected: (failure: F) => Effect.Effect<A, ERejected>;
  readonly mapReceiptFailure: (failure: CompositionRunStartReceiptError) => F;
};

export const dispatchCompositionRunStart = <A, F extends StartFailure, EAccepted, ERejected>(
  input: CompositionRunStartDispatchInput<A, F, EAccepted, ERejected>,
) =>
  Effect.gen(function* () {
    const startResult = yield* Effect.result(input.start);
    if (startResult._tag === "Failure") {
      const settledAtUnixMs = yield* Clock.currentTimeMillis;
      const rejected = normalizeCompositionRunStartRejectedOutcome(startResult.failure);
      yield* input.store.settleRejected({
        runId: input.intent.runId,
        expectedRevision: input.intent.revision,
        claimId: input.intent.claimId ?? "",
        ownerEpoch: input.intent.ownerEpoch,
        ...rejected,
        settledAtUnixMs,
      });
      return yield* input.onRejected(startResult.failure);
    }

    const receiptResult = yield* Effect.result(
      validateCompositionRunStartReceipt({
        policy: input.policy,
        startResult: startResult.success,
        capabilityGrantIds: input.capabilityGrantIds,
      }),
    );
    if (receiptResult._tag === "Failure") {
      const quarantinedAtUnixMs = yield* Clock.currentTimeMillis;
      yield* input.store.quarantine({
        runId: input.intent.runId,
        expectedRevision: input.intent.revision,
        claimId: input.intent.claimId ?? "",
        ownerEpoch: input.intent.ownerEpoch,
        outcomeCode: receiptResult.failure.code,
        outcomeDetail: receiptResult.failure.detail,
        quarantinedAtUnixMs,
      });
      return yield* Effect.fail(input.mapReceiptFailure(receiptResult.failure));
    }

    const acceptedAtUnixMs = yield* Clock.currentTimeMillis;
    const recordAccepted = input.store.recordAccepted({
      runId: input.intent.runId,
      expectedRevision: input.intent.revision,
      claimId: input.intent.claimId ?? "",
      runtimeTaskId: receiptResult.success.runtimeTaskId,
      capabilityHandshakeId: receiptResult.success.capabilityHandshakeId,
      acceptedAtUnixMs,
      ownerEpoch: input.intent.ownerEpoch,
    });
    const atomicProjection = input.onAcceptedWithReceipt;
    const acceptedProjection =
      atomicProjection === undefined
        ? {
            accepted: yield* recordAccepted,
            result: yield* input.onAccepted(receiptResult.success),
          }
        : yield* atomicProjection(receiptResult.success, recordAccepted);
    const settledAtUnixMs = yield* Clock.currentTimeMillis;
    yield* input.store.settleAccepted({
      runId: acceptedProjection.accepted.runId,
      expectedRevision: acceptedProjection.accepted.revision,
      settledAtUnixMs,
    });
    return acceptedProjection.result;
  });
