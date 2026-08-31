// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CompositionRunStartStore } from "../Services/CompositionRunStartStore.ts";
import {
  makeFileStoreLayer,
  makeIdentity,
  runStartStoreLayer,
} from "./CompositionRunStartStoreTestSupport.ts";

runStartStoreLayer("CompositionRunStartStore accepted ownership", (it) => {
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
        claimId: accepted.claimId ?? "",
        ownerEpoch: accepted.ownerEpoch,
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
      assert.equal(accepted.claimId, "claim-dispatch-original");
      assert.equal(accepted.ownerLeaseExpiresAtUnixMs, 1_000);
      assert.equal(settled.state, "settled");
      assert.equal(settled.claimId, "claim-dispatch-original");
      assert.equal(settled.ownerLeaseExpiresAtUnixMs, null);
      assert.equal(settled.runtimeTaskId, "runtime-task-run-start-store");
      assert.deepEqual(lateReceipt, settled);
    }),
  );

  it.effect("accepted owner 到期后只有一个 recovery claimant 可结算，旧 owner 必须失败", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const identity = makeIdentity("accepted-recovery-owner");
      const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
      const setup = yield* store.claimPrepared({
        runId: identity.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-accepted-original",
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
      const accepted = yield* store.recordAccepted({
        runId: identity.runId,
        expectedRevision: dispatching.revision,
        claimId: dispatching.claimId ?? "",
        ownerEpoch: dispatching.ownerEpoch,
        runtimeTaskId: "runtime-task-accepted-owner",
        capabilityHandshakeId: null,
        acceptedAtUnixMs: 116,
      });
      const activeClaim = yield* store.claimAcceptedRecovery({
        runId: identity.runId,
        expectedRevision: accepted.revision,
        claimId: "claim-accepted-active-contender",
        claimedAtUnixMs: 119,
        leaseExpiresAtUnixMs: 219,
      });
      const claims = yield* Effect.all(
        [
          store.claimAcceptedRecovery({
            runId: identity.runId,
            expectedRevision: accepted.revision,
            claimId: "claim-accepted-recovery-a",
            claimedAtUnixMs: 121,
            leaseExpiresAtUnixMs: 221,
          }),
          store.claimAcceptedRecovery({
            runId: identity.runId,
            expectedRevision: accepted.revision,
            claimId: "claim-accepted-recovery-b",
            claimedAtUnixMs: 121,
            leaseExpiresAtUnixMs: 221,
          }),
        ],
        { concurrency: "unbounded" },
      );
      const winner = claims.find((claim) => claim.claimed);
      assert.isDefined(winner);
      assert.isFalse(activeClaim.claimed);
      assert.equal(claims.filter((claim) => claim.claimed).length, 1);
      assert.equal(winner.intent.ownerEpoch, accepted.ownerEpoch + 1);
      assert.equal(winner.intent.runtimeTaskId, accepted.runtimeTaskId);

      const staleSettle = yield* Effect.result(
        store.settleAccepted({
          runId: identity.runId,
          expectedRevision: accepted.revision,
          claimId: accepted.claimId ?? "",
          ownerEpoch: accepted.ownerEpoch,
          settledAtUnixMs: 122,
        }),
      );
      assert.equal(staleSettle._tag, "Failure");

      const settled = yield* store.settleAccepted({
        runId: identity.runId,
        expectedRevision: winner.intent.revision,
        claimId: winner.intent.claimId ?? "",
        ownerEpoch: winner.intent.ownerEpoch,
        settledAtUnixMs: 123,
      });
      const replayed = yield* store.settleAccepted({
        runId: identity.runId,
        expectedRevision: winner.intent.revision,
        claimId: winner.intent.claimId ?? "",
        ownerEpoch: winner.intent.ownerEpoch,
        settledAtUnixMs: 124,
      });
      assert.equal(settled.state, "settled");
      assert.equal(settled.claimId, winner.intent.claimId);
      assert.equal(settled.ownerLeaseExpiresAtUnixMs, null);
      assert.deepEqual(replayed, settled);
    }),
  );

  it.effect("accepted owner 到期但尚未被接管时可释放 claim，接管后旧释放必须失败", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const identity = makeIdentity("accepted-recovery-release");
      const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
      const setup = yield* store.claimPrepared({
        runId: identity.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-accepted-release-original",
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
      const accepted = yield* store.recordAccepted({
        runId: identity.runId,
        expectedRevision: dispatching.revision,
        claimId: dispatching.claimId ?? "",
        ownerEpoch: dispatching.ownerEpoch,
        runtimeTaskId: "runtime-task-accepted-release",
        capabilityHandshakeId: "handshake-accepted-release",
        acceptedAtUnixMs: 116,
      });
      const releaseInput = {
        runId: identity.runId,
        expectedRevision: accepted.revision,
        claimId: accepted.claimId ?? "",
        ownerEpoch: accepted.ownerEpoch,
        releasedAtUnixMs: 121,
      };

      const released = yield* store.releaseAcceptedRecovery(releaseInput);
      const replayed = yield* store.releaseAcceptedRecovery(releaseInput);
      const takeover = yield* store.claimAcceptedRecovery({
        runId: identity.runId,
        expectedRevision: released.revision,
        claimId: "claim-accepted-release-takeover",
        claimedAtUnixMs: 122,
        leaseExpiresAtUnixMs: 222,
      });
      const staleRelease = yield* Effect.result(
        store.releaseAcceptedRecovery({ ...releaseInput, releasedAtUnixMs: 123 }),
      );

      assert.equal(released.state, "accepted");
      assert.equal(released.claimId, null);
      assert.equal(released.ownerLeaseExpiresAtUnixMs, null);
      assert.equal(released.runtimeTaskId, accepted.runtimeTaskId);
      assert.equal(released.capabilityHandshakeId, accepted.capabilityHandshakeId);
      assert.deepEqual(replayed, released);
      assert.isTrue(takeover.claimed);
      assert.equal(takeover.intent.ownerEpoch, accepted.ownerEpoch + 1);
      assert.equal(staleRelease._tag, "Failure");
    }),
  );

  it.effect("当前 dispatch owner 只能在到期前单调续租且不改变 revision", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const identity = makeIdentity("dispatch-owner-renew");
      const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
      const setup = yield* store.claimPrepared({
        runId: identity.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-dispatch-owner-renew",
        claimedAtUnixMs: 110,
        leaseExpiresAtUnixMs: 170,
      });
      const dispatching = yield* store.markDispatching({
        runId: identity.runId,
        expectedRevision: setup.intent.revision,
        claimId: setup.intent.claimId ?? "",
        ownerEpoch: setup.intent.ownerEpoch,
        dispatchedAtUnixMs: 120,
      });

      const wrongRevision = yield* Effect.result(
        store.renewOwnerLease({
          runId: identity.runId,
          expectedRevision: dispatching.revision + 1,
          claimId: dispatching.claimId ?? "",
          ownerEpoch: dispatching.ownerEpoch,
          renewedAtUnixMs: 139,
          leaseExpiresAtUnixMs: 239,
        }),
      );
      const renewed = yield* store.renewOwnerLease({
        runId: identity.runId,
        expectedRevision: dispatching.revision,
        claimId: dispatching.claimId ?? "",
        ownerEpoch: dispatching.ownerEpoch,
        renewedAtUnixMs: 140,
        leaseExpiresAtUnixMs: 240,
      });
      const replayed = yield* store.renewOwnerLease({
        runId: identity.runId,
        expectedRevision: dispatching.revision,
        claimId: dispatching.claimId ?? "",
        ownerEpoch: dispatching.ownerEpoch,
        renewedAtUnixMs: 140,
        leaseExpiresAtUnixMs: 240,
      });

      assert.equal(wrongRevision._tag, "Failure");
      assert.equal(renewed.revision, dispatching.revision);
      assert.equal(renewed.ownerLeaseExpiresAtUnixMs, 240);
      assert.equal(renewed.updatedAtUnixMs, 140);
      assert.deepEqual(replayed, renewed);
    }),
  );

  it.effect("已到期或已被新 epoch 接管的 dispatch owner 不能续租", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const identity = makeIdentity("dispatch-owner-renew-expired");
      const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
      const setup = yield* store.claimPrepared({
        runId: identity.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-dispatch-owner-renew-expired",
        claimedAtUnixMs: 110,
        leaseExpiresAtUnixMs: 130,
      });
      const dispatching = yield* store.markDispatching({
        runId: identity.runId,
        expectedRevision: setup.intent.revision,
        claimId: setup.intent.claimId ?? "",
        ownerEpoch: setup.intent.ownerEpoch,
        dispatchedAtUnixMs: 120,
      });
      const expiredRenewal = yield* Effect.result(
        store.renewOwnerLease({
          runId: identity.runId,
          expectedRevision: dispatching.revision,
          claimId: dispatching.claimId ?? "",
          ownerEpoch: dispatching.ownerEpoch,
          renewedAtUnixMs: 131,
          leaseExpiresAtUnixMs: 231,
        }),
      );
      const recovery = yield* store.claimDispatchRecovery({
        runId: identity.runId,
        expectedRevision: dispatching.revision,
        claimId: "claim-dispatch-owner-renew-recovery",
        claimedAtUnixMs: 131,
        leaseExpiresAtUnixMs: 231,
      });
      const staleRenewal = yield* Effect.result(
        store.renewOwnerLease({
          runId: identity.runId,
          expectedRevision: dispatching.revision,
          claimId: dispatching.claimId ?? "",
          ownerEpoch: dispatching.ownerEpoch,
          renewedAtUnixMs: 132,
          leaseExpiresAtUnixMs: 232,
        }),
      );

      assert.equal(expiredRenewal._tag, "Failure");
      assert.isTrue(recovery.claimed);
      assert.equal(staleRenewal._tag, "Failure");
      assert.equal(
        Option.getOrThrow(yield* store.getStart(identity.runId)).ownerEpoch,
        dispatching.ownerEpoch + 1,
      );
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
