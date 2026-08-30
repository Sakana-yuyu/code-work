// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import {
  type CompositionRunStartIntent,
  type CompositionRunStartStoreError,
  type CompositionRunStartStoreShape,
} from "../persistence/Services/CompositionRunStartStore.ts";

export type CompositionRunStartPayload = {
  readonly prompt: string;
  readonly workspaceRoot: string;
  readonly workspaceRootDigest?: string;
  readonly model?: string;
  readonly capabilityIds: ReadonlyArray<string>;
};

export type CompositionRunStartReceipt = {
  readonly runtimeTaskId?: string;
  readonly capabilityHandshakeId?: string;
};

const sha256 = (value: string): string =>
  `sha256:${NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex")}`;

export const makeCompositionRunStartDigests = (
  input: CompositionRunStartPayload,
): {
  readonly payloadDigest: string;
  readonly capabilityDigest: string;
  readonly capabilityIds: ReadonlyArray<string>;
} => {
  const capabilityIds = [...new Set(input.capabilityIds)].sort((left, right) =>
    left.localeCompare(right),
  );
  return {
    payloadDigest: sha256(
      JSON.stringify({
        prompt: input.prompt,
        workspaceRoot: input.workspaceRoot,
        workspaceRootDigest: input.workspaceRootDigest ?? null,
        model: input.model ?? null,
      }),
    ),
    capabilityDigest: sha256(JSON.stringify(capabilityIds)),
    capabilityIds,
  };
};

const monotonicNow = (intent: CompositionRunStartIntent) =>
  Clock.currentTimeMillis.pipe(Effect.map((now) => Math.max(now, intent.updatedAtUnixMs)));

export const makeCompositionRunStartLifecycle = (
  store: CompositionRunStartStoreShape,
  randomUUID: () => string = NodeCrypto.randomUUID,
) => {
  const claim = Effect.fn("CompositionRunStartLifecycle.claim")(function* (
    intent: CompositionRunStartIntent,
  ) {
    const claimedAtUnixMs = yield* monotonicNow(intent);
    return yield* store.claimStart({
      runId: intent.runId,
      expectedRevision: intent.revision,
      claimId: `run-start:${randomUUID()}`,
      claimedAtUnixMs,
    });
  });

  const release = Effect.fn("CompositionRunStartLifecycle.release")(function* (
    intent: CompositionRunStartIntent,
  ) {
    if (intent.claimId === null) return intent;
    const releasedAtUnixMs = yield* monotonicNow(intent);
    return yield* store.releaseStart({
      runId: intent.runId,
      expectedRevision: intent.revision,
      claimId: intent.claimId,
      releaseOperationId: `run-start-release:${randomUUID()}`,
      releasedAtUnixMs,
    });
  });

  const accept = Effect.fn("CompositionRunStartLifecycle.accept")(function* (
    intent: CompositionRunStartIntent,
    receipt: CompositionRunStartReceipt,
  ) {
    if (intent.claimId === null) {
      return yield* Effect.die(new Error("dispatching Run Start 缺少 claim owner"));
    }
    const acceptedAtUnixMs = yield* monotonicNow(intent);
    return yield* store.markAccepted({
      runId: intent.runId,
      expectedRevision: intent.revision,
      claimId: intent.claimId,
      ...(receipt.runtimeTaskId === undefined ? {} : { runtimeTaskId: receipt.runtimeTaskId }),
      ...(receipt.capabilityHandshakeId === undefined
        ? {}
        : { capabilityHandshakeId: receipt.capabilityHandshakeId }),
      acceptedAtUnixMs,
    });
  });

  const markIndeterminate = Effect.fn("CompositionRunStartLifecycle.markIndeterminate")(function* (
    intent: CompositionRunStartIntent,
    outcomeCode: string,
  ) {
    if (intent.claimId === null) {
      return yield* Effect.die(new Error("dispatching Run Start 缺少 claim owner"));
    }
    const indeterminateAtUnixMs = yield* monotonicNow(intent);
    return yield* store.markIndeterminate({
      runId: intent.runId,
      expectedRevision: intent.revision,
      claimId: intent.claimId,
      outcomeCode,
      indeterminateAtUnixMs,
    });
  });

  const settle = Effect.fn("CompositionRunStartLifecycle.settle")(function* (
    intent: CompositionRunStartIntent,
  ) {
    if (intent.claimId === null) {
      return yield* Effect.die(new Error("accepted Run Start 缺少 claim owner"));
    }
    const settledAtUnixMs = yield* monotonicNow(intent);
    return yield* store.settleStart({
      runId: intent.runId,
      expectedRevision: intent.revision,
      claimId: intent.claimId,
      settledAtUnixMs,
    });
  });

  return { claim, release, accept, markIndeterminate, settle } as const;
};

export type CompositionRunStartLifecycle = ReturnType<typeof makeCompositionRunStartLifecycle>;
export type CompositionRunStartLifecycleError = CompositionRunStartStoreError;
