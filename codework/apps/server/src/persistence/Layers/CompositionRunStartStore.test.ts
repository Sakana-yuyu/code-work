// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  CompositionRunStartIdentity,
  CompositionRunStartStore,
  CompositionRunStartStoreDomainError,
  type CompositionRunStartPrepareInput,
} from "../Services/CompositionRunStartStore.ts";
import { CompositionRunStartStoreLive } from "./CompositionRunStartStore.ts";
import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  CompositionRunStartStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const makeDigest = (hexCharacter: string): string => `sha256:${hexCharacter.repeat(64)}`;

const makePrepareInput = (
  runId: string,
  overrides: Partial<CompositionRunStartPrepareInput> = {},
): CompositionRunStartPrepareInput => ({
  runId,
  taskId: `task-${runId}`,
  agentId: `agent-${runId}`,
  runtimeId: `runtime-${runId}`,
  attempt: 2,
  replayPolicy: "fail_closed",
  payloadDigest: makeDigest("a"),
  capabilityDigest: makeDigest("b"),
  createdAtUnixMs: 100,
  ...overrides,
});

const isDomainError = Schema.is(CompositionRunStartStoreDomainError);
const decodeRunStartIdentity = Schema.decodeUnknownEffect(CompositionRunStartIdentity);
const errorCode = (error: unknown): string | undefined =>
  isDomainError(error) ? error.code : undefined;

