import * as NodeCrypto from "node:crypto";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  CompositionRunStartIntent,
  CompositionRunStartManualRecoverySnapshot,
  CompositionRunStartStoreError,
  CompositionRunStartStoreShape,
} from "../persistence/Services/CompositionRunStartStore.ts";
import type { CompositionTaskInputStoreShape } from "../persistence/Services/CompositionTaskInputStore.ts";
import type { CompositionTaskStoreShape } from "../persistence/Services/CompositionTaskStore.ts";
import type { CompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import {
  deferCompositionRunStartManualRecovery,
  recoverClaimedCompositionRunStartManualCandidate,
} from "./CompositionRunStartManualRecoveryCandidate.ts";
import { COMPOSITION_RUN_START_OWNER_LEASE_MS } from "./CompositionRunStartOwnerLease.ts";
import type { CompositionRunStartRecoveryReconciliation } from "./CompositionRunStartRecoveryPolicy.ts";

const MANUAL_RECOVERY_PAGE_SIZE = 200;

export type CompositionRunStartManualRecoveryOutcome = {
  readonly taskId: string;
  readonly runId: string;
  readonly action: "defer" | "resume" | "settle";
  readonly code: string;
  readonly detail: string;
  readonly nextRecoveryAtUnixMs?: number;
};

export type CompositionRunStartManualRecoveryReceipt = {
  readonly type: "composition.run_starts.manual_recovered";
  readonly recoveredAtUnixMs: number;
  readonly outcomes: ReadonlyArray<CompositionRunStartManualRecoveryOutcome>;
  readonly nextRecoveryAtUnixMs?: number;
};

type ManualRunStartStore = Pick<
  CompositionRunStartStoreShape,
  | "getManualRecoveryScanUpperBound"
  | "listManualRecoveries"
  | "claimManualRecovery"
  | "releaseManualRecovery"
  | "resumeManualRecoveryToAccepted"
  | "settleManualRecovery"
  | "renewOwnerLease"
>;

export interface CompositionRunStartManualRecoveryOptions {
  readonly runStartStore: ManualRunStartStore;
  readonly taskStore: Pick<
    CompositionTaskStoreShape,
    "getTask" | "getRun" | "getLatestRun" | "renewLease"
  >;
  readonly inputStore: Pick<CompositionTaskInputStoreShape, "get">;
  readonly driverRegistry: Pick<CompositionAgentDriverRegistry, "get">;
  readonly reconciled: ReadonlySet<CompositionRunStartRecoveryReconciliation>;
  readonly makeClaimId?: (intent: CompositionRunStartIntent) => string;
  readonly now?: Effect.Effect<number>;
  readonly pageSize?: number;
}

const nowOf = (options: CompositionRunStartManualRecoveryOptions): Effect.Effect<number> =>
  options.now ?? Clock.currentTimeMillis;

const snapshotOf = (
  intent: CompositionRunStartIntent,
): CompositionRunStartManualRecoverySnapshot | undefined =>
  intent.outcomeCode === null
    ? undefined
    : {
        runtimeTaskId: intent.runtimeTaskId,
        capabilityHandshakeId: intent.capabilityHandshakeId,
        outcomeCode: intent.outcomeCode,
        outcomeDetail: intent.outcomeDetail,
      };

const recoverCandidate = (
  options: CompositionRunStartManualRecoveryOptions,
  intent: CompositionRunStartIntent,
) =>
  Effect.gen(function* () {
    const nowUnixMs = yield* nowOf(options);
    const claimedAtUnixMs = Math.max(nowUnixMs, intent.updatedAtUnixMs);
    const snapshot = snapshotOf(intent);
    if (intent.state !== "manual_pending" || snapshot === undefined) {
      return deferCompositionRunStartManualRecovery(
        intent,
        nowUnixMs,
        "run_start_manual_snapshot_invalid",
        "扫描候选不是完整的 manual_pending receipt 快照，已跳过本轮处理。",
      );
    }
    const claim = yield* options.runStartStore.claimManualRecovery({
      runId: intent.runId,
      expectedRevision: intent.revision,
      expectedOwnerEpoch: intent.ownerEpoch,
      claimId: options.makeClaimId?.(intent) ?? `manual-recovery:${NodeCrypto.randomUUID()}`,
      claimedAtUnixMs,
      leaseExpiresAtUnixMs: claimedAtUnixMs + COMPOSITION_RUN_START_OWNER_LEASE_MS,
      ...snapshot,
    });
    if (!claim.claimed) {
      return deferCompositionRunStartManualRecovery(
        intent,
        nowUnixMs,
        "run_start_manual_claim_unavailable",
        "manual receipt 已由其他恢复 worker 认领，当前 worker 未执行外部操作。",
      );
    }
    return yield* recoverClaimedCompositionRunStartManualCandidate(options, claim.intent, snapshot);
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.interruptors(cause).size > 0
        ? Effect.interrupt
        : nowOf(options).pipe(
            Effect.map((nowUnixMs) =>
              deferCompositionRunStartManualRecovery(
                intent,
                nowUnixMs,
                "run_start_manual_candidate_unavailable",
                "manual receipt 候选当前无法安全认领或持久化，已隔离并继续扫描。",
              ),
            ),
          ),
    ),
  );

export const recoverCompositionRunStartManualPending = (
  options: CompositionRunStartManualRecoveryOptions,
): Effect.Effect<CompositionRunStartManualRecoveryReceipt, CompositionRunStartStoreError> =>
  Effect.gen(function* () {
    const outcomes: CompositionRunStartManualRecoveryOutcome[] = [];
    const scanUpperBound = yield* options.runStartStore.getManualRecoveryScanUpperBound;
    if (Option.isSome(scanUpperBound)) {
      const throughRunId = scanUpperBound.value;
      const pageSize = Math.min(500, Math.max(1, options.pageSize ?? MANUAL_RECOVERY_PAGE_SIZE));
      const seenRunIds = new Set<string>();
      let after: { readonly runId: string } | undefined;
      while (true) {
        const intents = yield* options.runStartStore.listManualRecoveries({
          limit: pageSize,
          throughRunId,
          ...(after === undefined ? {} : { after }),
        });
        if (intents.length === 0) break;
        for (const intent of intents) {
          if (seenRunIds.has(intent.runId)) continue;
          seenRunIds.add(intent.runId);
          outcomes.push(yield* recoverCandidate(options, intent));
        }
        const last = intents.at(-1);
        if (last === undefined || intents.length < pageSize) break;
        if (after !== undefined && last.runId <= after.runId) break;
        after = { runId: last.runId };
      }
    }

    const nextRecoveryAtUnixMs = outcomes.reduce<number | undefined>((earliest, outcome) => {
      if (outcome.nextRecoveryAtUnixMs === undefined) return earliest;
      return earliest === undefined
        ? outcome.nextRecoveryAtUnixMs
        : Math.min(earliest, outcome.nextRecoveryAtUnixMs);
    }, undefined);
    return {
      type: "composition.run_starts.manual_recovered" as const,
      recoveredAtUnixMs: yield* nowOf(options),
      outcomes,
      ...(nextRecoveryAtUnixMs === undefined ? {} : { nextRecoveryAtUnixMs }),
    };
  });
