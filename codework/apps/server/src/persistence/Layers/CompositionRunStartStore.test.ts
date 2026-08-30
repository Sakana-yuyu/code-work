import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CompositionRunStartStoreLive } from "./CompositionRunStartStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { CompositionRunStartStore } from "../Services/CompositionRunStartStore.ts";

const layer = it.layer(CompositionRunStartStoreLive.pipe(Layer.provide(SqlitePersistenceMemory)));

const makeIdentity = (suffix: string) => ({
  taskId: `task-run-start-store-${suffix}`,
  runId: `run-run-start-store-${suffix}-2`,
  previousRunId: `run-run-start-store-${suffix}-1`,
  agentId: `agent-run-start-store-${suffix}`,
  runtimeId: `runtime-run-start-store-${suffix}`,
  attempt: 2,
  payloadDigest: `sha256:payload-run-start-store-${suffix}`,
  capabilityDigest: `sha256:capability-run-start-store-${suffix}`,
});

layer("CompositionRunStartStore", (it) => {
  it.effect("相同身份可幂等准备，摘要冲突不能覆盖既有意图", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const identity = makeIdentity("prepare");
      const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
      const replayed = yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
      const conflict = yield* Effect.result(
        store.prepareStart({
          ...identity,
          payloadDigest: "sha256:changed-payload",
          createdAtUnixMs: 100,
        }),
      );

      assert.equal(prepared.state, "prepared");
      assert.equal(prepared.revision, 1);
      assert.deepEqual(replayed, prepared);
      assert.equal(conflict._tag, "Failure");
      if (conflict._tag === "Failure") {
        assert.equal(conflict.failure._tag, "CompositionRunStartStoreDomainError");
        if (conflict.failure._tag === "CompositionRunStartStoreDomainError") {
          assert.equal(conflict.failure.code, "run_start_identity_conflict");
        }
      }
    }),
  );

  it.effect("同一 task attempt 已绑定其他 runId 时返回稳定身份冲突", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const identity = makeIdentity("task-attempt-conflict");
      yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });

      const conflict = yield* Effect.result(
        store.prepareStart({
          ...identity,
          runId: `${identity.runId}-other`,
          createdAtUnixMs: 110,
        }),
      );

      assert.equal(conflict._tag, "Failure");
      if (conflict._tag === "Failure") {
        assert.equal(conflict.failure._tag, "CompositionRunStartStoreDomainError");
        if (conflict.failure._tag === "CompositionRunStartStoreDomainError") {
          assert.equal(conflict.failure.code, "run_start_identity_conflict");
        }
      }
    }),
  );

  it.effect("setup claim 只有一个赢家，中断后可由原 owner 释放", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const identity = makeIdentity("setup-claim");
      yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });

      const first = yield* store.claimPrepared({
        runId: identity.runId,
        expectedRevision: 1,
        claimId: "claim-setup-a",
        claimedAtUnixMs: 110,
      });
      const second = yield* store.claimPrepared({
        runId: identity.runId,
        expectedRevision: 1,
        claimId: "claim-setup-b",
        claimedAtUnixMs: 110,
      });
      const released = yield* store.releasePreparation({
        runId: identity.runId,
        expectedRevision: first.intent.revision,
        claimId: "claim-setup-a",
        releasedAtUnixMs: 120,
      });

      assert.isTrue(first.claimed);
      assert.equal(first.intent.state, "preparing");
      assert.equal(first.intent.claimId, "claim-setup-a");
      assert.isFalse(second.claimed);
      assert.equal(second.intent.claimId, "claim-setup-a");
      assert.equal(released.state, "prepared");
      assert.equal(released.claimId, null);
      assert.equal(released.revision, first.intent.revision + 1);
    }),
  );

  it.effect("dispatch recovery 通过 CAS 选出单一 owner，迟到者采用已结算赢家", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const identity = makeIdentity("dispatch-recovery");
      const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
      const setup = yield* store.claimPrepared({
        runId: identity.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-dispatch-original",
        claimedAtUnixMs: 110,
      });
      const dispatching = yield* store.markDispatching({
        runId: identity.runId,
        expectedRevision: setup.intent.revision,
        claimId: "claim-dispatch-original",
        dispatchedAtUnixMs: 120,
      });
      const firstRecovery = yield* store.claimDispatchRecovery({
        runId: identity.runId,
        expectedRevision: dispatching.revision,
        claimId: "claim-dispatch-recovery-a",
        claimedAtUnixMs: 130,
      });
      const secondRecovery = yield* store.claimDispatchRecovery({
        runId: identity.runId,
        expectedRevision: dispatching.revision,
        claimId: "claim-dispatch-recovery-b",
        claimedAtUnixMs: 130,
      });
      const accepted = yield* store.recordAccepted({
        runId: identity.runId,
        expectedRevision: firstRecovery.intent.revision,
        claimId: "claim-dispatch-recovery-a",
        runtimeTaskId: "runtime-task-run-start-store",
        capabilityHandshakeId: null,
        acceptedAtUnixMs: 140,
      });
      const settled = yield* store.settleAccepted({
        runId: identity.runId,
        expectedRevision: accepted.revision,
        settledAtUnixMs: 150,
      });
      const lateReceipt = yield* store.recordAccepted({
        runId: identity.runId,
        expectedRevision: dispatching.revision,
        claimId: "claim-dispatch-original",
        runtimeTaskId: "runtime-task-run-start-store",
        capabilityHandshakeId: null,
        acceptedAtUnixMs: 140,
      });

      assert.isTrue(firstRecovery.claimed);
      assert.isFalse(secondRecovery.claimed);
      assert.equal(secondRecovery.intent.claimId, "claim-dispatch-recovery-a");
      assert.equal(settled.state, "settled");
      assert.equal(settled.runtimeTaskId, "runtime-task-run-start-store");
      assert.deepEqual(lateReceipt, settled);
    }),
  );

  it.effect("不可安全恢复的意图进入可观察 quarantine 且不再参加自动扫描", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const identity = makeIdentity("quarantine");
      const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
      const quarantined = yield* store.quarantine({
        runId: identity.runId,
        expectedRevision: prepared.revision,
        outcomeCode: "run_start_legacy_input_capabilities_unknown",
        outcomeDetail: "旧加密输入无法确认 capabilityIds。",
        quarantinedAtUnixMs: 110,
      });

      assert.equal(quarantined.state, "quarantined");
      assert.equal(quarantined.outcomeCode, "run_start_legacy_input_capabilities_unknown");
      assert.isFalse(
        (yield* store.listRecoverable({ limit: 50 })).some(
          (intent) => intent.runId === identity.runId,
        ),
      );
    }),
  );

  it.effect("Driver 明确拒绝时以稳定结果码结算而不是进入 quarantine", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const identity = makeIdentity("rejected");
      const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
      const setup = yield* store.claimPrepared({
        runId: identity.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-rejected",
        claimedAtUnixMs: 110,
      });
      const dispatching = yield* store.markDispatching({
        runId: identity.runId,
        expectedRevision: setup.intent.revision,
        claimId: "claim-rejected",
        dispatchedAtUnixMs: 120,
      });
      const settled = yield* store.settleRejected({
        runId: identity.runId,
        expectedRevision: dispatching.revision,
        claimId: "claim-rejected",
        outcomeCode: "runtime_offline",
        outcomeDetail: "Runtime 当前离线。",
        settledAtUnixMs: 130,
      });

      assert.equal(settled.state, "settled");
      assert.equal(settled.outcomeCode, "runtime_offline");
      assert.isFalse(
        (yield* store.listRecoverable({ limit: 50 })).some(
          (intent) => intent.runId === identity.runId,
        ),
      );
    }),
  );
});
