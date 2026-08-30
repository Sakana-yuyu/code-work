// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CompositionRunStartStoreLive } from "./CompositionRunStartStore.ts";
import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "./Sqlite.ts";
import { CompositionRunStartStore } from "../Services/CompositionRunStartStore.ts";

const layer = it.layer(CompositionRunStartStoreLive.pipe(Layer.provide(SqlitePersistenceMemory)));

const makeFileStoreLayer = (dbPath: string) =>
  CompositionRunStartStoreLive.pipe(
    Layer.provideMerge(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
  );

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
        ownerEpoch: first.intent.ownerEpoch,
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

  it.effect("活跃 dispatching owner 不得被 recovery takeover", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const identity = makeIdentity("dispatch-recovery");
      const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
      const setup = yield* store.claimPrepared({
        runId: identity.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-dispatch-original",
        claimedAtUnixMs: 110,
        leaseExpiresAtUnixMs: 1_000,
      });
      const dispatching = yield* store.markDispatching({
        runId: identity.runId,
        expectedRevision: setup.intent.revision,
        claimId: "claim-dispatch-original",
        ownerEpoch: setup.intent.ownerEpoch,
        dispatchedAtUnixMs: 120,
      });
      const firstRecovery = yield* store.claimDispatchRecovery({
        runId: identity.runId,
        expectedRevision: dispatching.revision,
        claimId: "claim-dispatch-recovery-a",
        claimedAtUnixMs: 130,
        leaseExpiresAtUnixMs: 1_130,
      });
      const secondRecovery = yield* store.claimDispatchRecovery({
        runId: identity.runId,
        expectedRevision: dispatching.revision,
        claimId: "claim-dispatch-recovery-b",
        claimedAtUnixMs: 130,
        leaseExpiresAtUnixMs: 1_130,
      });
      const accepted = yield* store.recordAccepted({
        runId: identity.runId,
        expectedRevision: dispatching.revision,
        claimId: "claim-dispatch-original",
        ownerEpoch: dispatching.ownerEpoch,
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
        ownerEpoch: dispatching.ownerEpoch,
        runtimeTaskId: "runtime-task-run-start-store",
        capabilityHandshakeId: null,
        acceptedAtUnixMs: 140,
      });

      assert.isFalse(firstRecovery.claimed);
      assert.isFalse(secondRecovery.claimed);
      assert.equal(secondRecovery.intent.claimId, "claim-dispatch-original");
      assert.equal(settled.state, "settled");
      assert.equal(settled.runtimeTaskId, "runtime-task-run-start-store");
      assert.deepEqual(lateReceipt, settled);
    }),
  );

  it.effect(
    "到期 dispatch owner 只有一个 recovery claimant 获得新 epoch，旧 receipt 不能覆盖它",
    () =>
      Effect.gen(function* () {
        const store = yield* CompositionRunStartStore;
        const identity = makeIdentity("dispatch-recovery-expired");
        const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
        const setup = yield* store.claimPrepared({
          runId: identity.runId,
          expectedRevision: prepared.revision,
          claimId: "claim-dispatch-expired-original",
          claimedAtUnixMs: 110,
          leaseExpiresAtUnixMs: 120,
        });
        const dispatching = yield* store.markDispatching({
          runId: identity.runId,
          expectedRevision: setup.intent.revision,
          claimId: setup.intent.claimId ?? "",
          ownerEpoch: setup.intent.ownerEpoch,
          dispatchedAtUnixMs: 115,
        });
        const firstRecovery = yield* store.claimDispatchRecovery({
          runId: identity.runId,
          expectedRevision: dispatching.revision,
          claimId: "claim-dispatch-expired-recovery-a",
          claimedAtUnixMs: 121,
          leaseExpiresAtUnixMs: 221,
        });
        const secondRecovery = yield* store.claimDispatchRecovery({
          runId: identity.runId,
          expectedRevision: dispatching.revision,
          claimId: "claim-dispatch-expired-recovery-b",
          claimedAtUnixMs: 121,
          leaseExpiresAtUnixMs: 221,
        });
        const lateAccepted = yield* Effect.result(
          store.recordAccepted({
            runId: identity.runId,
            expectedRevision: dispatching.revision,
            claimId: dispatching.claimId ?? "",
            ownerEpoch: dispatching.ownerEpoch,
            runtimeTaskId: "runtime-task-stale-owner",
            capabilityHandshakeId: null,
            acceptedAtUnixMs: 122,
          }),
        );
        const lateRejected = yield* Effect.result(
          store.settleRejected({
            runId: identity.runId,
            expectedRevision: dispatching.revision,
            claimId: dispatching.claimId ?? "",
            ownerEpoch: dispatching.ownerEpoch,
            outcomeCode: "runtime_offline",
            outcomeDetail: "旧 owner 的迟到拒绝。",
            settledAtUnixMs: 122,
          }),
        );

        assert.isTrue(firstRecovery.claimed);
        assert.isFalse(secondRecovery.claimed);
        assert.equal(firstRecovery.intent.ownerEpoch, dispatching.ownerEpoch + 1);
        assert.equal(firstRecovery.intent.claimId, "claim-dispatch-expired-recovery-a");
        assert.equal(secondRecovery.intent.ownerEpoch, firstRecovery.intent.ownerEpoch);
        assert.equal(lateAccepted._tag, "Failure");
        assert.equal(lateRejected._tag, "Failure");
        assert.deepEqual(
          Option.getOrThrow(yield* store.getStart(identity.runId)),
          firstRecovery.intent,
        );
        const accepted = yield* store.recordAccepted({
          runId: identity.runId,
          expectedRevision: firstRecovery.intent.revision,
          claimId: firstRecovery.intent.claimId ?? "",
          ownerEpoch: firstRecovery.intent.ownerEpoch,
          runtimeTaskId: "runtime-task-new-owner",
          capabilityHandshakeId: null,
          acceptedAtUnixMs: 123,
        });
        const repeatedOldAccepted = yield* Effect.result(
          store.recordAccepted({
            runId: identity.runId,
            expectedRevision: dispatching.revision,
            claimId: dispatching.claimId ?? "",
            ownerEpoch: dispatching.ownerEpoch,
            runtimeTaskId: "runtime-task-new-owner",
            capabilityHandshakeId: null,
            acceptedAtUnixMs: 124,
          }),
        );
        assert.equal(accepted.ownerEpoch, firstRecovery.intent.ownerEpoch);
        assert.equal(repeatedOldAccepted._tag, "Failure");
      }),
  );

  it.effect("新 owner 已拒绝后旧 epoch 的同值 rejected receipt 仍必须失败", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const identity = makeIdentity("dispatch-recovery-rejected-receipt");
      const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
      const setup = yield* store.claimPrepared({
        runId: identity.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-rejected-original",
        claimedAtUnixMs: 110,
        leaseExpiresAtUnixMs: 120,
      });
      const dispatching = yield* store.markDispatching({
        runId: identity.runId,
        expectedRevision: setup.intent.revision,
        claimId: setup.intent.claimId ?? "",
        ownerEpoch: setup.intent.ownerEpoch,
        dispatchedAtUnixMs: 115,
      });
      const recovery = yield* store.claimDispatchRecovery({
        runId: identity.runId,
        expectedRevision: dispatching.revision,
        claimId: "claim-rejected-recovery",
        claimedAtUnixMs: 121,
        leaseExpiresAtUnixMs: 221,
      });
      const rejected = yield* store.settleRejected({
        runId: identity.runId,
        expectedRevision: recovery.intent.revision,
        claimId: recovery.intent.claimId ?? "",
        ownerEpoch: recovery.intent.ownerEpoch,
        outcomeCode: "runtime_offline",
        outcomeDetail: "新 owner 的拒绝。",
        settledAtUnixMs: 122,
      });
      const repeatedOldRejected = yield* Effect.result(
        store.settleRejected({
          runId: identity.runId,
          expectedRevision: dispatching.revision,
          claimId: dispatching.claimId ?? "",
          ownerEpoch: dispatching.ownerEpoch,
          outcomeCode: "runtime_offline",
          outcomeDetail: "新 owner 的拒绝。",
          settledAtUnixMs: 123,
        }),
      );

      assert.equal(rejected.ownerEpoch, recovery.intent.ownerEpoch);
      assert.equal(repeatedOldRejected._tag, "Failure");
      assert.deepEqual(Option.getOrThrow(yield* store.getStart(identity.runId)), rejected);
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

  it.effect("活跃 owner 的 quarantine 必须由当前 claim、epoch 和未到期 lease 共同围栏", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const identity = makeIdentity("quarantine-owner-fencing");
      const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
      const setup = yield* store.claimPrepared({
        runId: identity.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-quarantine-original",
        claimedAtUnixMs: 110,
        leaseExpiresAtUnixMs: 1_000,
      });
      const dispatching = yield* store.markDispatching({
        runId: identity.runId,
        expectedRevision: setup.intent.revision,
        claimId: setup.intent.claimId ?? "",
        ownerEpoch: setup.intent.ownerEpoch,
        dispatchedAtUnixMs: 120,
      });

      const attempts = yield* Effect.all(
        [
          Effect.result(
            store.quarantine({
              runId: identity.runId,
              expectedRevision: dispatching.revision,
              claimId: "claim-quarantine-wrong",
              ownerEpoch: dispatching.ownerEpoch,
              outcomeCode: "run_start_manual_recovery_required",
              outcomeDetail: "错误 claim 不得终止活跃 owner。",
              quarantinedAtUnixMs: 130,
            }),
          ),
          Effect.result(
            store.quarantine({
              runId: identity.runId,
              expectedRevision: dispatching.revision,
              claimId: dispatching.claimId ?? "",
              ownerEpoch: dispatching.ownerEpoch + 1,
              outcomeCode: "run_start_manual_recovery_required",
              outcomeDetail: "错误 epoch 不得终止活跃 owner。",
              quarantinedAtUnixMs: 130,
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );

      assert.deepEqual(
        attempts.map((attempt) => attempt._tag),
        ["Failure", "Failure"],
      );
      assert.deepEqual(Option.getOrThrow(yield* store.getStart(identity.runId)), dispatching);
    }),
  );

  it.effect("到期后只有 recovery 新 owner 可以 quarantine，旧 owner 的迟到终止必须失败", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const identity = makeIdentity("quarantine-recovery-owner");
      const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
      const setup = yield* store.claimPrepared({
        runId: identity.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-quarantine-expired-original",
        claimedAtUnixMs: 110,
        leaseExpiresAtUnixMs: 120,
      });
      const dispatching = yield* store.markDispatching({
        runId: identity.runId,
        expectedRevision: setup.intent.revision,
        claimId: setup.intent.claimId ?? "",
        ownerEpoch: setup.intent.ownerEpoch,
        dispatchedAtUnixMs: 115,
      });
      const recovery = yield* store.claimDispatchRecovery({
        runId: identity.runId,
        expectedRevision: dispatching.revision,
        claimId: "claim-quarantine-expired-recovery",
        claimedAtUnixMs: 121,
        leaseExpiresAtUnixMs: 221,
      });

      const lateOriginal = yield* Effect.result(
        store.quarantine({
          runId: identity.runId,
          expectedRevision: recovery.intent.revision,
          claimId: dispatching.claimId ?? "",
          ownerEpoch: dispatching.ownerEpoch,
          outcomeCode: "run_start_manual_recovery_required",
          outcomeDetail: "旧 owner 不能终止 recovery owner。",
          quarantinedAtUnixMs: 130,
        }),
      );
      const quarantined = yield* store.quarantine({
        runId: identity.runId,
        expectedRevision: recovery.intent.revision,
        claimId: recovery.intent.claimId ?? "",
        ownerEpoch: recovery.intent.ownerEpoch,
        outcomeCode: "run_start_manual_recovery_required",
        outcomeDetail: "新 owner 已确认需要人工恢复。",
        quarantinedAtUnixMs: 130,
      });

      assert.equal(lateOriginal._tag, "Failure");
      assert.equal(quarantined.state, "quarantined");
      assert.equal(quarantined.ownerEpoch, recovery.intent.ownerEpoch);
    }),
  );

  it.effect("零时长 owner lease 必须被拒绝", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const identity = makeIdentity("zero-duration-lease");
      const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
      const zeroLease = yield* Effect.result(
        store.claimPrepared({
          runId: identity.runId,
          expectedRevision: prepared.revision,
          claimId: "claim-zero-duration",
          claimedAtUnixMs: 110,
          leaseExpiresAtUnixMs: 110,
        }),
      );

      assert.equal(zeroLease._tag, "Failure");
      assert.deepEqual(Option.getOrThrow(yield* store.getStart(identity.runId)), prepared);
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
        ownerEpoch: setup.intent.ownerEpoch,
        dispatchedAtUnixMs: 120,
      });
      const settled = yield* store.settleRejected({
        runId: identity.runId,
        expectedRevision: dispatching.revision,
        claimId: "claim-rejected",
        ownerEpoch: dispatching.ownerEpoch,
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

  it.effect("拒绝已结算后迟到的空 receipt 不得触发接受投影", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const identity = makeIdentity("late-accepted-after-rejected");
      const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
      const setup = yield* store.claimPrepared({
        runId: identity.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-late-accepted-after-rejected",
        claimedAtUnixMs: 110,
      });
      const dispatching = yield* store.markDispatching({
        runId: identity.runId,
        expectedRevision: setup.intent.revision,
        claimId: "claim-late-accepted-after-rejected",
        ownerEpoch: setup.intent.ownerEpoch,
        dispatchedAtUnixMs: 120,
      });
      const rejected = yield* store.settleRejected({
        runId: identity.runId,
        expectedRevision: dispatching.revision,
        claimId: "claim-late-accepted-after-rejected",
        ownerEpoch: dispatching.ownerEpoch,
        outcomeCode: "runtime_offline",
        outcomeDetail: "Runtime 当前离线。",
        settledAtUnixMs: 130,
      });
      let acceptedProjectionCount = 0;
      const lateAccepted = yield* Effect.result(
        store
          .recordAccepted({
            runId: identity.runId,
            expectedRevision: dispatching.revision,
            claimId: "claim-late-accepted-after-rejected",
            ownerEpoch: dispatching.ownerEpoch,
            runtimeTaskId: null,
            capabilityHandshakeId: null,
            acceptedAtUnixMs: 140,
          })
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                acceptedProjectionCount += 1;
              }),
            ),
          ),
      );

      assert.equal(lateAccepted._tag, "Failure");
      if (lateAccepted._tag === "Failure") {
        assert.equal(lateAccepted.failure._tag, "CompositionRunStartStoreDomainError");
        if (lateAccepted.failure._tag === "CompositionRunStartStoreDomainError") {
          assert.equal(lateAccepted.failure.code, "run_start_receipt_conflict");
        }
      }
      assert.equal(acceptedProjectionCount, 0);
      assert.deepEqual(Option.getOrThrow(yield* store.getStart(identity.runId)), rejected);
    }),
  );

  it.effect("拒绝已结算后 settleAccepted 返回稳定状态冲突", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const identity = makeIdentity("settle-accepted-after-rejected");
      const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
      const setup = yield* store.claimPrepared({
        runId: identity.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-settle-accepted-after-rejected",
        claimedAtUnixMs: 110,
      });
      const dispatching = yield* store.markDispatching({
        runId: identity.runId,
        expectedRevision: setup.intent.revision,
        claimId: "claim-settle-accepted-after-rejected",
        ownerEpoch: setup.intent.ownerEpoch,
        dispatchedAtUnixMs: 120,
      });
      const rejected = yield* store.settleRejected({
        runId: identity.runId,
        expectedRevision: dispatching.revision,
        claimId: "claim-settle-accepted-after-rejected",
        ownerEpoch: dispatching.ownerEpoch,
        outcomeCode: "runtime_offline",
        outcomeDetail: "Runtime 当前离线。",
        settledAtUnixMs: 130,
      });
      const lateSettled = yield* Effect.result(
        store.settleAccepted({
          runId: identity.runId,
          expectedRevision: rejected.revision,
          settledAtUnixMs: 140,
        }),
      );

      assert.equal(lateSettled._tag, "Failure");
      if (lateSettled._tag === "Failure") {
        assert.equal(lateSettled.failure._tag, "CompositionRunStartStoreDomainError");
        if (lateSettled.failure._tag === "CompositionRunStartStoreDomainError") {
          assert.equal(lateSettled.failure.code, "run_start_state_conflict");
        }
      }
      assert.deepEqual(Option.getOrThrow(yield* store.getStart(identity.runId)), rejected);
    }),
  );

  it.effect("系统时钟回拨不阻断接受链路且 updatedAt 保持单调", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const identity = makeIdentity("clock-rollback-accepted");
      const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 1_000 });
      const setup = yield* store.claimPrepared({
        runId: identity.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-clock-rollback-original",
        claimedAtUnixMs: 900,
      });
      const dispatching = yield* store.markDispatching({
        runId: identity.runId,
        expectedRevision: setup.intent.revision,
        claimId: "claim-clock-rollback-original",
        ownerEpoch: setup.intent.ownerEpoch,
        dispatchedAtUnixMs: 800,
      });
      const accepted = yield* store.recordAccepted({
        runId: identity.runId,
        expectedRevision: dispatching.revision,
        claimId: "claim-clock-rollback-original",
        ownerEpoch: dispatching.ownerEpoch,
        runtimeTaskId: "runtime-task-clock-rollback",
        capabilityHandshakeId: null,
        acceptedAtUnixMs: 600,
      });
      const settled = yield* store.settleAccepted({
        runId: identity.runId,
        expectedRevision: accepted.revision,
        settledAtUnixMs: 500,
      });

      assert.equal(setup.intent.updatedAtUnixMs, 1_000);
      assert.equal(dispatching.updatedAtUnixMs, 1_000);
      assert.equal(accepted.updatedAtUnixMs, 1_000);
      assert.equal(settled.updatedAtUnixMs, 1_000);
      assert.equal(settled.state, "settled");
      assert.equal(settled.outcomeCode, null);
    }),
  );

  it.effect("系统时钟回拨不阻断释放、恢复重置、拒绝结算与隔离", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const identity = makeIdentity("clock-rollback-rejected");
      const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 1_000 });
      const firstSetup = yield* store.claimPrepared({
        runId: identity.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-clock-rollback-release",
        claimedAtUnixMs: 900,
      });
      const released = yield* store.releasePreparation({
        runId: identity.runId,
        expectedRevision: firstSetup.intent.revision,
        claimId: "claim-clock-rollback-release",
        ownerEpoch: firstSetup.intent.ownerEpoch,
        releasedAtUnixMs: 800,
      });
      const secondSetup = yield* store.claimPrepared({
        runId: identity.runId,
        expectedRevision: released.revision,
        claimId: "claim-clock-rollback-reset",
        claimedAtUnixMs: 500,
        leaseExpiresAtUnixMs: 501,
      });
      const reset = yield* store.resetPreparationForRecovery({
        runId: identity.runId,
        expectedRevision: secondSetup.intent.revision,
        ownerEpoch: secondSetup.intent.ownerEpoch,
        resetAtUnixMs: 600,
      });
      const thirdSetup = yield* store.claimPrepared({
        runId: identity.runId,
        expectedRevision: reset.revision,
        claimId: "claim-clock-rollback-rejected",
        claimedAtUnixMs: 500,
      });
      const dispatching = yield* store.markDispatching({
        runId: identity.runId,
        expectedRevision: thirdSetup.intent.revision,
        claimId: "claim-clock-rollback-rejected",
        ownerEpoch: thirdSetup.intent.ownerEpoch,
        dispatchedAtUnixMs: 400,
      });
      const rejected = yield* store.settleRejected({
        runId: identity.runId,
        expectedRevision: dispatching.revision,
        claimId: "claim-clock-rollback-rejected",
        ownerEpoch: dispatching.ownerEpoch,
        outcomeCode: "runtime_offline",
        outcomeDetail: "Runtime 当前离线。",
        settledAtUnixMs: 300,
      });

      const quarantineIdentity = makeIdentity("clock-rollback-quarantine");
      const quarantinePrepared = yield* store.prepareStart({
        ...quarantineIdentity,
        createdAtUnixMs: 1_000,
      });
      const quarantined = yield* store.quarantine({
        runId: quarantineIdentity.runId,
        expectedRevision: quarantinePrepared.revision,
        outcomeCode: "run_start_manual_recovery_required",
        outcomeDetail: "Driver 要求人工确认恢复。",
        quarantinedAtUnixMs: 900,
      });

      assert.equal(released.updatedAtUnixMs, 1_000);
      assert.equal(reset.updatedAtUnixMs, 1_000);
      assert.equal(rejected.updatedAtUnixMs, 1_000);
      assert.equal(rejected.state, "settled");
      assert.equal(rejected.outcomeCode, "runtime_offline");
      assert.equal(quarantined.updatedAtUnixMs, 1_000);
      assert.equal(quarantined.state, "quarantined");
    }),
  );
});

