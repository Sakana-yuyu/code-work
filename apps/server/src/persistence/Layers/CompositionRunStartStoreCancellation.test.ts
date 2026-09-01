// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  CompositionRunStartStore,
  type CompositionRunStartIntent,
  type CompositionRunStartStoreErrorCode,
} from "../Services/CompositionRunStartStore.ts";
import {
  makeFileStoreLayer,
  makeIdentity,
  runStartStoreLayer,
} from "./CompositionRunStartStoreTestSupport.ts";

const prepareDispatchingIntent = (suffix: string, leaseExpiresAtUnixMs = 1_000) =>
  Effect.gen(function* () {
    const store = yield* CompositionRunStartStore;
    const identity = makeIdentity(suffix);
    const prepared = yield* store.prepareStart({ ...identity, createdAtUnixMs: 100 });
    const claimed = yield* store.claimPrepared({
      runId: identity.runId,
      expectedRevision: prepared.revision,
      claimId: "claim-start-" + suffix,
      claimedAtUnixMs: 110,
      leaseExpiresAtUnixMs,
    });
    return yield* store.markDispatching({
      runId: identity.runId,
      expectedRevision: claimed.intent.revision,
      claimId: claimed.intent.claimId ?? "",
      ownerEpoch: claimed.intent.ownerEpoch,
      dispatchedAtUnixMs: 120,
    });
  });

const prepareAcceptedIntent = (suffix: string) =>
  Effect.gen(function* () {
    const store = yield* CompositionRunStartStore;
    const dispatching = yield* prepareDispatchingIntent(suffix);
    return yield* store.recordAccepted({
      runId: dispatching.runId,
      expectedRevision: dispatching.revision,
      claimId: dispatching.claimId ?? "",
      ownerEpoch: dispatching.ownerEpoch,
      runtimeTaskId: "runtime-task-" + suffix,
      capabilityHandshakeId: "handshake-" + suffix,
      acceptedAtUnixMs: 130,
    });
  });

const expectDomainErrorCode = (
  result: { readonly _tag: string; readonly failure?: unknown },
  code: CompositionRunStartStoreErrorCode,
) => {
  assert.equal(result._tag, "Failure");
  if (result._tag !== "Failure") return;
  const failure = result.failure as { readonly _tag?: string; readonly code?: string };
  assert.equal(failure._tag, "CompositionRunStartStoreDomainError");
  assert.equal(failure.code, code);
};

