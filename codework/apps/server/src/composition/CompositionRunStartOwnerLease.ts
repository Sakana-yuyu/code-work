import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type {
  CompositionRunStartExecutionStoreShape,
  CompositionRunStartIntent,
} from "../persistence/Services/CompositionRunStartStore.ts";

export const COMPOSITION_RUN_START_OWNER_LEASE_MS = 60_000;
export const COMPOSITION_RUN_START_OWNER_HEARTBEAT_MS = 20_000;

const renewCompositionRunStartOwnerLeaseOnce = (
  store: CompositionRunStartExecutionStoreShape,
  intent: CompositionRunStartIntent,
  lastRenewedAtUnixMs: number,
) =>
  Effect.gen(function* () {
    const renewedAtUnixMs = Math.max(yield* Clock.currentTimeMillis, lastRenewedAtUnixMs);
    return yield* store.renewOwnerLease({
      runId: intent.runId,
      expectedRevision: intent.revision,
      claimId: intent.claimId ?? "",
      ownerEpoch: intent.ownerEpoch,
      renewedAtUnixMs,
      leaseExpiresAtUnixMs: renewedAtUnixMs + COMPOSITION_RUN_START_OWNER_LEASE_MS,
    });
  });

const renewCompositionRunStartOwnerLease = (
  store: CompositionRunStartExecutionStoreShape,
  intent: CompositionRunStartIntent,
) =>
  Effect.gen(function* () {
    let lastRenewedAtUnixMs = intent.updatedAtUnixMs;
    while (true) {
      yield* Effect.sleep(Duration.millis(COMPOSITION_RUN_START_OWNER_HEARTBEAT_MS));
      const renewed = yield* renewCompositionRunStartOwnerLeaseOnce(
        store,
        intent,
        lastRenewedAtUnixMs,
      );
      lastRenewedAtUnixMs = renewed.updatedAtUnixMs;
    }
  });

export const withCompositionRunStartOwnerLease = <A, E, R>(
  store: CompositionRunStartExecutionStoreShape,
  intent: CompositionRunStartIntent,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fencedIntent = yield* renewCompositionRunStartOwnerLeaseOnce(
      store,
      intent,
      intent.updatedAtUnixMs,
    );
    const result = yield* Effect.raceFirst(
      Effect.result(effect),
      renewCompositionRunStartOwnerLease(store, fencedIntent),
    );
    yield* renewCompositionRunStartOwnerLeaseOnce(
      store,
      fencedIntent,
      fencedIntent.updatedAtUnixMs,
    );
    return result;
  });
