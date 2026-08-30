import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import type {
  CompositionRunStartExecutionStoreShape,
  CompositionRunStartIntent,
} from "../persistence/Services/CompositionRunStartStore.ts";
import { dispatchCompositionRunStart } from "./CompositionClaimedRunStart.ts";
import {
  makeCompositionRunStartDigests,
  type CompositionRunStartRecoveryPolicy,
} from "./CompositionRunStartLifecycle.ts";

export const COMPOSITION_RUN_START_OWNER_LEASE_MS = 60_000;

export type CompositionRunStartSetup = {
  readonly taskId: string;
  readonly projectId: string;
  readonly threadId: string | null;
  readonly parentTaskId: string | null;
  readonly runId: string;
  readonly previousRunId: string | null;
  readonly assigneeKind: string;
  readonly assigneeId: string;
  readonly mode: string;
  readonly dependsOnTaskIds: ReadonlyArray<string>;
  readonly agentId: string;
  readonly runtimeId: string;
  readonly attempt: number;
  readonly promptDigest: string;
  readonly workspaceRootDigest: string | null;
  readonly model: string | null;
  readonly externalTargetIdentity:
    | import("./CompositionRunStartLifecycle.ts").CompositionRunStartExternalTargetIdentity
    | null;
  readonly capabilityIds: ReadonlyArray<string> | null;
};

export type CompositionRunStartDriverResult = {
  readonly runtimeTaskId?: string;
  readonly capabilityHandshakeId?: string;
};

type StartFailure = {
  readonly code: string;
  readonly detail: string;
};

export const DEFAULT_COMPOSITION_RUN_START_RECOVERY_POLICY = {
  mode: "manual",
  requiredReceipt: "none",
} satisfies CompositionRunStartRecoveryPolicy;

export const compositionRunStartWinnerFailure = (
  winner: CompositionRunStartIntent,
  inProgressDetail: string,
): StartFailure => {
  if (winner.state === "settled" && winner.outcomeCode !== null) {
    return {
      code: winner.outcomeCode,
      detail: winner.outcomeDetail ?? "持久化启动赢家已记录失败。",
    };
  }
  if (winner.state === "quarantined") {
    return {
      code: winner.outcomeCode ?? "run_start_quarantined",
      detail: winner.outcomeDetail ?? "持久化启动意图已进入隔离状态。",
    };
  }
  return { code: "run_start_in_progress", detail: inProgressDetail };
};

export const claimCompositionRunStartSetup = (
  store: CompositionRunStartExecutionStoreShape,
  setup: CompositionRunStartSetup,
) =>
  Effect.gen(function* () {
    const preparedAtUnixMs = yield* Clock.currentTimeMillis;
    const digests = makeCompositionRunStartDigests({
      taskId: setup.taskId,
      projectId: setup.projectId,
      threadId: setup.threadId ?? undefined,
      parentTaskId: setup.parentTaskId ?? undefined,
      runId: setup.runId,
      previousRunId: setup.previousRunId,
      assigneeKind: setup.assigneeKind,
      assigneeId: setup.assigneeId,
      mode: setup.mode,
      dependsOnTaskIds: setup.dependsOnTaskIds,
      agentId: setup.agentId,
      runtimeId: setup.runtimeId,
      attempt: setup.attempt,
      promptDigest: setup.promptDigest,
      workspaceRootDigest: setup.workspaceRootDigest ?? undefined,
      model: setup.model ?? undefined,
      externalTargetIdentity: setup.externalTargetIdentity,
      capabilityIds: setup.capabilityIds,
    });
    const prepared = yield* store.prepareStart({
      taskId: setup.taskId,
      runId: setup.runId,
      previousRunId: setup.previousRunId,
      agentId: setup.agentId,
      runtimeId: setup.runtimeId,
      attempt: setup.attempt,
      ...digests,
      createdAtUnixMs: preparedAtUnixMs,
    });
    const claimedAtUnixMs = Math.max(yield* Clock.currentTimeMillis, prepared.updatedAtUnixMs);
    return yield* store.claimPrepared({
      runId: prepared.runId,
      expectedRevision: prepared.revision,
      claimId: NodeCrypto.randomUUID(),
      claimedAtUnixMs,
      leaseExpiresAtUnixMs: claimedAtUnixMs + COMPOSITION_RUN_START_OWNER_LEASE_MS,
    });
  });

export const releaseCompositionRunStartPreparation = (
  store: CompositionRunStartExecutionStoreShape,
  intent: CompositionRunStartIntent,
) =>
  Effect.gen(function* () {
    if (intent.claimId === null) return;
    const currentOption = yield* store.getStart(intent.runId);
    if (currentOption._tag === "None") return;
    const current = currentOption.value;
    if (current.state !== "preparing" || current.claimId !== intent.claimId) return;
    const releasedAtUnixMs = Math.max(yield* Clock.currentTimeMillis, current.updatedAtUnixMs);
    yield* store.releasePreparation({
      runId: current.runId,
      expectedRevision: current.revision,
      claimId: current.claimId,
      releasedAtUnixMs,
      ownerEpoch: current.ownerEpoch,
    });
  });