runStartStoreLayer("CompositionRunStartStore cancellation barrier", (it) => {
  it.effect("四类可取消来源只写一次屏障，拒绝重新打开明确失败的 settled", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const dispatching = yield* prepareDispatchingIntent("cancel-source-dispatching");
      const accepted = yield* prepareAcceptedIntent("cancel-source-accepted");
      const manualAccepted = yield* prepareAcceptedIntent("cancel-source-manual");
      const manual = yield* store.markAcceptedManualPending({
        runId: manualAccepted.runId,
        expectedRevision: manualAccepted.revision,
        claimId: manualAccepted.claimId ?? "",
        ownerEpoch: manualAccepted.ownerEpoch,
        runtimeTaskId: manualAccepted.runtimeTaskId,
        capabilityHandshakeId: manualAccepted.capabilityHandshakeId,
        outcomeCode: "run_start_manual_reconcile",
        outcomeDetail: "等待人工核对外部任务。",
        manualAtUnixMs: 140,
      });
      const acceptedToSettle = yield* prepareAcceptedIntent("cancel-source-accepted-settled");
      const acceptedSettled = yield* store.settleAccepted({
        runId: acceptedToSettle.runId,
        expectedRevision: acceptedToSettle.revision,
        claimId: acceptedToSettle.claimId ?? "",
        ownerEpoch: acceptedToSettle.ownerEpoch,
        settledAtUnixMs: 140,
      });
      const rejectedDispatching = yield* prepareDispatchingIntent("cancel-source-rejected");
      const rejectedSettled = yield* store.settleRejected({
        runId: rejectedDispatching.runId,
        expectedRevision: rejectedDispatching.revision,
        claimId: rejectedDispatching.claimId ?? "",
        ownerEpoch: rejectedDispatching.ownerEpoch,
        outcomeCode: "driver_rejected",
        outcomeDetail: "Driver 明确拒绝启动。",
        settledAtUnixMs: 130,
      });

      const request = (intent: CompositionRunStartIntent, requestedAtUnixMs: number) =>
        store.requestCancellation({
          runId: intent.runId,
          expectedRevision: intent.revision,
          requestedAtUnixMs,
          reason: "用户请求取消。",
        });
      const dispatchCancelled = yield* request(dispatching, 130);
      const dispatchReplay = yield* store.requestCancellation({
        runId: dispatching.runId,
        expectedRevision: dispatching.revision,
        requestedAtUnixMs: 999,
        reason: "不得覆盖首次原因。",
      });
      const acceptedCancelled = yield* request(accepted, 140);
      const manualCancelled = yield* request(manual, 150);
      const acceptedSettledCancelled = yield* request(acceptedSettled, 150);
      const rejectedCancellation = yield* Effect.result(request(rejectedSettled, 150));

      assert.deepInclude(dispatchCancelled, {
        state: "cancel_pending",
        revision: dispatching.revision + 1,
        claimId: null,
        ownerLeaseExpiresAtUnixMs: null,
        cancelRequestedAtUnixMs: 130,
        cancelReason: "用户请求取消。",
        cancelSourceState: "dispatching",
        cancelSourceRevision: dispatching.revision,
        cancelSourceClaimId: dispatching.claimId,
        cancelSourceOwnerEpoch: dispatching.ownerEpoch,
        cancelStartOutcome: "pending",
        cancelTerminalStatus: null,
        cancelTerminalSourceEventId: null,
        cancelTerminalObservedAtUnixMs: null,
      });
      assert.deepEqual(dispatchReplay, dispatchCancelled);
      assert.deepInclude(acceptedCancelled, {
        cancelSourceState: "accepted",
        cancelStartOutcome: "accepted",
        runtimeTaskId: accepted.runtimeTaskId,
        capabilityHandshakeId: accepted.capabilityHandshakeId,
      });
      assert.deepInclude(manualCancelled, {
        cancelSourceState: "manual_pending",
        cancelStartOutcome: "accepted",
        outcomeCode: manual.outcomeCode,
        outcomeDetail: manual.outcomeDetail,
      });
      assert.deepInclude(acceptedSettledCancelled, {
        cancelSourceState: "accepted_settled",
        cancelStartOutcome: "accepted",
        runtimeTaskId: acceptedSettled.runtimeTaskId,
        capabilityHandshakeId: acceptedSettled.capabilityHandshakeId,
      });
      expectDomainErrorCode(rejectedCancellation, "run_start_state_conflict");
    }),
  );

  it.effect(
    "dispatching 迟到 accepted/rejected 受 source fence 保护并使旧 cancel revision 失效",
    () =>
      Effect.gen(function* () {
        const store = yield* CompositionRunStartStore;
        const dispatching = yield* prepareDispatchingIntent("cancel-late-accepted");
        const requested = yield* store.requestCancellation({
          runId: dispatching.runId,
          expectedRevision: dispatching.revision,
          requestedAtUnixMs: 130,
          reason: "取消正在启动的任务。",
        });
        const claimed = yield* store.claimCancellationRecovery({
          runId: requested.runId,
          expectedRevision: requested.revision,
          claimId: "claim-cancel-late-accepted",
          claimedAtUnixMs: 140,
          leaseExpiresAtUnixMs: 400,
        });
        const sourceFence = {
          runId: requested.runId,
          sourceRevision: requested.cancelSourceRevision ?? 0,
          sourceClaimId: requested.cancelSourceClaimId ?? null,
          sourceOwnerEpoch: requested.cancelSourceOwnerEpoch ?? 0,
        } as const;
        const lateAcceptedInput = {
          ...sourceFence,
          runtimeTaskId: null,
          capabilityHandshakeId: null,
          acceptedAtUnixMs: 150,
        } as const;
        const lateAccepted = yield* store.recordCancellationStartAccepted(lateAcceptedInput);
        const replay = yield* store.recordCancellationStartAccepted(lateAcceptedInput);
        const conflictingReceipt = yield* Effect.result(
          store.recordCancellationStartAccepted({
            ...lateAcceptedInput,
            runtimeTaskId: "runtime-task-conflict",
          }),
        );
        const conflictingRejected = yield* Effect.result(
          store.recordCancellationStartRejected({
            ...sourceFence,
            outcomeCode: "driver_rejected",
            outcomeDetail: "与 accepted 冲突。",
            rejectedAtUnixMs: 151,
          }),
        );
        const staleSettle = yield* Effect.result(
          store.settleCancellation({
            runId: claimed.intent.runId,
            expectedRevision: claimed.intent.revision,
            claimId: claimed.intent.claimId ?? "",
            ownerEpoch: claimed.intent.ownerEpoch,
            settledAtUnixMs: 160,
          }),
        );
        const missingTerminal = yield* Effect.result(
          store.settleCancellation({
            runId: lateAccepted.runId,
            expectedRevision: lateAccepted.revision,
            claimId: lateAccepted.claimId ?? "",
            ownerEpoch: lateAccepted.ownerEpoch,
            settledAtUnixMs: 160,
          }),
        );

        assert.equal(lateAccepted.cancelStartOutcome, "accepted");
        assert.equal(lateAccepted.runtimeTaskId, null);
        assert.equal(lateAccepted.capabilityHandshakeId, null);
        assert.equal(lateAccepted.revision, claimed.intent.revision + 1);
        assert.equal(lateAccepted.claimId, claimed.intent.claimId);
        assert.equal(lateAccepted.ownerEpoch, claimed.intent.ownerEpoch);
        assert.equal(
          lateAccepted.ownerLeaseExpiresAtUnixMs,
          claimed.intent.ownerLeaseExpiresAtUnixMs,
        );
        assert.deepEqual(replay, lateAccepted);
        expectDomainErrorCode(conflictingReceipt, "run_start_receipt_conflict");
        expectDomainErrorCode(conflictingRejected, "run_start_receipt_conflict");
        expectDomainErrorCode(staleSettle, "run_start_claim_conflict");
        expectDomainErrorCode(missingTerminal, "run_start_state_conflict");

        const rejectedDispatching = yield* prepareDispatchingIntent("cancel-late-rejected");
        const rejectedRequested = yield* store.requestCancellation({
          runId: rejectedDispatching.runId,
          expectedRevision: rejectedDispatching.revision,
          requestedAtUnixMs: 130,
          reason: "取消尚未确认的启动。",
        });
        const rejectedClaim = yield* store.claimCancellationRecovery({
          runId: rejectedRequested.runId,
          expectedRevision: rejectedRequested.revision,
          claimId: "claim-cancel-late-rejected",
          claimedAtUnixMs: 140,
          leaseExpiresAtUnixMs: 400,
        });
        const lateRejected = yield* store.recordCancellationStartRejected({
          runId: rejectedRequested.runId,
          sourceRevision: rejectedRequested.cancelSourceRevision ?? 0,
          sourceClaimId: rejectedRequested.cancelSourceClaimId ?? null,
          sourceOwnerEpoch: rejectedRequested.cancelSourceOwnerEpoch ?? 0,
          outcomeCode: "driver_rejected",
          outcomeDetail: "Driver 明确未创建外部任务。",
          rejectedAtUnixMs: 150,
        });
        const settled = yield* store.settleCancellation({
          runId: lateRejected.runId,
          expectedRevision: lateRejected.revision,
          claimId: rejectedClaim.intent.claimId ?? "",
          ownerEpoch: rejectedClaim.intent.ownerEpoch,
          settledAtUnixMs: 160,
        });
        const requestReplay = yield* store.requestCancellation({
          runId: rejectedDispatching.runId,
          expectedRevision: rejectedDispatching.revision,
          requestedAtUnixMs: 999,
          reason: "不得重新打开。",
        });
        const ordinaryAcceptedReplay = yield* Effect.result(
          store.recordAccepted({
            runId: rejectedDispatching.runId,
            expectedRevision: rejectedDispatching.revision,
            claimId: rejectedDispatching.claimId ?? "",
            ownerEpoch: rejectedDispatching.ownerEpoch,
            runtimeTaskId: null,
            capabilityHandshakeId: null,
            acceptedAtUnixMs: 170,
          }),
        );

        assert.deepInclude(settled, {
          state: "settled",
          cancelStartOutcome: "rejected",
          cancelTerminalStatus: null,
          cancelSourceRevision: rejectedDispatching.revision,
          cancelRequestedAtUnixMs: 130,
        });
        assert.deepEqual(requestReplay, settled);
        expectDomainErrorCode(ordinaryAcceptedReplay, "run_start_receipt_conflict");
      }),
  );

  it.effect("错误 source revision、claim 和 owner epoch 均 fail-closed", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const dispatching = yield* prepareDispatchingIntent("cancel-source-fence");
      const requested = yield* store.requestCancellation({
        runId: dispatching.runId,
        expectedRevision: dispatching.revision,
        requestedAtUnixMs: 130,
        reason: "验证迟到启动结果的来源围栏。",
      });
      const acceptedInput = {
        runId: requested.runId,
        sourceRevision: requested.cancelSourceRevision ?? 0,
        sourceClaimId: requested.cancelSourceClaimId ?? null,
        sourceOwnerEpoch: requested.cancelSourceOwnerEpoch ?? 0,
        runtimeTaskId: "runtime-task-source-fence",
        capabilityHandshakeId: "handshake-source-fence",
        acceptedAtUnixMs: 140,
      } as const;
      const wrongFenceResults = yield* Effect.all(
        [
          Effect.result(
            store.recordCancellationStartAccepted({
              ...acceptedInput,
              sourceRevision: acceptedInput.sourceRevision + 1,
            }),
          ),
          Effect.result(
            store.recordCancellationStartAccepted({
              ...acceptedInput,
              sourceClaimId: "claim-source-fence-wrong",
            }),
          ),
          Effect.result(
            store.recordCancellationStartAccepted({
              ...acceptedInput,
              sourceOwnerEpoch: acceptedInput.sourceOwnerEpoch + 1,
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      const beforeCorrectReceipt = Option.getOrThrow(yield* store.getStart(requested.runId));
      const accepted = yield* store.recordCancellationStartAccepted(acceptedInput);

      for (const result of wrongFenceResults) {
        expectDomainErrorCode(result, "run_start_receipt_conflict");
      }
      assert.deepInclude(beforeCorrectReceipt, {
        revision: requested.revision,
        cancelStartOutcome: "pending",
        runtimeTaskId: null,
        capabilityHandshakeId: null,
      });
      assert.deepInclude(accepted, {
        revision: requested.revision + 1,
        cancelStartOutcome: "accepted",
        runtimeTaskId: "runtime-task-source-fence",
        capabilityHandshakeId: "handshake-source-fence",
      });
    }),
  );

  it.effect("recordAccepted 与取消屏障两种提交顺序都保留唯一 receipt", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const acceptedFirstDispatching = yield* prepareDispatchingIntent(
        "cancel-order-accepted-first",
      );
      const acceptedFirstInput = {
        runId: acceptedFirstDispatching.runId,
        expectedRevision: acceptedFirstDispatching.revision,
        claimId: acceptedFirstDispatching.claimId ?? "",
        ownerEpoch: acceptedFirstDispatching.ownerEpoch,
        runtimeTaskId: "runtime-task-order-accepted-first",
        capabilityHandshakeId: "handshake-order-accepted-first",
        acceptedAtUnixMs: 130,
      } as const;
      const acceptedFirst = yield* store.recordAccepted(acceptedFirstInput);
      const cancelledAfterAccepted = yield* store.requestCancellation({
        runId: acceptedFirst.runId,
        expectedRevision: acceptedFirst.revision,
        requestedAtUnixMs: 140,
        reason: "accepted 落库后请求取消。",
      });

      const cancelFirstDispatching = yield* prepareDispatchingIntent("cancel-order-cancel-first");
      const cancelFirstInput = {
        runId: cancelFirstDispatching.runId,
        expectedRevision: cancelFirstDispatching.revision,
        claimId: cancelFirstDispatching.claimId ?? "",
        ownerEpoch: cancelFirstDispatching.ownerEpoch,
        runtimeTaskId: "runtime-task-order-cancel-first",
        capabilityHandshakeId: "handshake-order-cancel-first",
        acceptedAtUnixMs: 140,
      } as const;
      const cancelledBeforeAccepted = yield* store.requestCancellation({
        runId: cancelFirstDispatching.runId,
        expectedRevision: cancelFirstDispatching.revision,
        requestedAtUnixMs: 130,
        reason: "receipt 返回前先写取消屏障。",
      });
      const ordinaryLateAccepted = yield* Effect.result(store.recordAccepted(cancelFirstInput));
      const attachedLateAccepted = yield* store.recordCancellationStartAccepted({
        runId: cancelledBeforeAccepted.runId,
        sourceRevision: cancelledBeforeAccepted.cancelSourceRevision ?? 0,
        sourceClaimId: cancelledBeforeAccepted.cancelSourceClaimId ?? null,
        sourceOwnerEpoch: cancelledBeforeAccepted.cancelSourceOwnerEpoch ?? 0,
        runtimeTaskId: cancelFirstInput.runtimeTaskId,
        capabilityHandshakeId: cancelFirstInput.capabilityHandshakeId,
        acceptedAtUnixMs: cancelFirstInput.acceptedAtUnixMs,
      });

      assert.deepInclude(cancelledAfterAccepted, {
        cancelSourceState: "accepted",
        cancelSourceRevision: acceptedFirst.revision,
        cancelStartOutcome: "accepted",
        runtimeTaskId: acceptedFirstInput.runtimeTaskId,
        capabilityHandshakeId: acceptedFirstInput.capabilityHandshakeId,
      });
      expectDomainErrorCode(ordinaryLateAccepted, "run_start_receipt_conflict");
      assert.deepInclude(attachedLateAccepted, {
        cancelSourceState: "dispatching",
        cancelSourceRevision: cancelFirstDispatching.revision,
        cancelStartOutcome: "accepted",
        runtimeTaskId: cancelFirstInput.runtimeTaskId,
        capabilityHandshakeId: cancelFirstInput.capabilityHandshakeId,
      });
    }),
  );

  it.effect("receipt-bound 外部终态首次写入后不可改写，且 cleanup owner 才能结算", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const accepted = yield* prepareAcceptedIntent("cancel-terminal-evidence");
      const requested = yield* store.requestCancellation({
        runId: accepted.runId,
        expectedRevision: accepted.revision,
        requestedAtUnixMs: 140,
        reason: "终止已接受的外部任务。",
      });
      const claimed = yield* store.claimCancellationRecovery({
        runId: requested.runId,
        expectedRevision: requested.revision,
        claimId: "claim-cancel-terminal",
        claimedAtUnixMs: 150,
        leaseExpiresAtUnixMs: 400,
      });
      const terminalInput = {
        runId: requested.runId,
        expectedRevision: claimed.intent.revision,
        sourceRevision: requested.cancelSourceRevision ?? 0,
        sourceClaimId: requested.cancelSourceClaimId ?? null,
        sourceOwnerEpoch: requested.cancelSourceOwnerEpoch ?? 0,
        runtimeTaskId: requested.runtimeTaskId,
        capabilityHandshakeId: requested.capabilityHandshakeId,
        terminalStatus: "cancelled" as const,
        sourceEventId: "runtime-event-cancelled-1",
        observedAtUnixMs: 160,
      };
      const terminal = yield* store.markCancellationTerminalObserved(terminalInput);
      const replay = yield* store.markCancellationTerminalObserved(terminalInput);
      const conflict = yield* Effect.result(
        store.markCancellationTerminalObserved({
          ...terminalInput,
          expectedRevision: terminal.revision,
          terminalStatus: "failed",
          sourceEventId: "runtime-event-failed-2",
          observedAtUnixMs: 161,
        }),
      );
      const staleSettle = yield* Effect.result(
        store.settleCancellation({
          runId: claimed.intent.runId,
          expectedRevision: claimed.intent.revision,
          claimId: claimed.intent.claimId ?? "",
          ownerEpoch: claimed.intent.ownerEpoch,
          settledAtUnixMs: 170,
        }),
      );
      const settled = yield* store.settleCancellation({
        runId: terminal.runId,
        expectedRevision: terminal.revision,
        claimId: terminal.claimId ?? "",
        ownerEpoch: terminal.ownerEpoch,
        settledAtUnixMs: 170,
      });
      const ordinaryAcceptedReplay = yield* Effect.result(
        store.recordAccepted({
          runId: accepted.runId,
          expectedRevision: accepted.revision,
          claimId: accepted.claimId ?? "",
          ownerEpoch: accepted.ownerEpoch,
          runtimeTaskId: accepted.runtimeTaskId,
          capabilityHandshakeId: accepted.capabilityHandshakeId,
          acceptedAtUnixMs: 180,
        }),
      );

      assert.deepInclude(terminal, {
        cancelTerminalStatus: "cancelled",
        cancelTerminalSourceEventId: "runtime-event-cancelled-1",
        cancelTerminalObservedAtUnixMs: 160,
        claimId: claimed.intent.claimId,
        ownerEpoch: claimed.intent.ownerEpoch,
        ownerLeaseExpiresAtUnixMs: claimed.intent.ownerLeaseExpiresAtUnixMs,
      });
      assert.deepEqual(replay, terminal);
      expectDomainErrorCode(conflict, "run_start_receipt_conflict");
      expectDomainErrorCode(staleSettle, "run_start_claim_conflict");
      assert.deepInclude(settled, {
        state: "settled",
        cancelRequestedAtUnixMs: 140,
        cancelStartOutcome: "accepted",
        cancelTerminalStatus: "cancelled",
        cancelTerminalSourceEventId: "runtime-event-cancelled-1",
        cancelTerminalObservedAtUnixMs: 160,
        ownerLeaseExpiresAtUnixMs: null,
      });
      expectDomainErrorCode(ordinaryAcceptedReplay, "run_start_receipt_conflict");
    }),
  );

  it.effect("取消恢复 claim 支持续租、释放、重新领取和独立稳定 keyset 扫描", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const requested: CompositionRunStartIntent[] = [];
      for (const suffix of ["scan-c", "scan-a", "scan-b"]) {
        const dispatching = yield* prepareDispatchingIntent(suffix);
        requested.push(
          yield* store.requestCancellation({
            runId: dispatching.runId,
            expectedRevision: dispatching.revision,
            requestedAtUnixMs: 130,
            reason: "扫描取消恢复候选。",
          }),
        );
      }
      const ordered = requested.toSorted((left, right) => left.runId.localeCompare(right.runId));
      const upperBound = Option.getOrThrow(yield* store.getCancellationRecoveryScanUpperBound);
      const firstPage = yield* store.listCancellationRecoveries({
        limit: 2,
        after: { runId: "run-run-start-store-scan-0" },
        throughRunId: upperBound,
      });
      const secondPage = yield* store.listCancellationRecoveries({
        limit: 2,
        throughRunId: upperBound,
        after: { runId: firstPage[1]?.runId ?? "" },
      });
      const first = ordered[0];
      assert.isDefined(first);
      const claimed = yield* store.claimCancellationRecovery({
        runId: first!.runId,
        expectedRevision: first!.revision,
        claimId: "claim-cancel-scan-a",
        claimedAtUnixMs: 140,
        leaseExpiresAtUnixMs: 240,
      });
      const renewed = yield* store.renewOwnerLease({
        runId: claimed.intent.runId,
        expectedRevision: claimed.intent.revision,
        claimId: claimed.intent.claimId ?? "",
        ownerEpoch: claimed.intent.ownerEpoch,
        renewedAtUnixMs: 150,
        leaseExpiresAtUnixMs: 260,
      });
      const released = yield* store.releaseCancellationRecovery({
        runId: renewed.runId,
        expectedRevision: renewed.revision,
        claimId: renewed.claimId ?? "",
        ownerEpoch: renewed.ownerEpoch,
        releasedAtUnixMs: 160,
      });
      const reclaimed = yield* store.claimCancellationRecovery({
        runId: released.runId,
        expectedRevision: released.revision,
        claimId: "claim-cancel-scan-b",
        claimedAtUnixMs: 170,
        leaseExpiresAtUnixMs: 270,
      });
      const invalidLimit = yield* Effect.result(store.listCancellationRecoveries({ limit: 0 }));

      assert.equal(upperBound, ordered.at(-1)?.runId);
      assert.deepEqual(
        [...firstPage, ...secondPage].map((intent) => intent.runId),
        ordered.map((intent) => intent.runId),
      );
      assert.equal(renewed.ownerLeaseExpiresAtUnixMs, 260);
      assert.equal(released.claimId, null);
      assert.equal(released.ownerLeaseExpiresAtUnixMs, null);
      assert.isTrue(reclaimed.claimed);
      assert.equal(reclaimed.intent.ownerEpoch, claimed.intent.ownerEpoch + 1);
      expectDomainErrorCode(invalidLimit, "run_start_list_limit_invalid");
    }),
  );
});

