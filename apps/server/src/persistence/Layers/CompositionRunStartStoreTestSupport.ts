import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CompositionRunStartStore } from "../Services/CompositionRunStartStore.ts";
import { CompositionRunStartStoreLive } from "./CompositionRunStartStore.ts";
import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "./Sqlite.ts";

export const runStartStoreLayer = it.layer(
  CompositionRunStartStoreLive.pipe(Layer.provide(SqlitePersistenceMemory)),
);

export const makeFileStoreLayer = (dbPath: string) =>
  CompositionRunStartStoreLive.pipe(
    Layer.provideMerge(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
  );

export const makeIdentity = (suffix: string) => ({
  taskId: `task-run-start-store-${suffix}`,
  runId: `run-run-start-store-${suffix}-2`,
  previousRunId: `run-run-start-store-${suffix}-1`,
  agentId: `agent-run-start-store-${suffix}`,
  runtimeId: `runtime-run-start-store-${suffix}`,
  attempt: 2,
  payloadDigest: `sha256:payload-run-start-store-${suffix}`,
  capabilityDigest: `sha256:capability-run-start-store-${suffix}`,
});

export const prepareAcceptedIntent = (suffix: string, leaseExpiresAtUnixMs = 1_000) =>
  Effect.gen(function* () {
    const store = yield* CompositionRunStartStore;
    const identity = makeIdentity(suffix);
    const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
    const setup = yield* store.claimPrepared({
      runId: identity.runId,
      expectedRevision: prepared.revision,
      claimId: `claim-${suffix}`,
      claimedAtUnixMs: 110,
      leaseExpiresAtUnixMs,
    });
    const dispatching = yield* store.markDispatching({
      runId: identity.runId,
      expectedRevision: setup.intent.revision,
      claimId: setup.intent.claimId ?? "",
      ownerEpoch: setup.intent.ownerEpoch,
      dispatchedAtUnixMs: 120,
    });
    return yield* store.recordAccepted({
      runId: identity.runId,
      expectedRevision: dispatching.revision,
      claimId: dispatching.claimId ?? "",
      ownerEpoch: dispatching.ownerEpoch,
      runtimeTaskId: `runtime-task-${suffix}`,
      capabilityHandshakeId: `handshake-${suffix}`,
      acceptedAtUnixMs: 130,
    });
  });
