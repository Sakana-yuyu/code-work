import type { CompositionTask, CompositionTaskRun } from "@codework/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { CompositionRunStartIntent } from "../persistence/Services/CompositionRunStartStore.ts";
import type { CompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import type { CompositionAgentDriverFailure } from "./CompositionOrchestrator.ts";
import {
  makeCompositionRunStartDigests,
  validateCompositionRunStartReceipt,
} from "./CompositionRunStartLifecycle.ts";

export type CompositionRunStartRecoveryCandidate = {
  readonly task: CompositionTask;
  readonly run: CompositionTaskRun;
  readonly intent: CompositionRunStartIntent;
  readonly capabilityIds: ReadonlyArray<string> | null;
  /** 必须由解密后的 recovery input 或持久 Run snapshot 填充，不能信任 RPC 调用方。 */
  readonly workspaceRootDigest: string | null;
  readonly model: string | null;
};

export type CompositionRunStartRecoveryReconciliation =
  | "provider-sessions"
  | "ide-sessions"
  | "runtime-adapters"
  | `ide-session-known:${string}`
  | `ide-session-ready:${string}`
  | `runtime-adapter-known:${string}`
  | `runtime-adapter-ready:${string}`;

export type CompositionRunStartRecoveryPlan = {
  readonly taskId: string;
  readonly runId: string;
  readonly action: "start" | "replay" | "accept" | "defer" | "manual" | "quarantine";
  readonly code?: string;
  readonly detail?: string;
  readonly runtimeTaskId?: string;
  readonly capabilityHandshakeId?: string | null;
  readonly retryAtUnixMs?: number;
};

const DRIVER_RECONCILIATION_TIMEOUT = Duration.seconds(5);
const TRANSIENT_RECONCILIATION_RETRY_MS = 30_000;

const pendingReconciliationForTarget = (input: {
  readonly candidate: CompositionRunStartRecoveryCandidate;
  readonly runtimeKind: string;
  readonly reconciled: ReadonlySet<CompositionRunStartRecoveryReconciliation>;
  readonly retryAtUnixMs: number;
}): CompositionRunStartRecoveryPlan | undefined => {
  if (input.runtimeKind === "provider" || input.runtimeKind === "byok") {
    return input.reconciled.has("provider-sessions")
      ? undefined
      : {
          taskId: input.candidate.task.taskId,
          runId: input.candidate.run.runId,
          action: "defer",
          code: "run_start_provider_sessions_reconciliation_pending",
          detail: "Provider session 启动收口尚未完成，Run Start 恢复已延后。",
          retryAtUnixMs: input.retryAtUnixMs,
        };
  }

  const ideSessionId = input.candidate.run.runtimeId.startsWith("ide:")
    ? input.candidate.run.runtimeId.slice("ide:".length)
    : undefined;
  if (ideSessionId !== undefined) {
    if (!input.reconciled.has("ide-sessions")) {
      return {
        taskId: input.candidate.task.taskId,
        runId: input.candidate.run.runId,
        action: "defer",
        code: "run_start_ide_sessions_reconciliation_pending",
        detail: "IDE session 启动收口尚未完成，Run Start 恢复已延后。",
        retryAtUnixMs: input.retryAtUnixMs,
      };
    }
    return input.reconciled.has(`ide-session-ready:${ideSessionId}`)
      ? undefined
      : {
          taskId: input.candidate.task.taskId,
          runId: input.candidate.run.runId,
          action: "defer",
          code: "run_start_ide_session_target_reconciliation_pending",
          detail: "目标 IDE session 未完成可用性核对，Run Start 恢复已延后。",
          retryAtUnixMs: input.retryAtUnixMs,
        };
  }

  if (!input.reconciled.has("runtime-adapters")) {
    return {
      taskId: input.candidate.task.taskId,
      runId: input.candidate.run.runId,
      action: "defer",
      code: "run_start_runtime_adapters_reconciliation_pending",
      detail: "Runtime Adapter 启动收口尚未完成，Run Start 恢复已延后。",
      retryAtUnixMs: input.retryAtUnixMs,
    };
  }
  if (!input.reconciled.has(`runtime-adapter-known:${input.candidate.run.runtimeId}`)) {
    return {
      taskId: input.candidate.task.taskId,
      runId: input.candidate.run.runId,
      action: "manual",
      code: "run_start_runtime_adapter_target_unknown",
      detail: "持久 Run Start 指向的 Runtime Adapter 已不存在，需要人工核对。",
    };
  }
  return input.reconciled.has(`runtime-adapter-ready:${input.candidate.run.runtimeId}`)
    ? undefined
    : {
        taskId: input.candidate.task.taskId,
        runId: input.candidate.run.runId,
        action: "defer",
        code: "run_start_runtime_adapter_target_unavailable",
        detail: "目标 Runtime Adapter 已登记但尚未在线，Run Start 恢复已延后。",
        retryAtUnixMs: input.retryAtUnixMs,
      };
};

const deferCandidatePlanningFailure = (
  candidate: CompositionRunStartRecoveryCandidate,
): CompositionRunStartRecoveryPlan => ({
  taskId: candidate.task.taskId,
  runId: candidate.run.runId,
  action: "defer",
  code: "run_start_recovery_candidate_planning_failed",
  detail: "Run Start 恢复候选规划失败，已隔离当前 Run 并继续处理其他恢复项。",
});

const planFor = Effect.fn("planCompositionRunStartRecovery")(function* (
  candidate: CompositionRunStartRecoveryCandidate,
  driverRegistry: CompositionAgentDriverRegistry,
  reconciled: ReadonlySet<CompositionRunStartRecoveryReconciliation>,
): Effect.fn.Return<CompositionRunStartRecoveryPlan, CompositionAgentDriverFailure> {
  if (
    candidate.task.taskId !== candidate.run.taskId ||
    candidate.run.taskId !== candidate.intent.taskId ||
    candidate.run.runId !== candidate.intent.runId ||
    candidate.run.agentId !== candidate.intent.agentId ||
    candidate.run.runtimeId !== candidate.intent.runtimeId ||
    candidate.run.attempt !== candidate.intent.attempt
  ) {
    return {
      taskId: candidate.task.taskId,
      runId: candidate.run.runId,
      action: "quarantine",
      code: "run_start_recovery_identity_mismatch",
      detail: "Task、Run 与持久 Run Start 意图的身份不一致，已阻止自动恢复。",
    };
  }

  if (candidate.capabilityIds === null) {
    return {
      taskId: candidate.task.taskId,
      runId: candidate.run.runId,
      action: "quarantine",
      code: "run_start_legacy_input_capabilities_unknown",
      detail: "旧加密输入无法确认 capabilityIds，已阻止自动外部启动。",
    };
  }

  const driver = yield* driverRegistry.get(candidate.intent.agentId);
  if (driver === undefined || driver.runtimeId !== candidate.intent.runtimeId) {
    return {
      taskId: candidate.task.taskId,
      runId: candidate.run.runId,
      action: "defer",
      code: "run_start_agent_driver_unavailable",
      detail: "Run Start 对应的 Agent Driver 不可用，恢复已延后。",
    };
  }
  const externalTargetIdentity = driver.getStartIdentity?.(
    candidate.model === null ? {} : { model: candidate.model },
  );
  if (externalTargetIdentity === undefined) {
    return {
      taskId: candidate.task.taskId,
      runId: candidate.run.runId,
      action: "manual",
      code: "run_start_external_target_identity_unavailable",
      detail: "Agent Driver 未提供可验证的外部启动目标身份，禁止自动重放。",
    };
  }
  const digests = makeCompositionRunStartDigests({
    taskId: candidate.task.taskId,
    projectId: candidate.task.projectId,
    ...(candidate.task.threadId === undefined ? {} : { threadId: candidate.task.threadId }),
    ...(candidate.task.parentTaskId === undefined
      ? {}
      : { parentTaskId: candidate.task.parentTaskId }),
    runId: candidate.run.runId,
    previousRunId: candidate.intent.previousRunId,
    assigneeKind: candidate.task.assigneeKind,
    assigneeId: candidate.task.assigneeId,
    mode: candidate.task.mode,
    dependsOnTaskIds: candidate.task.dependsOnTaskIds,
    agentId: candidate.run.agentId,
    runtimeId: candidate.run.runtimeId,
    attempt: candidate.run.attempt,
    promptDigest: candidate.task.promptDigest,
    ...(candidate.workspaceRootDigest === null
      ? {}
      : { workspaceRootDigest: candidate.workspaceRootDigest }),
    ...(candidate.model === null ? {} : { model: candidate.model }),
    externalTargetIdentity,
    capabilityIds: candidate.capabilityIds,
  });
  if (
    digests.payloadDigest !== candidate.intent.payloadDigest ||
    digests.capabilityDigest !== candidate.intent.capabilityDigest
  ) {
    return {
      taskId: candidate.task.taskId,
      runId: candidate.run.runId,
      action: "quarantine",
      code: "run_start_recovery_digest_mismatch",
      detail: "当前 Task/Run 启动身份与持久 Run Start 摘要不一致，已阻止自动外部启动。",
    };
  }

  const policy = driver.startRecoveryPolicy;
  if (policy === undefined) {
    return {
      taskId: candidate.task.taskId,
      runId: candidate.run.runId,
      action: "manual",
      code: "run_start_driver_recovery_policy_missing",
      detail: "Agent Driver 未声明跨进程启动恢复策略，需要人工核对。",
    };
  }
  if (candidate.intent.state === "accepted") {
    const receipt = yield* validateCompositionRunStartReceipt({
      policy,
      startResult: {
        ...(candidate.intent.runtimeTaskId === null
          ? {}
          : { runtimeTaskId: candidate.intent.runtimeTaskId }),
        ...(candidate.intent.capabilityHandshakeId === null
          ? {}
          : { capabilityHandshakeId: candidate.intent.capabilityHandshakeId }),
      },
      capabilityGrantIds: [...(candidate.run.capabilityGrantIds ?? [])],
    }).pipe(
      Effect.matchEffect({
        onFailure: (failure) => Effect.succeed({ _tag: "Failure" as const, failure }),
        onSuccess: (value) => Effect.succeed({ _tag: "Success" as const, value }),
      }),
    );
    return receipt._tag === "Failure"
      ? {
          taskId: candidate.task.taskId,
          runId: candidate.run.runId,
          action: "manual",
          code: receipt.failure.code,
          detail: receipt.failure.detail,
        }
      : {
          taskId: candidate.task.taskId,
          runId: candidate.run.runId,
          action: "accept",
          ...(receipt.value.runtimeTaskId === null
            ? {}
            : { runtimeTaskId: receipt.value.runtimeTaskId }),
          capabilityHandshakeId: receipt.value.capabilityHandshakeId,
        };
  }
  const pendingReconciliation = pendingReconciliationForTarget({
    candidate,
    runtimeKind: externalTargetIdentity.runtimeKind,
    reconciled,
    retryAtUnixMs: (yield* Clock.currentTimeMillis) + TRANSIENT_RECONCILIATION_RETRY_MS,
  });
  if (pendingReconciliation !== undefined) return pendingReconciliation;
  if (policy.mode === "manual") {
    return {
      taskId: candidate.task.taskId,
      runId: candidate.run.runId,
      action: "manual",
      code: "run_start_manual_recovery_required",
      detail: "Agent Driver 声明该启动只能人工核对，禁止自动重放。",
    };
  }
  if (candidate.intent.state === "prepared" || candidate.intent.state === "preparing") {
    return {
      taskId: candidate.task.taskId,
      runId: candidate.run.runId,
      action: "start",
    };
  }

  const reconcileStart = driver.reconcileStart;
  if (reconcileStart === undefined) {
    if (policy.mode === "idempotent-replay") {
      return {
        taskId: candidate.task.taskId,
        runId: candidate.run.runId,
        action: "replay",
      };
    }
    return {
      taskId: candidate.task.taskId,
      runId: candidate.run.runId,
      action: "manual",
      code: "run_start_driver_reconciliation_unavailable",
      detail: "Agent Driver 未提供外部启动事实核对能力，需要人工处理。",
    };
  }

  const reconciliation = yield* reconcileStart({
    task: candidate.task,
    run: candidate.run,
    intent: candidate.intent,
    capabilityIds: candidate.capabilityIds,
  }).pipe(Effect.timeoutOption(DRIVER_RECONCILIATION_TIMEOUT), Effect.exit);
  if (reconciliation._tag === "Failure") {
    if (Cause.interruptors(reconciliation.cause).size > 0) {
      return yield* Effect.failCause(reconciliation.cause);
    }
    return {
      taskId: candidate.task.taskId,
      runId: candidate.run.runId,
      action: "defer",
      code: "run_start_driver_reconciliation_failed",
      detail: "Agent Driver 启动事实核对失败，已隔离当前 Run 并继续处理其他恢复项。",
      retryAtUnixMs: (yield* Clock.currentTimeMillis) + TRANSIENT_RECONCILIATION_RETRY_MS,
    };
  }

  if (Option.isNone(reconciliation.value)) {
    return {
      taskId: candidate.task.taskId,
      runId: candidate.run.runId,
      action: "defer",
      code: "run_start_driver_reconciliation_timeout",
      detail: "Agent Driver 启动事实核对超时，已延后当前 Run 并继续处理其他恢复项。",
      retryAtUnixMs: (yield* Clock.currentTimeMillis) + TRANSIENT_RECONCILIATION_RETRY_MS,
    };
  }

  const decision = reconciliation.value.value;
  if (decision.action === "replay") {
    return policy.mode === "idempotent-replay"
      ? {
          taskId: candidate.task.taskId,
          runId: candidate.run.runId,
          action: "replay",
        }
      : {
          taskId: candidate.task.taskId,
          runId: candidate.run.runId,
          action: "manual",
          code: "run_start_driver_replay_policy_conflict",
          detail: "Agent Driver 的核对结果要求重放，但声明策略不允许自动创建外部任务。",
        };
  }
  if (decision.action === "accepted") {
    const receipt = yield* validateCompositionRunStartReceipt({
      policy,
      startResult: {
        ...(decision.runtimeTaskId === undefined ? {} : { runtimeTaskId: decision.runtimeTaskId }),
        ...(decision.capabilityHandshakeId === undefined
          ? {}
          : { capabilityHandshakeId: decision.capabilityHandshakeId }),
      },
      capabilityGrantIds: [...(candidate.run.capabilityGrantIds ?? [])],
    }).pipe(
      Effect.matchEffect({
        onFailure: (failure) => Effect.succeed({ _tag: "Failure" as const, failure }),
        onSuccess: (value) => Effect.succeed({ _tag: "Success" as const, value }),
      }),
    );
    if (receipt._tag === "Failure") {
      return {
        taskId: candidate.task.taskId,
        runId: candidate.run.runId,
        action: "manual",
        code: receipt.failure.code,
        detail: receipt.failure.detail,
      };
    }
    return {
      taskId: candidate.task.taskId,
      runId: candidate.run.runId,
      action: "accept",
      ...(receipt.value.runtimeTaskId === null
        ? {}
        : { runtimeTaskId: receipt.value.runtimeTaskId }),
      capabilityHandshakeId: receipt.value.capabilityHandshakeId,
    };
  }
  return {
    taskId: candidate.task.taskId,
    runId: candidate.run.runId,
    action: decision.action,
    code: decision.code,
    detail: decision.detail,
    ...(decision.action === "defer"
      ? {
          retryAtUnixMs: (yield* Clock.currentTimeMillis) + TRANSIENT_RECONCILIATION_RETRY_MS,
        }
      : {}),
  };
});

export const planCompositionRunStartRecoveries = (input: {
  readonly candidates: ReadonlyArray<CompositionRunStartRecoveryCandidate>;
  readonly driverRegistry: CompositionAgentDriverRegistry;
  readonly reconciled: ReadonlySet<CompositionRunStartRecoveryReconciliation>;
}): Effect.Effect<ReadonlyArray<CompositionRunStartRecoveryPlan>, CompositionAgentDriverFailure> =>
  Effect.forEach(input.candidates, (candidate) =>
    planFor(candidate, input.driverRegistry, input.reconciled).pipe(
      Effect.catchCause((cause) =>
        Cause.interruptors(cause).size > 0
          ? Effect.failCause(cause)
          : Effect.succeed(deferCandidatePlanningFailure(candidate)),
      ),
    ),
  );