export const quarantineCompositionRunStartUnknownCapabilities = (
  store: CompositionRunStartExecutionStoreShape,
  setup: Omit<CompositionRunStartSetup, "capabilityIds">,
) =>
  Effect.gen(function* () {
    const setupClaim = yield* claimCompositionRunStartSetup(store, {
      ...setup,
      capabilityIds: null,
    });
    if (!setupClaim.claimed) return setupClaim.intent;
    const quarantinedAtUnixMs = Math.max(
      yield* Clock.currentTimeMillis,
      setupClaim.intent.updatedAtUnixMs,
    );
    return yield* store.quarantine({
      runId: setupClaim.intent.runId,
      expectedRevision: setupClaim.intent.revision,
      claimId: setupClaim.intent.claimId ?? "",
      ownerEpoch: setupClaim.intent.ownerEpoch,
      outcomeCode: "run_start_legacy_input_capabilities_unknown",
      outcomeDetail: "旧加密输入无法确认 capabilityIds，已阻止自动外部启动。",
      quarantinedAtUnixMs,
    });
  });

export const runCompositionWithPersistedStart = <
  A,
  F extends StartFailure,
  EAccepted,
  ERejected,
>(input: {
  readonly store?: CompositionRunStartExecutionStoreShape;
  readonly setup: CompositionRunStartSetup;
  readonly intent?: CompositionRunStartIntent;
  readonly policy?: CompositionRunStartRecoveryPolicy;
  readonly capabilityGrantIds: ReadonlyArray<string>;
  readonly start: Effect.Effect<CompositionRunStartDriverResult, F>;
  readonly onAccepted: (
    startResult: CompositionRunStartDriverResult,
  ) => Effect.Effect<A, EAccepted>;
  readonly onRejected: (failure: F) => Effect.Effect<A, ERejected>;
  readonly makeFailure: (failure: StartFailure) => F;
}) =>
  Effect.gen(function* () {
    if (input.store === undefined) {
      const startResult = yield* Effect.result(input.start);
      return startResult._tag === "Failure"
        ? yield* input.onRejected(startResult.failure)
        : yield* input.onAccepted(startResult.success);
    }

    const store = input.store;
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        let intent = input.intent;
        if (intent === undefined) {
          const claimed = yield* claimCompositionRunStartSetup(store, input.setup);
          if (claimed.claimed) {
            intent = claimed.intent;
          } else {
            const winner = claimed.intent;
            if (
              (winner.state === "accepted" || winner.state === "settled") &&
              winner.outcomeCode === null
            ) {
              return yield* input.onAccepted({
                ...(winner.runtimeTaskId === null ? {} : { runtimeTaskId: winner.runtimeTaskId }),
                ...(winner.capabilityHandshakeId === null
                  ? {}
                  : { capabilityHandshakeId: winner.capabilityHandshakeId }),
              });
            }
            return yield* Effect.fail(
              input.makeFailure(
                compositionRunStartWinnerFailure(
                  winner,
                  `Run ${input.setup.runId} 的启动已由其他 Runtime owner 认领。`,
                ),
              ),
            );
          }
        }

        if (intent.state === "preparing") {
          const markExit = yield* Effect.exit(
            store.markDispatching({
              runId: intent.runId,
              expectedRevision: intent.revision,
              claimId: intent.claimId ?? "",
              ownerEpoch: intent.ownerEpoch,
              dispatchedAtUnixMs: Math.max(yield* Clock.currentTimeMillis, intent.updatedAtUnixMs),
            }),
          );
          if (markExit._tag === "Failure") {
            yield* releaseCompositionRunStartPreparation(store, intent);
            return yield* Effect.failCause(markExit.cause);
          }
          intent = markExit.value;
        }
        if (intent.state !== "dispatching") {
          return yield* Effect.fail(
            input.makeFailure({
              code: "run_start_state_conflict",
              detail: `Run ${intent.runId} 当前状态 ${intent.state} 不能执行外部启动。`,
            }),
          );
        }

        return yield* restore(
          dispatchCompositionRunStart({
            store,
            intent,
            policy: input.policy ?? DEFAULT_COMPOSITION_RUN_START_RECOVERY_POLICY,
            capabilityGrantIds: input.capabilityGrantIds,
            start: input.start,
            onAccepted: (receipt) =>
              input.onAccepted({
                ...(receipt.runtimeTaskId === null ? {} : { runtimeTaskId: receipt.runtimeTaskId }),
                ...(receipt.capabilityHandshakeId === null
                  ? {}
                  : { capabilityHandshakeId: receipt.capabilityHandshakeId }),
              }),
            onRejected: input.onRejected,
            mapReceiptFailure: (failure) =>
              input.makeFailure({ code: failure.code, detail: failure.detail }),
          }),
        );
      }),
    );
  });
