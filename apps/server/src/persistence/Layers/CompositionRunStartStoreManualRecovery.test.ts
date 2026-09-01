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
  prepareAcceptedIntent,
  runStartStoreLayer,
} from "./CompositionRunStartStoreTestSupport.ts";

runStartStoreLayer("CompositionRunStartStore manual recovery", (it) => {
  it.effect("accepted owner 转入 manual_pending 后只进入独立人工扫描且可幂等重放", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const accepted = yield* prepareAcceptedIntent("accepted-manual-scan");
      const input = {
        runId: accepted.runId,
        expectedRevision: accepted.revision,
        claimId: accepted.claimId ?? "",
        ownerEpoch: accepted.ownerEpoch,
        runtimeTaskId: accepted.runtimeTaskId,
        capabilityHandshakeId: accepted.capabilityHandshakeId,
        outcomeCode: "run_start_manual_binding_required",
        outcomeDetail: "外部启动已接受，但当前 Driver 无法证明恢复绑定。",
        manualAtUnixMs: 140,
      } as const;

      const manual = yield* store.markAcceptedManualPending(input);
      const replayed = yield* store.markAcceptedManualPending(input);
      const recoverable = yield* store.listRecoverable({ limit: 20 });
      const manualUpperBound = yield* store.getManualRecoveryScanUpperBound;
      const manualRows = yield* store.listManualRecoveries({
        limit: 20,
        throughRunId: Option.getOrThrow(manualUpperBound),
      });

      assert.equal(manual.state, "manual_pending");
      assert.equal(manual.revision, accepted.revision + 1);
      assert.equal(manual.claimId, null);
      assert.equal(manual.ownerLeaseExpiresAtUnixMs, null);
      assert.equal(manual.ownerEpoch, accepted.ownerEpoch);
      assert.equal(manual.runtimeTaskId, accepted.runtimeTaskId);
      assert.equal(manual.capabilityHandshakeId, accepted.capabilityHandshakeId);
      assert.equal(manual.outcomeCode, input.outcomeCode);
      assert.deepEqual(replayed, manual);
      assert.notInclude(
        recoverable.map((intent) => intent.runId),
        manual.runId,
      );
      assert.deepEqual(manualRows, [manual]);
    }),
  );

  it.effect("manual recovery claim 只允许单一单调 epoch owner 续租、释放与重新领取", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const accepted = yield* prepareAcceptedIntent("manual-owner-lifecycle");
      const renewedAccepted = yield* store.renewOwnerLease({
        runId: accepted.runId,
        expectedRevision: accepted.revision,
        claimId: accepted.claimId ?? "",
        ownerEpoch: accepted.ownerEpoch,
        renewedAtUnixMs: 140,
        leaseExpiresAtUnixMs: 1_100,
      });
      const snapshot = {
        runtimeTaskId: accepted.runtimeTaskId,
        capabilityHandshakeId: accepted.capabilityHandshakeId,
        outcomeCode: "run_start_manual_owner_lifecycle",
        outcomeDetail: "等待 receipt-bound 补偿调度。",
      } as const;
      const manual = yield* store.markAcceptedManualPending({
        runId: accepted.runId,
        expectedRevision: renewedAccepted.revision,
        claimId: renewedAccepted.claimId ?? "",
        ownerEpoch: renewedAccepted.ownerEpoch,
        ...snapshot,
        manualAtUnixMs: 150,
      });
      const firstClaimInput = {
        runId: manual.runId,
        expectedRevision: manual.revision,
        expectedOwnerEpoch: manual.ownerEpoch,
        claimId: "claim-manual-owner-a",
        claimedAtUnixMs: 160,
        leaseExpiresAtUnixMs: 260,
        ...snapshot,
      } as const;
      const first = yield* store.claimManualRecovery(firstClaimInput);
      const replayed = yield* store.claimManualRecovery(firstClaimInput);
      const contender = yield* store.claimManualRecovery({
        ...firstClaimInput,
        claimId: "claim-manual-owner-contender",
      });
      const renewed = yield* store.renewOwnerLease({
        runId: manual.runId,
        expectedRevision: first.intent.revision,
        claimId: first.intent.claimId ?? "",
        ownerEpoch: first.intent.ownerEpoch,
        renewedAtUnixMs: 170,
        leaseExpiresAtUnixMs: 270,
      });
      const releasedInput = {
        runId: manual.runId,
        expectedRevision: renewed.revision,
        claimId: renewed.claimId ?? "",
        ownerEpoch: renewed.ownerEpoch,
        releasedAtUnixMs: 180,
        ...snapshot,
      } as const;
      const released = yield* store.releaseManualRecovery(releasedInput);
      const releaseReplay = yield* store.releaseManualRecovery(releasedInput);
      const second = yield* store.claimManualRecovery({
        runId: manual.runId,
        expectedRevision: released.revision,
        expectedOwnerEpoch: released.ownerEpoch,
        claimId: "claim-manual-owner-b",
        claimedAtUnixMs: 190,
        leaseExpiresAtUnixMs: 290,
        ...snapshot,
      });

      assert.isTrue(first.claimed);
      assert.isTrue(replayed.claimed);
      assert.isFalse(contender.claimed);
      assert.equal(first.intent.ownerEpoch, manual.ownerEpoch + 1);
      assert.equal(renewed.revision, first.intent.revision);
      assert.equal(renewed.ownerLeaseExpiresAtUnixMs, 270);
      assert.equal(released.claimId, null);
      assert.equal(released.ownerEpoch, first.intent.ownerEpoch);
      assert.deepEqual(releaseReplay, released);
      assert.isTrue(second.claimed);
      assert.equal(second.intent.ownerEpoch, first.intent.ownerEpoch + 1);
      assert.deepEqual(
        {
          runtimeTaskId: second.intent.runtimeTaskId,
          capabilityHandshakeId: second.intent.capabilityHandshakeId,
          outcomeCode: second.intent.outcomeCode,
          outcomeDetail: second.intent.outcomeDetail,
        },
        snapshot,
      );
    }),
  );

  it.effect("manual owner 到期后新 epoch 可接管且旧 owner 不能再恢复或结算", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const accepted = yield* prepareAcceptedIntent("manual-expired-takeover");
      const snapshot = {
        runtimeTaskId: accepted.runtimeTaskId,
        capabilityHandshakeId: accepted.capabilityHandshakeId,
        outcomeCode: "run_start_manual_expired_takeover",
        outcomeDetail: "等待新的补偿 owner 接管。",
      } as const;
      const manual = yield* store.markAcceptedManualPending({
        runId: accepted.runId,
        expectedRevision: accepted.revision,
        claimId: accepted.claimId ?? "",
        ownerEpoch: accepted.ownerEpoch,
        ...snapshot,
        manualAtUnixMs: 140,
      });
      const first = yield* store.claimManualRecovery({
        runId: manual.runId,
        expectedRevision: manual.revision,
        expectedOwnerEpoch: manual.ownerEpoch,
        claimId: "claim-manual-expired-a",
        claimedAtUnixMs: 150,
        leaseExpiresAtUnixMs: 170,
        ...snapshot,
      });
      const second = yield* store.claimManualRecovery({
        runId: manual.runId,
        expectedRevision: first.intent.revision,
        expectedOwnerEpoch: first.intent.ownerEpoch,
        claimId: "claim-manual-expired-b",
        claimedAtUnixMs: 171,
        leaseExpiresAtUnixMs: 271,
        ...snapshot,
      });
      const staleResume = yield* Effect.result(
        store.resumeManualRecoveryToAccepted({
          runId: manual.runId,
          expectedRevision: first.intent.revision,
          claimId: first.intent.claimId ?? "",
          ownerEpoch: first.intent.ownerEpoch,
          ...snapshot,
          resumedAtUnixMs: 172,
        }),
      );
      const staleSettle = yield* Effect.result(
        store.settleManualRecovery({
          runId: manual.runId,
          expectedRevision: first.intent.revision,
          claimId: first.intent.claimId ?? "",
          ownerEpoch: first.intent.ownerEpoch,
          ...snapshot,
          settledAtUnixMs: 172,
        }),
      );

      assert.isTrue(second.claimed);
      assert.equal(second.intent.ownerEpoch, first.intent.ownerEpoch + 1);
      assert.equal(second.intent.claimId, "claim-manual-expired-b");
      assert.equal(staleResume._tag, "Failure");
      assert.equal(staleSettle._tag, "Failure");
    }),
  );

  it.effect("manual owner 可恢复 accepted 或保留 receipt/outcome 完成人工结算", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const makeManualOwner = (suffix: string, outcomeCode: string) =>
        Effect.gen(function* () {
          const accepted = yield* prepareAcceptedIntent(suffix);
          const snapshot = {
            runtimeTaskId: accepted.runtimeTaskId,
            capabilityHandshakeId: accepted.capabilityHandshakeId,
            outcomeCode,
            outcomeDetail: `人工补偿：${suffix}`,
          } as const;
          const manual = yield* store.markAcceptedManualPending({
            runId: accepted.runId,
            expectedRevision: accepted.revision,
            claimId: accepted.claimId ?? "",
            ownerEpoch: accepted.ownerEpoch,
            ...snapshot,
            manualAtUnixMs: 140,
          });
          const claimed = yield* store.claimManualRecovery({
            runId: manual.runId,
            expectedRevision: manual.revision,
            expectedOwnerEpoch: manual.ownerEpoch,
            claimId: `claim-manual-${suffix}`,
            claimedAtUnixMs: 150,
            leaseExpiresAtUnixMs: 250,
            ...snapshot,
          });
          return { claimed: claimed.intent, snapshot };
        });

      const resumable = yield* makeManualOwner(
        "manual-resume-accepted",
        "run_start_manual_resumable",
      );
      const resumeInput = {
        runId: resumable.claimed.runId,
        expectedRevision: resumable.claimed.revision,
        claimId: resumable.claimed.claimId ?? "",
        ownerEpoch: resumable.claimed.ownerEpoch,
        ...resumable.snapshot,
        resumedAtUnixMs: 160,
      } as const;
      const resumed = yield* store.resumeManualRecoveryToAccepted(resumeInput);
      const resumeReplay = yield* store.resumeManualRecoveryToAccepted(resumeInput);
      const acceptedClaim = yield* store.claimAcceptedRecovery({
        runId: resumed.runId,
        expectedRevision: resumed.revision,
        claimId: "claim-accepted-after-manual",
        claimedAtUnixMs: 161,
        leaseExpiresAtUnixMs: 261,
      });
      const staleManualOwner = yield* Effect.result(
        store.resumeManualRecoveryToAccepted(resumeInput),
      );

      assert.equal(resumed.state, "accepted");
      assert.equal(resumed.claimId, null);
      assert.equal(resumed.ownerLeaseExpiresAtUnixMs, null);
      assert.equal(resumed.runtimeTaskId, resumable.snapshot.runtimeTaskId);
      assert.equal(resumed.capabilityHandshakeId, resumable.snapshot.capabilityHandshakeId);
      assert.equal(resumed.outcomeCode, null);
      assert.equal(resumed.outcomeDetail, null);
      assert.deepEqual(resumeReplay, resumed);
      assert.isTrue(acceptedClaim.claimed);
      assert.equal(acceptedClaim.intent.ownerEpoch, resumable.claimed.ownerEpoch + 1);
      assert.equal(acceptedClaim.intent.claimId, "claim-accepted-after-manual");
      assert.equal(acceptedClaim.intent.runtimeTaskId, resumable.snapshot.runtimeTaskId);
      assert.equal(staleManualOwner._tag, "Failure");

      const settleable = yield* makeManualOwner(
        "manual-settle-compensated",
        "run_start_manual_compensated",
      );
      const settleInput = {
        runId: settleable.claimed.runId,
        expectedRevision: settleable.claimed.revision,
        claimId: settleable.claimed.claimId ?? "",
        ownerEpoch: settleable.claimed.ownerEpoch,
        ...settleable.snapshot,
        settledAtUnixMs: 160,
      } as const;
      const settled = yield* store.settleManualRecovery(settleInput);
      const settleReplay = yield* store.settleManualRecovery(settleInput);
      const wrongOutcome = yield* Effect.result(
        store.settleManualRecovery({
          ...settleInput,
          outcomeCode: "run_start_manual_other_outcome",
        }),
      );

      assert.equal(settled.state, "settled");
      assert.equal(settled.revision, settleable.claimed.revision + 1);
      assert.equal(settled.claimId, settleable.claimed.claimId);
      assert.equal(settled.ownerEpoch, settleable.claimed.ownerEpoch);
      assert.equal(settled.ownerLeaseExpiresAtUnixMs, null);
      assert.equal(settled.runtimeTaskId, settleable.snapshot.runtimeTaskId);
      assert.equal(settled.capabilityHandshakeId, settleable.snapshot.capabilityHandshakeId);
      assert.equal(settled.outcomeCode, settleable.snapshot.outcomeCode);
      assert.equal(settled.outcomeDetail, settleable.snapshot.outcomeDetail);
      assert.deepEqual(settleReplay, settled);
      assert.equal(wrongOutcome._tag, "Failure");
    }),
  );
});