const makeFileStoreLayer = (dbPath: string) =>
  CompositionRunStartStoreLive.pipe(
    Layer.provideMerge(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
  );

layer("CompositionRunStartStore", (it) => {
  it.effect("prepare 对完整身份摘要幂等，并拒绝 Run 或 task/attempt 身份漂移", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const input = makePrepareInput("run-start-prepare");

      const prepared = yield* store.prepareStart(input);
      const replayed = yield* store.prepareStart({ ...input, createdAtUnixMs: 999 });
      const payloadDrift = yield* store
        .prepareStart({ ...input, payloadDigest: makeDigest("c") })
        .pipe(Effect.flip);
      const capabilityDrift = yield* store
        .prepareStart({ ...input, capabilityDigest: makeDigest("d") })
        .pipe(Effect.flip);
      const taskAttemptDrift = yield* store
        .prepareStart(
          makePrepareInput("run-start-other", {
            taskId: input.taskId,
            attempt: input.attempt,
          }),
        )
        .pipe(Effect.flip);

      assert.deepEqual(prepared, {
        ...input,
        state: "prepared",
        revision: 1,
        claimId: null,
        claimedAtUnixMs: null,
        lastReleaseClaimId: null,
        lastReleaseOperationId: null,
        lastReleasedAtUnixMs: null,
        runtimeTaskId: null,
        capabilityHandshakeId: null,
        acceptedAtUnixMs: null,
        outcomeCode: null,
        settledAtUnixMs: null,
        updatedAtUnixMs: input.createdAtUnixMs,
      });
      assert.deepEqual(replayed, prepared);
      assert.equal(errorCode(payloadDrift), "run_start_identity_conflict");
      assert.equal(errorCode(capabilityDrift), "run_start_identity_conflict");
      assert.equal(errorCode(taskAttemptDrift), "run_start_identity_conflict");
    }),
  );

  it.effect("Service Schema 与 store 同时拒绝明文或非规范摘要", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const invalidInputs = [
        { payloadDigest: "请执行这个原始 prompt" },
        { capabilityDigest: '["filesystem.write"]' },
        { payloadDigest: "sk-live-not-a-real-key" },
        { payloadDigest: "sha256:payload" },
        { payloadDigest: `sha256:${"A".repeat(64)}` },
      ] as const;

      for (const [index, invalidDigest] of invalidInputs.entries()) {
        const input = makePrepareInput(`run-start-invalid-digest-${index}`, invalidDigest);
        assert.equal((yield* Effect.result(decodeRunStartIdentity(input)))._tag, "Failure");
        assert.equal(
          errorCode(yield* store.prepareStart(input).pipe(Effect.flip)),
          "run_start_input_invalid",
        );
      }
    }),
  );

  it.effect("claim 与 release 使用 revision 和 claim owner 做原子 CAS", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const input = makePrepareInput("run-start-claim-release");
      yield* store.prepareStart(input);

      const claimed = yield* store.claimStart({
        runId: input.runId,
        expectedRevision: 1,
        claimId: "claim-owner",
        claimedAtUnixMs: 110,
      });
      const replayedClaim = yield* store.claimStart({
        runId: input.runId,
        expectedRevision: 1,
        claimId: "claim-owner",
        claimedAtUnixMs: 110,
      });
      const competingClaim = yield* store.claimStart({
        runId: input.runId,
        expectedRevision: 1,
        claimId: "claim-other",
        claimedAtUnixMs: 111,
      });
      const wrongOwner = yield* store
        .releaseStart({
          runId: input.runId,
          expectedRevision: 2,
          claimId: "claim-other",
          releaseOperationId: "release-wrong-owner",
          releasedAtUnixMs: 120,
        })
        .pipe(Effect.flip);
      const releaseInput = {
        runId: input.runId,
        expectedRevision: 2,
        claimId: "claim-owner",
        releaseOperationId: "release-owner",
        releasedAtUnixMs: 120,
      } as const;
      const released = yield* store.releaseStart(releaseInput);
      const replayedRelease = yield* store.releaseStart(releaseInput);
      const releasedClaimReplay = yield* store
        .releaseStart({
          ...releaseInput,
          claimId: "claim-other",
        })
        .pipe(Effect.flip);
      const staleClaim = yield* store
        .claimStart({
          runId: input.runId,
          expectedRevision: 1,
          claimId: "claim-stale",
          claimedAtUnixMs: 130,
        })
        .pipe(Effect.flip);
      const staleTimestamp = yield* store
        .claimStart({
          runId: input.runId,
          expectedRevision: 3,
          claimId: "claim-stale-time",
          claimedAtUnixMs: 119,
        })
        .pipe(Effect.flip);
      const reclaimed = yield* store.claimStart({
        runId: input.runId,
        expectedRevision: 3,
        claimId: "claim-retry",
        claimedAtUnixMs: 130,
      });

      assert.isTrue(claimed.claimed);
      assert.equal(claimed.intent.state, "dispatching");
      assert.equal(claimed.intent.revision, 2);
      assert.isFalse(replayedClaim.claimed);
      assert.isFalse(competingClaim.claimed);
      assert.equal(competingClaim.intent.claimId, "claim-owner");
      assert.equal(errorCode(wrongOwner), "run_start_claim_conflict");
      assert.equal(released.state, "prepared");
      assert.equal(released.revision, 3);
      assert.isNull(released.claimId);
      assert.equal(released.lastReleaseClaimId, releaseInput.claimId);
      assert.equal(released.lastReleaseOperationId, releaseInput.releaseOperationId);
      assert.equal(released.lastReleasedAtUnixMs, releaseInput.releasedAtUnixMs);
      assert.deepEqual(replayedRelease, released);
      assert.equal(errorCode(releasedClaimReplay), "run_start_revision_conflict");
      assert.equal(errorCode(staleClaim), "run_start_revision_conflict");
      assert.equal(errorCode(staleTimestamp), "run_start_timestamp_conflict");
      assert.isTrue(reclaimed.claimed);
      assert.equal(reclaimed.intent.revision, 4);
    }),
  );

  it.effect("accepted receipt 只由 claim owner 写入，并在最终 settle 后可幂等读取", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const input = makePrepareInput("run-start-accepted");
      yield* store.prepareStart(input);
      yield* store.claimStart({
        runId: input.runId,
        expectedRevision: 1,
        claimId: "claim-accepted",
        claimedAtUnixMs: 110,
      });

      const wrongOwner = yield* store
        .markAccepted({
          runId: input.runId,
          expectedRevision: 2,
          claimId: "claim-other",
          runtimeTaskId: "runtime-task-other",
          acceptedAtUnixMs: 120,
        })
        .pipe(Effect.flip);
      const acceptedInput = {
        runId: input.runId,
        expectedRevision: 2,
        claimId: "claim-accepted",
        runtimeTaskId: "runtime-task-accepted",
        capabilityHandshakeId: "handshake-accepted",
        acceptedAtUnixMs: 120,
      } as const;
      const accepted = yield* store.markAccepted(acceptedInput);
      const replayed = yield* store.markAccepted(acceptedInput);
      const receiptDrift = yield* store
        .markAccepted({ ...acceptedInput, runtimeTaskId: "runtime-task-drift" })
        .pipe(Effect.flip);
      const wrongSettleOwner = yield* store
        .settleStart({
          runId: input.runId,
          expectedRevision: 3,
          claimId: "claim-other",
          settledAtUnixMs: 130,
        })
        .pipe(Effect.flip);
      const settled = yield* store.settleStart({
        runId: input.runId,
        expectedRevision: 3,
        claimId: "claim-accepted",
        settledAtUnixMs: 130,
      });
      const settledReplay = yield* store.settleStart({
        runId: input.runId,
        expectedRevision: 3,
        claimId: "claim-accepted",
        settledAtUnixMs: 130,
      });
      const acceptedReplayAfterSettle = yield* store.markAccepted(acceptedInput);

      assert.equal(errorCode(wrongOwner), "run_start_claim_conflict");
      assert.equal(accepted.state, "accepted");
      assert.equal(accepted.revision, 3);
      assert.equal(accepted.claimId, "claim-accepted");
      assert.deepEqual(replayed, accepted);
      assert.equal(errorCode(receiptDrift), "run_start_receipt_conflict");
      assert.equal(errorCode(wrongSettleOwner), "run_start_claim_conflict");
      assert.equal(settled.state, "settled");
      assert.equal(settled.revision, 4);
      assert.equal(settled.settledAtUnixMs, 130);
      assert.deepEqual(settledReplay, settled);
      assert.deepEqual(acceptedReplayAfterSettle, settled);
    }),
  );

  it.effect("release receipt 在响应丢失后可幂等回读，且不能跨 Run 复用", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const first = makePrepareInput("run-start-release-owner");
      const second = makePrepareInput("run-start-release-contender");
      yield* store.prepareStart(first);
      yield* store.prepareStart(second);
      yield* store.claimStart({
        runId: first.runId,
        expectedRevision: 1,
        claimId: "claim-release-owner",
        claimedAtUnixMs: 110,
      });
      yield* store.claimStart({
        runId: second.runId,
        expectedRevision: 1,
        claimId: "claim-release-contender",
        claimedAtUnixMs: 110,
      });

      const releaseInput = {
        runId: first.runId,
        expectedRevision: 2,
        claimId: "claim-release-owner",
        releaseOperationId: "release-operation-global",
        releasedAtUnixMs: 120,
      } as const;
      const released = yield* store.releaseStart(releaseInput);
      const replayed = yield* store.releaseStart(releaseInput);
      const conflict = yield* store
        .releaseStart({
          runId: second.runId,
          expectedRevision: 2,
          claimId: "claim-release-contender",
          releaseOperationId: "release-operation-global",
          releasedAtUnixMs: 121,
        })
        .pipe(Effect.flip);

      assert.deepEqual(replayed, released);
      assert.equal(errorCode(conflict), "run_start_release_conflict");
      assert.equal(Option.getOrThrow(yield* store.getStart(second.runId)).state, "dispatching");
    }),
  );

  it.effect("claimId 与 runtime receipt 不能跨 Run 复用，并返回稳定冲突码", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const first = makePrepareInput("run-start-global-owner", {
        runtimeId: "runtime-shared-receipt",
      });
      const second = makePrepareInput("run-start-global-contender", {
        runtimeId: "runtime-shared-receipt",
      });
      yield* store.prepareStart(first);
      yield* store.prepareStart(second);
      yield* store.claimStart({
        runId: first.runId,
        expectedRevision: 1,
        claimId: "claim-global-unique",
        claimedAtUnixMs: 110,
      });

      const duplicateClaim = yield* store
        .claimStart({
          runId: second.runId,
          expectedRevision: 1,
          claimId: "claim-global-unique",
          claimedAtUnixMs: 110,
        })
        .pipe(Effect.flip);
      const secondClaim = yield* store.claimStart({
        runId: second.runId,
        expectedRevision: 1,
        claimId: "claim-global-second",
        claimedAtUnixMs: 111,
      });
      yield* store.markAccepted({
        runId: first.runId,
        expectedRevision: 2,
        claimId: "claim-global-unique",
        runtimeTaskId: "runtime-task-global-unique",
        acceptedAtUnixMs: 120,
      });
      const duplicateReceipt = yield* store
        .markAccepted({
          runId: second.runId,
          expectedRevision: 2,
          claimId: "claim-global-second",
          runtimeTaskId: "runtime-task-global-unique",
          acceptedAtUnixMs: 121,
        })
        .pipe(Effect.flip);

      assert.equal(errorCode(duplicateClaim), "run_start_claim_conflict");
      if (isDomainError(duplicateClaim)) assert.equal(duplicateClaim.runId, second.runId);
      assert.isTrue(secondClaim.claimed);
      assert.equal(errorCode(duplicateReceipt), "run_start_receipt_conflict");
      assert.equal(Option.getOrThrow(yield* store.getStart(second.runId)).state, "dispatching");
    }),
  );

  it.effect("不确定结果以稳定结果码 fail-closed，不能再 release、accepted 或 settle", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const input = makePrepareInput("run-start-indeterminate", {
        replayPolicy: "reconcile",
      });
      yield* store.prepareStart(input);
      yield* store.claimStart({
        runId: input.runId,
        expectedRevision: 1,
        claimId: "claim-indeterminate",
        claimedAtUnixMs: 110,
      });

      const indeterminateInput = {
        runId: input.runId,
        expectedRevision: 2,
        claimId: "claim-indeterminate",
        outcomeCode: "driver_acceptance_unknown_after_restart",
        indeterminateAtUnixMs: 120,
      } as const;
      const wrongOwner = yield* store
        .markIndeterminate({ ...indeterminateInput, claimId: "claim-other" })
        .pipe(Effect.flip);
      const indeterminate = yield* store.markIndeterminate(indeterminateInput);
      const replayed = yield* store.markIndeterminate(indeterminateInput);
      const release = yield* store
        .releaseStart({
          runId: input.runId,
          expectedRevision: 3,
          claimId: "claim-indeterminate",
          releaseOperationId: "release-indeterminate",
          releasedAtUnixMs: 130,
        })
        .pipe(Effect.flip);
      const accepted = yield* store
        .markAccepted({
          runId: input.runId,
          expectedRevision: 3,
          claimId: "claim-indeterminate",
          acceptedAtUnixMs: 130,
        })
        .pipe(Effect.flip);
      const settled = yield* store
        .settleStart({
          runId: input.runId,
          expectedRevision: 3,
          claimId: "claim-indeterminate",
          settledAtUnixMs: 130,
        })
        .pipe(Effect.flip);

      assert.equal(indeterminate.state, "indeterminate");
      assert.equal(indeterminate.revision, 3);
      assert.equal(indeterminate.outcomeCode, indeterminateInput.outcomeCode);
      assert.deepEqual(replayed, indeterminate);
      assert.equal(errorCode(wrongOwner), "run_start_claim_conflict");
      assert.equal(errorCode(release), "run_start_state_conflict");
      assert.equal(errorCode(accepted), "run_start_state_conflict");
      assert.equal(errorCode(settled), "run_start_state_conflict");
    }),
  );

  it.effect("持久化层只保存摘要和稳定结果码，不保存原始 prompt、能力或密钥", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const sql = yield* SqlClient.SqlClient;
      const input = makePrepareInput("run-start-redaction", {
        payloadDigest: makeDigest("e"),
        capabilityDigest: makeDigest("f"),
      });
      yield* store.prepareStart(input);

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info('composition_run_start_intents')
      `;
      const rows = yield* sql<Record<string, unknown>>`
        SELECT * FROM composition_run_start_intents WHERE run_id = ${input.runId}
      `;
      const names = new Set(columns.map((column) => column.name));
      const serialized = Object.values(rows[0] ?? {}).join("\n");

      assert.isFalse(names.has("prompt"));
      assert.isFalse(names.has("payload_json"));
      assert.isFalse(names.has("capability_ids_json"));
      assert.isFalse(names.has("workspace_root"));
      assert.include(serialized, input.payloadDigest);
      assert.include(serialized, input.capabilityDigest);
      assert.notInclude(serialized, "sk-live-never-persist");
      assert.notInclude(serialized, "E:/private/workspace");
    }),
  );
});

it.effect("同一 SQLite 文件重建 Layer 后保持 claim，双连接并发只有一个赢家", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codework-run-start-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const input = makePrepareInput("run-start-file-claim");
  const claimFromConnection = (claimId: string) =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      return yield* store.claimStart({
        runId: input.runId,
        expectedRevision: 1,
        claimId,
        claimedAtUnixMs: 110,
      });
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      yield* store.prepareStart(input);
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));

    const beforeClaim = yield* Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      return Option.getOrThrow(yield* store.getStart(input.runId));
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));
    assert.equal(beforeClaim.state, "prepared");

    const claims = yield* Effect.all(
      [claimFromConnection("claim-file-a"), claimFromConnection("claim-file-b")],
      { concurrency: "unbounded" },
    );
    assert.deepEqual(claims.map((claim) => claim.claimed).sort(), [false, true]);
    assert.isTrue(claims.every((claim) => claim.intent.state === "dispatching"));
    assert.equal(new Set(claims.map((claim) => claim.intent.claimId)).size, 1);

    const restored = yield* Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      return Option.getOrThrow(yield* store.getStart(input.runId));
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));
    assert.equal(restored.state, "dispatching");
    assert.equal(restored.revision, 2);
    assert.include(["claim-file-a", "claim-file-b"], restored.claimId);
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("accepted 与 release 跨连接竞争时只允许一个 CAS 终态胜出", () => {
  const tempDir = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "codework-run-start-terminal-race-"),
  );
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const input = makePrepareInput("run-start-terminal-race");

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      yield* store.prepareStart(input);
      yield* store.claimStart({
        runId: input.runId,
        expectedRevision: 1,
        claimId: "claim-terminal-race",
        claimedAtUnixMs: 110,
      });
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));

    const [accepted, released] = yield* Effect.all(
      [
        Effect.gen(function* () {
          const store = yield* CompositionRunStartStore;
          return yield* store.markAccepted({
            runId: input.runId,
            expectedRevision: 2,
            claimId: "claim-terminal-race",
            runtimeTaskId: "runtime-task-terminal-race",
            acceptedAtUnixMs: 120,
          });
        }).pipe(Effect.provide(makeFileStoreLayer(dbPath)), Effect.result),
        Effect.gen(function* () {
          const store = yield* CompositionRunStartStore;
          return yield* store.releaseStart({
            runId: input.runId,
            expectedRevision: 2,
            claimId: "claim-terminal-race",
            releaseOperationId: "release-terminal-race",
            releasedAtUnixMs: 120,
          });
        }).pipe(Effect.provide(makeFileStoreLayer(dbPath)), Effect.result),
      ],
      { concurrency: "unbounded" },
    );
    const restored = yield* Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      return Option.getOrThrow(yield* store.getStart(input.runId));
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));

    assert.equal([accepted, released].filter((result) => result._tag === "Success").length, 1);
    assert.include(["accepted", "prepared"], restored.state);
    assert.equal(restored.revision, 3);
    if (restored.state === "accepted") {
      assert.equal(accepted._tag, "Success");
      assert.equal(released._tag, "Failure");
    } else {
      assert.equal(accepted._tag, "Failure");
      assert.equal(released._tag, "Success");
    }
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
