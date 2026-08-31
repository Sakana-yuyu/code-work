// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CompositionRunStartStore } from "../Services/CompositionRunStartStore.ts";
import { makeFileStoreLayer, makeIdentity } from "./CompositionRunStartStoreTestSupport.ts";

it.effect("同一 SQLite 文件中第一运行时关闭后重建的运行时仍可读回可恢复 dispatching 意图", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codework-run-start-reopen-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const identity = makeIdentity("runtime-reopen");

  const persistDispatchingIntent = Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(makeFileStoreLayer(dbPath));
      const store = Context.get(context, CompositionRunStartStore);
      const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
      const claimed = yield* store.claimPrepared({
        runId: identity.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-runtime-reopen",
        claimedAtUnixMs: 110,
        leaseExpiresAtUnixMs: 210,
      });
      return yield* store.markDispatching({
        runId: identity.runId,
        expectedRevision: claimed.intent.revision,
        claimId: claimed.intent.claimId ?? "",
        ownerEpoch: claimed.intent.ownerEpoch,
        dispatchedAtUnixMs: 120,
      });
    }),
  );

  const readRecoverableIntents = Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(makeFileStoreLayer(dbPath));
      const store = Context.get(context, CompositionRunStartStore);
      return yield* store.listRecoverable({ limit: 50 });
    }),
  );

  return Effect.gen(function* () {
    const dispatching = yield* persistDispatchingIntent;
    const recoverable = yield* readRecoverableIntents;

    assert.deepEqual(recoverable, [dispatching]);
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("不同 SQLite 连接分页时已处理行更新时间变化不会重复或遗漏候选", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codework-run-start-scan-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const identities = Array.from({ length: 201 }, (_, index) =>
    makeIdentity(`stable-scan-${String(index + 1).padStart(3, "0")}`),
  );
  const withFileStore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(makeFileStoreLayer(dbPath)));

  return Effect.gen(function* () {
    yield* withFileStore(
      Effect.gen(function* () {
        const store = yield* CompositionRunStartStore;
        for (const identity of identities) {
          yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
        }
      }),
    );

    const scanUpperBound = yield* withFileStore(
      Effect.gen(function* () {
        const store = yield* CompositionRunStartStore;
        return yield* store.getRecoverableScanUpperBound;
      }),
    );
    const throughRunId = Option.getOrThrow(scanUpperBound);
    const firstPage = yield* withFileStore(
      Effect.gen(function* () {
        const store = yield* CompositionRunStartStore;
        return yield* store.listRecoverable({ limit: 200, throughRunId });
      }),
    );
    assert.equal(firstPage.length, 200);

    const moved = firstPage[0];
    assert.isDefined(moved);
    yield* withFileStore(
      Effect.gen(function* () {
        const store = yield* CompositionRunStartStore;
        const claimed = yield* store.claimPrepared({
          runId: moved!.runId,
          expectedRevision: moved!.revision,
          claimId: "claim-stable-scan-mutator",
          claimedAtUnixMs: 110,
          leaseExpiresAtUnixMs: 15_000,
        });
        const dispatching = yield* store.markDispatching({
          runId: moved!.runId,
          expectedRevision: claimed.intent.revision,
          claimId: claimed.intent.claimId ?? "",
          ownerEpoch: claimed.intent.ownerEpoch,
          dispatchedAtUnixMs: 120,
        });
        yield* store.renewOwnerLease({
          runId: moved!.runId,
          expectedRevision: dispatching.revision,
          claimId: dispatching.claimId ?? "",
          ownerEpoch: dispatching.ownerEpoch,
          renewedAtUnixMs: 10_000,
          leaseExpiresAtUnixMs: 20_000,
        });
      }),
    );

    const lastFirstPage = firstPage.at(-1);
    assert.isDefined(lastFirstPage);
    const secondPage = yield* withFileStore(
      Effect.gen(function* () {
        const store = yield* CompositionRunStartStore;
        return yield* store.listRecoverable({
          limit: 200,
          throughRunId,
          after: { runId: lastFirstPage!.runId },
        });
      }),
    );
    const scannedRunIds = [...firstPage, ...secondPage].map((intent) => intent.runId);

    assert.equal(secondPage.length, 1);
    assert.equal(scannedRunIds.length, 201);
    assert.equal(new Set(scannedRunIds).size, 201);
    assert.deepEqual(
      scannedRunIds.toSorted(),
      identities.map((identity) => identity.runId).toSorted(),
    );
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