it.effect("两个 SQLite 连接竞争到期 dispatch owner 时仅一个新 epoch 获得 claim", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codework-run-start-fencing-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const identity = makeIdentity("dispatch-recovery-sqlite-race");
  const claimFromConnection = (claimId: string) =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      return yield* store.claimDispatchRecovery({
        runId: identity.runId,
        expectedRevision: 3,
        claimId,
        claimedAtUnixMs: 121,
        leaseExpiresAtUnixMs: 221,
      });
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
      const setup = yield* store.claimPrepared({
        runId: identity.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-sqlite-original",
        claimedAtUnixMs: 110,
        leaseExpiresAtUnixMs: 120,
      });
      yield* store.markDispatching({
        runId: identity.runId,
        expectedRevision: setup.intent.revision,
        claimId: setup.intent.claimId ?? "",
        ownerEpoch: setup.intent.ownerEpoch,
        dispatchedAtUnixMs: 115,
      });
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));

    const claims = yield* Effect.all(
      [
        Effect.result(claimFromConnection("claim-sqlite-recovery-a")),
        Effect.result(claimFromConnection("claim-sqlite-recovery-b")),
      ],
      { concurrency: "unbounded" },
    );
    assert.equal(
      claims.filter((claim) => claim._tag === "Success" && claim.success.claimed).length,
      1,
    );
    assert.equal(
      claims.filter((claim) => claim._tag === "Success" && !claim.success.claimed).length,
      1,
    );

    const persisted = yield* Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      return Option.getOrThrow(yield* store.getStart(identity.runId));
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));
    assert.equal(persisted.ownerEpoch, 2);
    assert.include(["claim-sqlite-recovery-a", "claim-sqlite-recovery-b"], persisted.claimId);
    assert.equal(persisted.ownerLeaseExpiresAtUnixMs, 221);
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