it.effect("两个 SQLite 连接竞争 manual_pending 时仅一个新 epoch 获得 claim", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codework-run-start-manual-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const suffix = "manual-recovery-sqlite-race";
  const snapshot = {
    runtimeTaskId: `runtime-task-${suffix}`,
    capabilityHandshakeId: `handshake-${suffix}`,
    outcomeCode: "run_start_manual_sqlite_race",
    outcomeDetail: "验证多连接人工补偿 claim 围栏。",
  } as const;

  return Effect.gen(function* () {
    const manual = yield* Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const accepted = yield* prepareAcceptedIntent(suffix);
      return yield* store.markAcceptedManualPending({
        runId: accepted.runId,
        expectedRevision: accepted.revision,
        claimId: accepted.claimId ?? "",
        ownerEpoch: accepted.ownerEpoch,
        ...snapshot,
        manualAtUnixMs: 140,
      });
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));
    const claimFromConnection = (claimId: string) =>
      Effect.gen(function* () {
        const store = yield* CompositionRunStartStore;
        return yield* store.claimManualRecovery({
          runId: manual.runId,
          expectedRevision: manual.revision,
          expectedOwnerEpoch: manual.ownerEpoch,
          claimId,
          claimedAtUnixMs: 150,
          leaseExpiresAtUnixMs: 250,
          ...snapshot,
        });
      }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));

    const claims = yield* Effect.all(
      [
        Effect.result(claimFromConnection("claim-manual-sqlite-a")),
        Effect.result(claimFromConnection("claim-manual-sqlite-b")),
      ],
      { concurrency: "unbounded" },
    );
    const persisted = yield* Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      return Option.getOrThrow(yield* store.getStart(manual.runId));
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));

    assert.equal(
      claims.filter((claim) => claim._tag === "Success" && claim.success.claimed).length,
      1,
    );
    assert.equal(
      claims.filter((claim) => claim._tag === "Success" && !claim.success.claimed).length,
      1,
    );
    assert.equal(persisted.ownerEpoch, manual.ownerEpoch + 1);
    assert.include(["claim-manual-sqlite-a", "claim-manual-sqlite-b"], persisted.claimId);
    assert.equal(persisted.ownerLeaseExpiresAtUnixMs, 250);
    assert.deepEqual(
      {
        runtimeTaskId: persisted.runtimeTaskId,
        capabilityHandshakeId: persisted.capabilityHandshakeId,
        outcomeCode: persisted.outcomeCode,
        outcomeDetail: persisted.outcomeDetail,
      },
      snapshot,
    );
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
