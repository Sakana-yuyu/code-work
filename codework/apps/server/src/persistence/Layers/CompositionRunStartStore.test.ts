import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CompositionRunStartStore } from "../Services/CompositionRunStartStore.ts";
import { makeIdentity, runStartStoreLayer } from "./CompositionRunStartStoreTestSupport.ts";

runStartStoreLayer("CompositionRunStartStore core", (it) => {
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

  it.effect("owner lease 到期但尚未 takeover 时，原 owner 仍可 quarantine 最终结果", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const identity = makeIdentity("quarantine-expired-owner");
      const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
      const setup = yield* store.claimPrepared({
        runId: identity.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-quarantine-expired-owner",
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

      const quarantined = yield* store.quarantine({
        runId: identity.runId,
        expectedRevision: dispatching.revision,
        claimId: dispatching.claimId ?? "",
        ownerEpoch: dispatching.ownerEpoch,
        outcomeCode: "run_start_invalid_receipt",
        outcomeDetail: "Driver 已返回，但最终 receipt 无法验证。",
        quarantinedAtUnixMs: 130,
      });

      assert.equal(quarantined.state, "quarantined");
      assert.equal(quarantined.ownerEpoch, dispatching.ownerEpoch);
    }),
  );

  it.effect("到期 quarantine 与 recovery takeover 并发时仅一个 CAS 写入赢家", () => {
    const identity = makeIdentity("quarantine-recovery-race");
    const claimRecovery = () =>
      Effect.gen(function* () {
        const store = yield* CompositionRunStartStore;
        return yield* store.claimDispatchRecovery({
          runId: identity.runId,
          expectedRevision: 3,
          claimId: "claim-quarantine-race-recovery",
          claimedAtUnixMs: 121,
          leaseExpiresAtUnixMs: 221,
        });
      });
    const quarantine = () =>
      Effect.gen(function* () {
        const store = yield* CompositionRunStartStore;
        return yield* store.quarantine({
          runId: identity.runId,
          expectedRevision: 3,
          claimId: "claim-quarantine-race-original",
          ownerEpoch: 1,
          outcomeCode: "run_start_invalid_receipt",
          outcomeDetail: "原 owner 已取得无法验证的 receipt。",
          quarantinedAtUnixMs: 121,
        });
      });

    return Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
      const setup = yield* store.claimPrepared({
        runId: identity.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-quarantine-race-original",
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

      const [recovery, quarantined] = yield* Effect.all(
        [Effect.result(claimRecovery()), Effect.result(quarantine())],
        { concurrency: "unbounded" },
      );
      const recoveryWon = recovery._tag === "Success" && recovery.success.claimed;
      const quarantineWon = quarantined._tag === "Success";

      assert.equal(Number(recoveryWon) + Number(quarantineWon), 1);
      if (recoveryWon) assert.equal(quarantined._tag, "Failure");
      if (quarantineWon) {
        assert.equal(recovery._tag, "Success");
        if (recovery._tag === "Success") assert.isFalse(recovery.success.claimed);
      }
    });
  });

  it.effect("新 owner quarantine 后，旧 epoch 的同结果回放仍必须失败", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const identity = makeIdentity("quarantine-stale-replay");
      const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
      const setup = yield* store.claimPrepared({
        runId: identity.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-quarantine-stale-original",
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
        claimId: "claim-quarantine-stale-recovery",
        claimedAtUnixMs: 121,
        leaseExpiresAtUnixMs: 221,
      });
      const quarantined = yield* store.quarantine({
        runId: identity.runId,
        expectedRevision: recovery.intent.revision,
        claimId: recovery.intent.claimId ?? "",
        ownerEpoch: recovery.intent.ownerEpoch,
        outcomeCode: "run_start_invalid_receipt",
        outcomeDetail: "新 owner 已确认 receipt 无效。",
        quarantinedAtUnixMs: 130,
      });

      const oldReplay = yield* Effect.result(
        store.quarantine({
          runId: identity.runId,
          expectedRevision: quarantined.revision,
          claimId: dispatching.claimId ?? "",
          ownerEpoch: dispatching.ownerEpoch,
          outcomeCode: "run_start_invalid_receipt",
          outcomeDetail: "新 owner 已确认 receipt 无效。",
          quarantinedAtUnixMs: 131,
        }),
      );

      assert.equal(oldReplay._tag, "Failure");
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
          claimId: dispatching.claimId ?? "",
          ownerEpoch: dispatching.ownerEpoch,
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
        claimId: accepted.claimId ?? "",
        ownerEpoch: accepted.ownerEpoch,
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