it.effect("两个 SQLite 连接竞争 barrier 与 cancel owner 时只产生一次 revision 和一个 owner", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codework-run-start-cancel-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const withFileStore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(makeFileStoreLayer(dbPath)));

  return Effect.gen(function* () {
    const dispatching = yield* withFileStore(prepareDispatchingIntent("cancel-sqlite-race"));
    const requestFromConnection = (reason: string, requestedAtUnixMs: number) =>
      withFileStore(
        Effect.gen(function* () {
          const store = yield* CompositionRunStartStore;
          return yield* store.requestCancellation({
            runId: dispatching.runId,
            expectedRevision: dispatching.revision,
            requestedAtUnixMs,
            reason,
          });
        }),
      );
    const requests = yield* Effect.all(
      [
        Effect.result(requestFromConnection("连接 A 请求取消。", 130)),
        Effect.result(requestFromConnection("连接 B 请求取消。", 131)),
      ],
      { concurrency: "unbounded" },
    );
    assert.equal(requests.filter((request) => request._tag === "Success").length, 2);
    const persistedRequest = yield* withFileStore(
      Effect.gen(function* () {
        const store = yield* CompositionRunStartStore;
        return Option.getOrThrow(yield* store.getStart(dispatching.runId));
      }),
    );
    assert.equal(persistedRequest.revision, dispatching.revision + 1);
    assert.include(["连接 A 请求取消。", "连接 B 请求取消。"], persistedRequest.cancelReason);
    assert.include([130, 131], persistedRequest.cancelRequestedAtUnixMs);

    const claimFromConnection = (claimId: string) =>
      withFileStore(
        Effect.gen(function* () {
          const store = yield* CompositionRunStartStore;
          return yield* store.claimCancellationRecovery({
            runId: persistedRequest.runId,
            expectedRevision: persistedRequest.revision,
            claimId,
            claimedAtUnixMs: 140,
            leaseExpiresAtUnixMs: 240,
          });
        }),
      );
    const claims = yield* Effect.all(
      [
        Effect.result(claimFromConnection("claim-cancel-sqlite-a")),
        Effect.result(claimFromConnection("claim-cancel-sqlite-b")),
      ],
      { concurrency: "unbounded" },
    );
    const persistedClaim = yield* withFileStore(
      Effect.gen(function* () {
        const store = yield* CompositionRunStartStore;
        return Option.getOrThrow(yield* store.getStart(dispatching.runId));
      }),
    );

    assert.equal(
      claims.filter((claim) => claim._tag === "Success" && claim.success.claimed).length,
      1,
    );
    assert.equal(
      claims.filter((claim) => claim._tag === "Success" && !claim.success.claimed).length,
      1,
    );
    assert.equal(persistedClaim.ownerEpoch, dispatching.ownerEpoch + 1);
    assert.include(["claim-cancel-sqlite-a", "claim-cancel-sqlite-b"], persistedClaim.claimId);
    assert.equal(persistedClaim.ownerLeaseExpiresAtUnixMs, 240);
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("accepted、manual_pending 与 accepted-settled 的双连接竞争只写一次 barrier", () => {
  const tempDir = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "codework-run-start-cancel-sources-"),
  );
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const withFileStore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(makeFileStoreLayer(dbPath)));

  return Effect.gen(function* () {
    const sources = yield* withFileStore(
      Effect.gen(function* () {
        const store = yield* CompositionRunStartStore;
        const accepted = yield* prepareAcceptedIntent("cancel-race-source-accepted");
        const manualAccepted = yield* prepareAcceptedIntent("cancel-race-source-manual");
        const manual = yield* store.markAcceptedManualPending({
          runId: manualAccepted.runId,
          expectedRevision: manualAccepted.revision,
          claimId: manualAccepted.claimId ?? "",
          ownerEpoch: manualAccepted.ownerEpoch,
          runtimeTaskId: manualAccepted.runtimeTaskId,
          capabilityHandshakeId: manualAccepted.capabilityHandshakeId,
          outcomeCode: "run_start_manual_reconcile",
          outcomeDetail: "等待人工核对外部任务。",
          manualAtUnixMs: 140,
        });
        const acceptedToSettle = yield* prepareAcceptedIntent(
          "cancel-race-source-accepted-settled",
        );
        const acceptedSettled = yield* store.settleAccepted({
          runId: acceptedToSettle.runId,
          expectedRevision: acceptedToSettle.revision,
          claimId: acceptedToSettle.claimId ?? "",
          ownerEpoch: acceptedToSettle.ownerEpoch,
          settledAtUnixMs: 140,
        });
        return [
          { intent: accepted, sourceState: "accepted" },
          { intent: manual, sourceState: "manual_pending" },
          { intent: acceptedSettled, sourceState: "accepted_settled" },
        ] as const;
      }),
    );

    for (const source of sources) {
      const requestFromConnection = (reason: string, requestedAtUnixMs: number) =>
        withFileStore(
          Effect.gen(function* () {
            const store = yield* CompositionRunStartStore;
            return yield* store.requestCancellation({
              runId: source.intent.runId,
              expectedRevision: source.intent.revision,
              requestedAtUnixMs,
              reason,
            });
          }),
        );
      const requests = yield* Effect.all(
        [
          Effect.result(requestFromConnection("连接 A 请求取消。", 150)),
          Effect.result(requestFromConnection("连接 B 请求取消。", 151)),
        ],
        { concurrency: "unbounded" },
      );
      const persisted = yield* withFileStore(
        Effect.gen(function* () {
          const store = yield* CompositionRunStartStore;
          return Option.getOrThrow(yield* store.getStart(source.intent.runId));
        }),
      );

      assert.equal(requests.filter((request) => request._tag === "Success").length, 2);
      assert.deepInclude(persisted, {
        state: "cancel_pending",
        revision: source.intent.revision + 1,
        cancelSourceState: source.sourceState,
        cancelSourceRevision: source.intent.revision,
        cancelSourceClaimId: source.intent.claimId,
        cancelSourceOwnerEpoch: source.intent.ownerEpoch,
        cancelStartOutcome: "accepted",
      });
      assert.include(["连接 A 请求取消。", "连接 B 请求取消。"], persisted.cancelReason);
      assert.include([150, 151], persisted.cancelRequestedAtUnixMs);
    }
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
