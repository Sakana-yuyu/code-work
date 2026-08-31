import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  CompositionRunStartStoreDomainError,
  type CompositionRunStartIntent,
  type CompositionRunStartStoreError,
  type CompositionRunStartStoreShape,
} from "../persistence/Services/CompositionRunStartStore.ts";
import type { CompositionTaskRecoveryInput } from "../persistence/Services/CompositionTaskInputStore.ts";
import type {
  CompositionTaskStoreError,
  CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import type { CompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import type {
  CompositionAgentDriver,
  CompositionAgentDriverFailure,
} from "./CompositionOrchestrator.ts";
import {
  sameCompositionRunStartRunIdentity,
  sameCompositionRunStartTaskIdentity,
} from "./CompositionRunStartAcceptedProjection.ts";
import { requestCompositionRunStartCancellationBarrier } from "./CompositionRunStartCancellationRequest.ts";
import { validateCompositionRunStartReceipt } from "./CompositionRunStartLifecycle.ts";
import { COMPOSITION_RUN_START_OWNER_LEASE_MS } from "./CompositionRunStartOwnerLease.ts";
import {
  recoverCompositionRunStartCapabilities,
  validateCompositionRunStartAcceptedCapabilities,
} from "./CompositionRunStartRecoveryCapabilities.ts";
import { recoverCompositionRunStartRuntimeLease } from "./CompositionRunStartRecoveryResources.ts";
import type {
  CompositionRunStartRecoveryCandidate,
  CompositionRunStartRecoveryPlan,
} from "./CompositionRunStartRecoveryPolicy.ts";

type ClaimedIntent =
  | { readonly _tag: "Claimed"; readonly intent: CompositionRunStartIntent }
  | { readonly _tag: "Deferred"; readonly outcome: CompositionRunStartRecoveryPlan };

export interface CompositionRunStartRecoveryExecutorCallbacks<E> {
  readonly projectAccepted: (input: {
    readonly candidate: CompositionRunStartRecoveryCandidate;
    readonly driver: CompositionAgentDriver;
    readonly receipt: {
      readonly runtimeTaskId: string | null;
      readonly capabilityHandshakeId: string | null;
    };
  }) => Effect.Effect<
    | { readonly _tag: "Projected" }
    | {
        readonly _tag: "Deferred" | "Manual" | "Quarantine";
        readonly code: string;
        readonly detail: string;
      },
    E
  >;
  readonly projectAcceptedManual: (input: {
    readonly candidate: CompositionRunStartRecoveryCandidate;
    readonly code: string;
    readonly detail: string;
  }) => Effect.Effect<void, E>;
  readonly executeClaimed: (input: {
    readonly candidate: CompositionRunStartRecoveryCandidate;
    readonly recoveryInput: CompositionTaskRecoveryInput;
    readonly driver: CompositionAgentDriver;
    readonly intent: CompositionRunStartIntent;
    readonly plan: CompositionRunStartRecoveryPlan;
  }) => Effect.Effect<void, E>;
}

export interface CompositionRunStartRecoveryExecutorOptions<
  E,
> extends CompositionRunStartRecoveryExecutorCallbacks<E> {
  readonly runStartStore: CompositionRunStartStoreShape;
  readonly taskStore: CompositionTaskStoreShape;
  readonly driverRegistry: CompositionAgentDriverRegistry;
  readonly grantRegistry?: Pick<
    import("./CapabilityGrantRegistry.ts").CapabilityGrantRegistryShape,
    "issue" | "validateForRecovery"
  >;
  readonly makeFailure: (code: string, detail: string) => CompositionAgentDriverFailure;
}

type RecoveryPreflight =
  | {
      readonly _tag: "Ready";
      readonly candidate: CompositionRunStartRecoveryCandidate;
    }
  | {
      readonly _tag: "CancellationRequested";
      readonly candidate: CompositionRunStartRecoveryCandidate;
    }
  | {
      readonly _tag: "Rejected";
      readonly code: string;
      readonly detail: string;
    };

type RecoveryPreflightPurpose = "start" | "accepted";

const preflightClaimedRecovery = (
  taskStore: Pick<CompositionTaskStoreShape, "getTask" | "getRun" | "getLatestRun">,
  candidate: CompositionRunStartRecoveryCandidate,
  purpose: RecoveryPreflightPurpose,
): Effect.Effect<RecoveryPreflight, CompositionTaskStoreError> =>
  Effect.gen(function* () {
    const [taskOption, runOption, latestRunOption] = yield* Effect.all(
      [
        taskStore.getTask(candidate.task.taskId),
        taskStore.getRun(candidate.run.runId),
        taskStore.getLatestRun(candidate.task.taskId),
      ] as const,
      { concurrency: "unbounded" },
    );
    if (Option.isNone(taskOption)) {
      return {
        _tag: "Rejected",
        code: "run_start_recovery_preflight_task_missing",
        detail: "Run Start 恢复认领后 Task 已不存在，已阻止外部启动。",
      };
    }
    if (Option.isNone(runOption)) {
      return {
        _tag: "Rejected",
        code: "run_start_recovery_preflight_run_missing",
        detail: "Run Start 恢复认领后 Run 已不存在，已阻止外部启动。",
      };
    }
    if (Option.isNone(latestRunOption) || latestRunOption.value.runId !== candidate.run.runId) {
      return {
        _tag: "Rejected",
        code: "run_start_recovery_preflight_run_replaced",
        detail: "Run Start 恢复认领后已有更新 Run，已阻止旧 Run 外部启动。",
      };
    }

    const task = taskOption.value;
    const run = runOption.value;
    if (
      !sameCompositionRunStartTaskIdentity(task, candidate.task) ||
      !sameCompositionRunStartRunIdentity(run, candidate.run)
    ) {
      return {
        _tag: "Rejected",
        code: "run_start_recovery_preflight_identity_changed",
        detail: "Run Start 恢复认领后 Task/Run 启动身份已变化，已阻止外部启动。",
      };
    }
    const statusReady =
      purpose === "accepted"
        ? task.status === run.status &&
          (task.status === "queued" || task.status === "waiting_input")
        : task.status === "queued" && run.status === "queued";
    if (!statusReady) {
      return {
        _tag: "Rejected",
        code: "run_start_recovery_preflight_status_changed",
        detail:
          purpose === "accepted"
            ? `Run Start accepted 恢复认领后 Task/Run 状态已变为 ${task.status}/${run.status}，已阻止自动投影。`
            : `Run Start 恢复认领后 Task/Run 状态已变为 ${task.status}/${run.status}，已阻止外部启动。`,
      };
    }
    if (run.cancelRequestedAtUnixMs !== undefined) {
      if (purpose === "accepted") {
        return {
          _tag: "CancellationRequested",
          candidate: { ...candidate, task, run },
        };
      }
      return {
        _tag: "Rejected",
        code: "run_start_recovery_preflight_cancel_requested",
        detail: "Run Start 恢复认领后已存在取消请求，已阻止外部启动。",
      };
    }
    return {
      _tag: "Ready",
      candidate: { ...candidate, task, run },
    };
  });

const recoveryOutcome = (
  intent: Pick<CompositionRunStartIntent, "taskId" | "runId">,
  action: CompositionRunStartRecoveryPlan["action"],
  code: string,
  detail: string,
  retryAtUnixMs?: number,
): CompositionRunStartRecoveryPlan => ({
  taskId: intent.taskId,
  runId: intent.runId,
  action,
  code,
  detail,
  ...(retryAtUnixMs === undefined ? {} : { retryAtUnixMs }),
});

const retryAtForWinner = (
  winner: CompositionRunStartIntent,
  nowUnixMs: number,
): number | undefined => {
  if (
    (winner.state === "preparing" ||
      winner.state === "dispatching" ||
      winner.state === "accepted") &&
    winner.ownerLeaseExpiresAtUnixMs !== null
  ) {
    return Math.max(nowUnixMs + 1, winner.ownerLeaseExpiresAtUnixMs);
  }
  return winner.state === "prepared" || winner.state === "accepted" ? nowUnixMs + 1 : undefined;
};

const deferForWinner = (
  winner: CompositionRunStartIntent,
  nowUnixMs: number,
  detail: string,
): CompositionRunStartRecoveryPlan =>
  recoveryOutcome(
    winner,
    "defer",
    "run_start_recovery_claim_unavailable",
    detail,
    retryAtForWinner(winner, nowUnixMs),
  );

const currentIntent = (
  store: CompositionRunStartStoreShape,
  runId: string,
): Effect.Effect<CompositionRunStartIntent, CompositionRunStartStoreError> =>
  store.getStart(runId).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new CompositionRunStartStoreDomainError({
              code: "run_start_not_found",
              detail: "恢复认领期间 Run Start 意图已不存在。",
              runId,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );

const claimPrepared = (
  store: CompositionRunStartStoreShape,
  intent: CompositionRunStartIntent,
  nowUnixMs: number,
): Effect.Effect<ClaimedIntent, CompositionRunStartStoreError> =>
  store
    .claimPrepared({
      runId: intent.runId,
      expectedRevision: intent.revision,
      claimId: `startup-recovery:${NodeCrypto.randomUUID()}`,
      claimedAtUnixMs: nowUnixMs,
      leaseExpiresAtUnixMs: nowUnixMs + COMPOSITION_RUN_START_OWNER_LEASE_MS,
    })
    .pipe(
      Effect.map((claim) =>
        claim.claimed
          ? ({ _tag: "Claimed", intent: claim.intent } as const)
          : ({
              _tag: "Deferred",
              outcome: deferForWinner(
                claim.intent,
                nowUnixMs,
                "Run Start setup 已由其他恢复实例认领。",
              ),
            } as const),
      ),
    );

const resetExpiredPreparation = (
  store: CompositionRunStartStoreShape,
  intent: CompositionRunStartIntent,
  nowUnixMs: number,
): Effect.Effect<CompositionRunStartIntent, CompositionRunStartStoreError> =>
  store
    .resetPreparationForRecovery({
      runId: intent.runId,
      expectedRevision: intent.revision,
      ownerEpoch: intent.ownerEpoch,
      resetAtUnixMs: nowUnixMs,
    })
    .pipe(
      Effect.catchIf(
        (error) =>
          error._tag === "CompositionRunStartStoreDomainError" &&
          (error.code === "run_start_revision_conflict" ||
            error.code === "run_start_state_conflict" ||
            error.code === "run_start_claim_conflict"),
        () => currentIntent(store, intent.runId),
      ),
    );

const claimRecoverableIntent = (
  store: CompositionRunStartStoreShape,
  intent: CompositionRunStartIntent,
): Effect.Effect<ClaimedIntent, CompositionRunStartStoreError> =>
  Effect.gen(function* () {
    const nowUnixMs = Math.max(yield* Clock.currentTimeMillis, intent.updatedAtUnixMs);
    if (intent.state === "prepared") return yield* claimPrepared(store, intent, nowUnixMs);
    if (intent.state === "preparing") {
      const leaseExpiresAtUnixMs = intent.ownerLeaseExpiresAtUnixMs;
      if (leaseExpiresAtUnixMs === null) {
        return {
          _tag: "Deferred",
          outcome: recoveryOutcome(
            intent,
            "manual",
            "run_start_recovery_owner_lease_missing",
            "preparing Run Start 缺少持久 owner lease，需要人工核对。",
          ),
        };
      }
      if (leaseExpiresAtUnixMs > nowUnixMs) {
        return {
          _tag: "Deferred",
          outcome: deferForWinner(
            intent,
            nowUnixMs,
            "Run Start setup owner 尚未到期，恢复将在 lease 到期后重试。",
          ),
        };
      }
      const reset = yield* resetExpiredPreparation(store, intent, nowUnixMs);
      if (reset.state !== "prepared") {
        return {
          _tag: "Deferred",
          outcome: deferForWinner(reset, nowUnixMs, "Run Start setup 状态已由其他实例推进。"),
        };
      }
      return yield* claimPrepared(store, reset, nowUnixMs);
    }
    if (intent.state === "dispatching") {
      const leaseExpiresAtUnixMs = intent.ownerLeaseExpiresAtUnixMs;
      if (leaseExpiresAtUnixMs === null) {
        return {
          _tag: "Deferred",
          outcome: recoveryOutcome(
            intent,
            "manual",
            "run_start_recovery_owner_lease_missing",
            "dispatching Run Start 缺少持久 owner lease，需要人工核对。",
          ),
        };
      }
      if (leaseExpiresAtUnixMs > nowUnixMs) {
        return {
          _tag: "Deferred",
          outcome: deferForWinner(
            intent,
            nowUnixMs,
            "Run Start dispatch owner 尚未到期，恢复将在 lease 到期后重试。",
          ),
        };
      }
      const claim = yield* store.claimDispatchRecovery({
        runId: intent.runId,
        expectedRevision: intent.revision,
        claimId: `startup-recovery:${NodeCrypto.randomUUID()}`,
        claimedAtUnixMs: nowUnixMs,
        leaseExpiresAtUnixMs: nowUnixMs + COMPOSITION_RUN_START_OWNER_LEASE_MS,
      });
      return claim.claimed
        ? { _tag: "Claimed", intent: claim.intent }
        : {
            _tag: "Deferred",
            outcome: deferForWinner(
              claim.intent,
              nowUnixMs,
              "Run Start dispatch 已由其他恢复实例认领。",
            ),
          };
    }
    return {
      _tag: "Deferred",
      outcome: recoveryOutcome(
        intent,
        "defer",
        "run_start_recovery_claim_unavailable",
        `Run Start 当前状态 ${intent.state} 不需要新的恢复认领。`,
      ),
    };
  });

const claimAcceptedIntent = (
  store: CompositionRunStartStoreShape,
  intent: CompositionRunStartIntent,
): Effect.Effect<ClaimedIntent, CompositionRunStartStoreError> =>
  Effect.gen(function* () {
    const nowUnixMs = Math.max(yield* Clock.currentTimeMillis, intent.updatedAtUnixMs);
    const claim = yield* store.claimAcceptedRecovery({
      runId: intent.runId,
      expectedRevision: intent.revision,
      claimId: `startup-recovery:${NodeCrypto.randomUUID()}`,
      claimedAtUnixMs: nowUnixMs,
      leaseExpiresAtUnixMs: nowUnixMs + COMPOSITION_RUN_START_OWNER_LEASE_MS,
    });
    if (claim.claimed) return { _tag: "Claimed", intent: claim.intent };
    if (
      claim.intent.state === "accepted" &&
      (claim.intent.claimId === null) !== (claim.intent.ownerLeaseExpiresAtUnixMs === null)
    ) {
      return {
        _tag: "Deferred",
        outcome: recoveryOutcome(
          claim.intent,
          "manual",
          "run_start_recovery_owner_lease_incomplete",
          "accepted Run Start 的 claim 与 owner lease 不完整，需要人工核对。",
        ),
      };
    }
    return {
      _tag: "Deferred",
      outcome: deferForWinner(
        claim.intent,
        nowUnixMs,
        "Run Start accepted receipt 已由其他恢复实例认领。",
      ),
    };
  });

const quarantineClaimed = (
  store: CompositionRunStartStoreShape,
  intent: CompositionRunStartIntent,
  code: string,
  detail: string,
): Effect.Effect<void, CompositionRunStartStoreError> =>
  Effect.gen(function* () {
    yield* store.quarantine({
      runId: intent.runId,
      expectedRevision: intent.revision,
      claimId: intent.claimId ?? "",
      ownerEpoch: intent.ownerEpoch,
      outcomeCode: code,
      outcomeDetail: detail,
      quarantinedAtUnixMs: Math.max(yield* Clock.currentTimeMillis, intent.updatedAtUnixMs),
    });
  });

const releaseAcceptedClaim = (
  store: CompositionRunStartStoreShape,
  intent: CompositionRunStartIntent,
): Effect.Effect<void, CompositionRunStartStoreError> =>
  Effect.gen(function* () {
    yield* store.releaseAcceptedRecovery({
      runId: intent.runId,
      expectedRevision: intent.revision,
      claimId: intent.claimId ?? "",
      ownerEpoch: intent.ownerEpoch,
      releasedAtUnixMs: Math.max(yield* Clock.currentTimeMillis, intent.updatedAtUnixMs),
    });
  });

export const makeCompositionRunStartRecoveryExecutor = <E>(
  options: CompositionRunStartRecoveryExecutorOptions<E>,
) => {
  const execute = (input: {
    readonly candidate: CompositionRunStartRecoveryCandidate;
    readonly recoveryInput: CompositionTaskRecoveryInput;
    readonly plan: CompositionRunStartRecoveryPlan;
  }): Effect.Effect<
    CompositionRunStartRecoveryPlan,
    E | CompositionRunStartStoreError | CompositionTaskStoreError | CompositionAgentDriverFailure
  > =>
    Effect.gen(function* () {
      const { candidate, plan } = input;
      if (plan.taskId !== candidate.task.taskId || plan.runId !== candidate.run.runId) {
        return yield* options.makeFailure(
          "run_start_recovery_plan_identity_mismatch",
          "Run Start 恢复计划与候选 Task/Run 身份不一致。",
        );
      }

      if (candidate.intent.state === "accepted") {
        if (plan.action === "defer") return plan;
        const claim = yield* claimAcceptedIntent(options.runStartStore, candidate.intent);
        if (claim._tag === "Deferred") return claim.outcome;
        const claimedCandidate = { ...candidate, intent: claim.intent };
        if (plan.action === "manual" || plan.action === "quarantine") {
          const code = plan.code ?? "run_start_recovery_manual_required";
          const detail = plan.detail ?? "已确认外部启动事实需要人工核对。";
          yield* options.projectAcceptedManual({
            candidate: claimedCandidate,
            code,
            detail,
          });
          return plan;
        }
        if (plan.action !== "accept") {
          yield* options.projectAcceptedManual({
            candidate: claimedCandidate,
            code: "run_start_accepted_plan_invalid",
            detail: `accepted Run Start 收到非法恢复计划 ${plan.action}，已转入人工核对。`,
          });
          return recoveryOutcome(
            claim.intent,
            "manual",
            "run_start_accepted_plan_invalid",
            `accepted Run Start 收到非法恢复计划 ${plan.action}，已转入人工核对。`,
          );
        }
        const preflight = yield* preflightClaimedRecovery(
          options.taskStore,
          claimedCandidate,
          "accepted",
        );
        if (preflight._tag === "CancellationRequested") {
          const cancellation = yield* requestCompositionRunStartCancellationBarrier(
            options.taskStore,
            options.runStartStore,
            {
              task: preflight.candidate.task,
              run: preflight.candidate.run,
              reason: "恢复 accepted receipt 时检测到既有 Run 取消请求。",
            },
          );
          if (cancellation._tag === "Requested") {
            return recoveryOutcome(
              cancellation.intent,
              "defer",
              "run_start_cancellation_pending",
              "Run Start 已进入持久取消恢复，等待终态证据收口。",
              cancellation.intent.ownerLeaseExpiresAtUnixMs ?? undefined,
            );
          }
          yield* options.projectAcceptedManual({
            candidate: claimedCandidate,
            code: cancellation.code,
            detail: cancellation.detail,
          });
          return recoveryOutcome(claim.intent, "manual", cancellation.code, cancellation.detail);
        }
        if (preflight._tag === "Rejected") {
          yield* options.projectAcceptedManual({
            candidate: claimedCandidate,
            code: preflight.code,
            detail: preflight.detail,
          });
          return recoveryOutcome(claim.intent, "manual", preflight.code, preflight.detail);
        }
        const currentCandidate = {
          ...preflight.candidate,
          intent: claimedCandidate.intent,
        };
        const driver = yield* options.driverRegistry.get(candidate.run.agentId);
        if (driver === undefined || driver.runtimeId !== candidate.run.runtimeId) {
          yield* releaseAcceptedClaim(options.runStartStore, claim.intent);
          return recoveryOutcome(
            claim.intent,
            "defer",
            "run_start_agent_driver_unavailable",
            "Run Start receipt 已持久化，等待对应 Agent Driver 可用后完成运行态投影。",
            claim.intent.ownerLeaseExpiresAtUnixMs ?? undefined,
          );
        }
        if (driver.startRecoveryPolicy === undefined) {
          const code = "run_start_driver_recovery_policy_missing";
          const detail = "Agent Driver 未声明 receipt 恢复策略，不能安全完成运行态投影。";
          yield* options.projectAcceptedManual({ candidate: claimedCandidate, code, detail });
          return recoveryOutcome(claim.intent, "manual", code, detail);
        }
        const receipt = yield* validateCompositionRunStartReceipt({
          policy: driver.startRecoveryPolicy,
          startResult: {
            ...(claim.intent.runtimeTaskId === null
              ? {}
              : { runtimeTaskId: claim.intent.runtimeTaskId }),
            ...(claim.intent.capabilityHandshakeId === null
              ? {}
              : { capabilityHandshakeId: claim.intent.capabilityHandshakeId }),
          },
          capabilityGrantIds: [...(candidate.run.capabilityGrantIds ?? [])],
        }).pipe(Effect.option);
        if (Option.isNone(receipt)) {
          const code = "run_start_accepted_receipt_invalid";
          const detail = "已持久化 Run Start receipt 未通过当前 Driver 策略校验，不能自动投影。";
          yield* options.projectAcceptedManual({ candidate: claimedCandidate, code, detail });
          return recoveryOutcome(claim.intent, "manual", code, detail);
        }
        const capabilityIds = candidate.capabilityIds;
        if (capabilityIds === null) {
          const code = "run_start_legacy_input_capabilities_unknown";
          const detail = "旧加密输入无法确认 capabilityIds，已阻止 accepted receipt 自动投影。";
          yield* options.projectAcceptedManual({ candidate: claimedCandidate, code, detail });
          return recoveryOutcome(claim.intent, "manual", code, detail);
        }
        const capabilityValidation = yield* validateCompositionRunStartAcceptedCapabilities({
          ...(options.grantRegistry === undefined ? {} : { grantRegistry: options.grantRegistry }),
          task: currentCandidate.task,
          run: currentCandidate.run,
          capabilityIds,
          nowUnixMs: yield* Clock.currentTimeMillis,
        });
        if (capabilityValidation._tag !== "Ready") {
          if (capabilityValidation._tag === "Deferred") {
            yield* releaseAcceptedClaim(options.runStartStore, claim.intent);
            return recoveryOutcome(
              claim.intent,
              "defer",
              capabilityValidation.code,
              capabilityValidation.detail,
              (yield* Clock.currentTimeMillis) + 30_000,
            );
          }
          yield* options.projectAcceptedManual({
            candidate: claimedCandidate,
            code: capabilityValidation.code,
            detail: capabilityValidation.detail,
          });
          return recoveryOutcome(
            claim.intent,
            "manual",
            capabilityValidation.code,
            capabilityValidation.detail,
          );
        }
        const lease = yield* recoverCompositionRunStartRuntimeLease(options.taskStore, {
          task: currentCandidate.task,
          run: capabilityValidation.run,
          ...(input.recoveryInput.workspaceRootDigest === undefined
            ? {}
            : { workspaceRootDigest: input.recoveryInput.workspaceRootDigest }),
        });
        if (lease._tag === "Deferred") {
          yield* releaseAcceptedClaim(options.runStartStore, claim.intent);
          return recoveryOutcome(
            claim.intent,
            "defer",
            lease.code,
            lease.detail,
            (yield* Clock.currentTimeMillis) + 30_000,
          );
        }
        const projection = yield* options.projectAccepted({
          candidate: { ...currentCandidate, run: lease.run },
          driver,
          receipt: receipt.value,
        });
        if (projection._tag === "Deferred") {
          yield* releaseAcceptedClaim(options.runStartStore, claim.intent);
          return recoveryOutcome(
            claim.intent,
            "defer",
            projection.code,
            projection.detail,
            (yield* Clock.currentTimeMillis) + 30_000,
          );
        }
        if (projection._tag === "Manual" || projection._tag === "Quarantine") {
          yield* options.projectAcceptedManual({
            candidate: { ...currentCandidate, run: lease.run },
            code: projection.code,
            detail: projection.detail,
          });
          return recoveryOutcome(
            claim.intent,
            projection._tag === "Manual" ? "manual" : "quarantine",
            projection.code,
            projection.detail,
          );
        }
        return plan;
      }

      if (plan.action === "defer") return plan;
      if (plan.action === "manual" || plan.action === "quarantine") {
        const claim = yield* claimRecoverableIntent(options.runStartStore, candidate.intent);
        if (claim._tag === "Deferred") return claim.outcome;
        const code = plan.code ?? "run_start_recovery_manual_required";
        const detail = plan.detail ?? "Run Start 恢复未获准自动执行。";
        yield* quarantineClaimed(options.runStartStore, claim.intent, code, detail);
        return plan;
      }
      const driver = yield* options.driverRegistry.get(candidate.run.agentId);
      if (driver === undefined || driver.runtimeId !== candidate.run.runtimeId) {
        return recoveryOutcome(
          candidate.intent,
          "defer",
          "run_start_agent_driver_unavailable",
          "Run Start 对应的 Agent Driver 不可用，等待后续 Driver 注册后重试。",
        );
      }

      const claim = yield* claimRecoverableIntent(options.runStartStore, candidate.intent);
      if (claim._tag === "Deferred") return claim.outcome;
      const claimedIntent = claim.intent;

      const preflight = yield* preflightClaimedRecovery(options.taskStore, candidate, "start");
      if (preflight._tag === "Rejected") {
        yield* quarantineClaimed(
          options.runStartStore,
          claimedIntent,
          preflight.code,
          preflight.detail,
        );
        return recoveryOutcome(claimedIntent, "quarantine", preflight.code, preflight.detail);
      }

      const capabilityIds = candidate.capabilityIds;
      if (capabilityIds === null) {
        const code = "run_start_legacy_input_capabilities_unknown";
        const detail = "旧加密输入无法确认 capabilityIds，已阻止自动外部启动。";
        yield* quarantineClaimed(options.runStartStore, claimedIntent, code, detail);
        return recoveryOutcome(claimedIntent, "quarantine", code, detail);
      }
      const capabilities = yield* recoverCompositionRunStartCapabilities(
        {
          taskStore: options.taskStore,
          ...(options.grantRegistry === undefined ? {} : { grantRegistry: options.grantRegistry }),
        },
        {
          task: preflight.candidate.task,
          run: preflight.candidate.run,
          capabilityIds,
          purpose: plan.action === "replay" ? "replay" : "start",
          nowUnixMs: yield* Clock.currentTimeMillis,
          ...(plan.action === "replay" && driver.startRecoveryPolicy?.mode === "idempotent-replay"
            ? { allowReplayGrantReplacement: true }
            : {}),
        },
      );
      if (capabilities._tag !== "Ready") {
        if (capabilities._tag === "Deferred") {
          return recoveryOutcome(claimedIntent, "defer", capabilities.code, capabilities.detail);
        }
        yield* quarantineClaimed(
          options.runStartStore,
          claimedIntent,
          capabilities.code,
          capabilities.detail,
        );
        return recoveryOutcome(
          claimedIntent,
          capabilities._tag === "Manual" ? "manual" : "quarantine",
          capabilities.code,
          capabilities.detail,
        );
      }

      const lease = yield* recoverCompositionRunStartRuntimeLease(options.taskStore, {
        task: preflight.candidate.task,
        run: capabilities.run,
        ...(input.recoveryInput.workspaceRootDigest === undefined
          ? {}
          : { workspaceRootDigest: input.recoveryInput.workspaceRootDigest }),
      });
      if (lease._tag === "Deferred") {
        return recoveryOutcome(
          claimedIntent,
          "defer",
          lease.code,
          lease.detail,
          claimedIntent.ownerLeaseExpiresAtUnixMs ?? undefined,
        );
      }

      yield* options.executeClaimed({
        candidate: { ...preflight.candidate, run: lease.run, capabilityIds },
        recoveryInput: input.recoveryInput,
        driver,
        intent: claimedIntent,
        plan,
      });
      return plan;
    });

  const recordUnrecoverable = (input: {
    readonly intent: CompositionRunStartIntent;
    readonly code: string;
    readonly detail: string;
  }): Effect.Effect<CompositionRunStartRecoveryPlan, CompositionRunStartStoreError> =>
    Effect.gen(function* () {
      const outcome = recoveryOutcome(input.intent, "quarantine", input.code, input.detail);
      if (input.intent.state === "accepted") {
        return {
          ...outcome,
          action: "defer",
          code: "run_start_recovery_claim_unavailable",
          detail: "accepted Run Start 缺少完整恢复上下文，无法覆盖已确认的外部启动事实。",
        };
      }
      const claim = yield* claimRecoverableIntent(options.runStartStore, input.intent);
      if (claim._tag === "Deferred") return claim.outcome;
      yield* quarantineClaimed(options.runStartStore, claim.intent, input.code, input.detail);
      return outcome;
    });

  return { execute, recordUnrecoverable };
};
