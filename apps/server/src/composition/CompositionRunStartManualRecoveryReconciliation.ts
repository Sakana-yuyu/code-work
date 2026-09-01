import type { CompositionTask, CompositionTaskRun } from "@codework/contracts";
import * as Effect from "effect/Effect";

import type { CompositionRunStartIntent } from "../persistence/Services/CompositionRunStartStore.ts";
import type { CompositionTaskRecoveryInput } from "../persistence/Services/CompositionTaskInputStore.ts";
import {
  makeCompositionRunStartDigests,
  validateCompositionRunStartReceipt,
  type CompositionRunStartReconcileDecision,
} from "./CompositionRunStartLifecycle.ts";
import type { CompositionRunStartManualRecoveryOptions } from "./CompositionRunStartManualRecovery.ts";
import { withCompositionRunStartManualLeases } from "./CompositionRunStartManualRecoveryLease.ts";

export type CompositionRunStartManualReconciliationResult =
  | { readonly _tag: "Accepted" }
  | { readonly _tag: "Deferred"; readonly code: string; readonly detail: string };

const deferred = (code: string, detail: string): CompositionRunStartManualReconciliationResult => ({
  _tag: "Deferred",
  code,
  detail,
});

const pendingReconciliation = (
  options: CompositionRunStartManualRecoveryOptions,
  intent: CompositionRunStartIntent,
  runtimeKind: string,
): CompositionRunStartManualReconciliationResult | undefined => {
  if (runtimeKind === "provider" || runtimeKind === "byok") {
    return options.reconciled.has("provider-sessions")
      ? undefined
      : deferred(
          "run_start_manual_provider_reconciliation_pending",
          "Provider session 启动收口尚未完成，manual receipt 对账已延后。",
        );
  }
  const ideSessionId = intent.runtimeId.startsWith("ide:")
    ? intent.runtimeId.slice("ide:".length)
    : undefined;
  if (ideSessionId !== undefined) {
    if (!options.reconciled.has("ide-sessions")) {
      return deferred(
        "run_start_manual_ide_reconciliation_pending",
        "IDE session 启动收口尚未完成，manual receipt 对账已延后。",
      );
    }
    return options.reconciled.has(`ide-session-ready:${ideSessionId}`)
      ? undefined
      : deferred(
          "run_start_manual_ide_target_unavailable",
          "目标 IDE session 尚未完成在线核对，manual receipt 对账已延后。",
        );
  }
  if (!options.reconciled.has("runtime-adapters")) {
    return deferred(
      "run_start_manual_runtime_reconciliation_pending",
      "Runtime Adapter 启动收口尚未完成，manual receipt 对账已延后。",
    );
  }
  if (!options.reconciled.has(`runtime-adapter-known:${intent.runtimeId}`)) {
    return deferred(
      "run_start_manual_runtime_target_unknown",
      "持久 Run Start 指向的 Runtime Adapter 当前不可证明，manual receipt 对账已延后。",
    );
  }
  return options.reconciled.has(`runtime-adapter-ready:${intent.runtimeId}`)
    ? undefined
    : deferred(
        "run_start_manual_runtime_target_unavailable",
        "目标 Runtime Adapter 尚未在线，manual receipt 对账已延后。",
      );
};

const sameReceipt = (
  intent: CompositionRunStartIntent,
  decision: Extract<CompositionRunStartReconcileDecision, { readonly action: "accepted" }>,
): boolean =>
  intent.runtimeTaskId === (decision.runtimeTaskId ?? null) &&
  intent.capabilityHandshakeId === (decision.capabilityHandshakeId ?? null);

export const reconcileCompositionRunStartManualCandidate = (
  options: CompositionRunStartManualRecoveryOptions,
  intent: CompositionRunStartIntent,
  task: CompositionTask,
  run: CompositionTaskRun,
  recoveryInput: CompositionTaskRecoveryInput,
  capabilityIds: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const driver = yield* options.driverRegistry.get(intent.agentId);
    if (driver === undefined || driver.runtimeId !== intent.runtimeId) {
      return deferred(
        "run_start_manual_agent_driver_unavailable",
        "manual receipt 对应的 Agent Driver 当前不可用，已延后处理。",
      );
    }
    const policy = driver.startRecoveryPolicy;
    if (policy === undefined || policy.mode === "manual") {
      return deferred(
        policy === undefined
          ? "run_start_manual_driver_policy_missing"
          : "run_start_manual_driver_policy_requires_operator",
        policy === undefined
          ? "Agent Driver 未声明跨进程启动恢复策略，manual receipt 保持待人工状态。"
          : "Agent Driver 声明仅允许人工恢复，manual receipt 未自动变更。",
      );
    }
    if (driver.reconcileStart === undefined) {
      return deferred(
        "run_start_manual_driver_reconciliation_unavailable",
        "Agent Driver 未提供 receipt-bound 启动核对能力，manual receipt 保持待人工状态。",
      );
    }
    const externalTargetIdentity = driver.getStartIdentity?.(
      recoveryInput.model === undefined ? {} : { model: recoveryInput.model },
    );
    if (externalTargetIdentity === undefined) {
      return deferred(
        "run_start_manual_external_identity_unavailable",
        "Agent Driver 无法提供稳定外部目标身份，manual receipt 未自动对账。",
      );
    }
    const pending = pendingReconciliation(options, intent, externalTargetIdentity.runtimeKind);
    if (pending !== undefined) return pending;

    const digests = makeCompositionRunStartDigests({
      taskId: task.taskId,
      projectId: task.projectId,
      ...(task.threadId === undefined ? {} : { threadId: task.threadId }),
      ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
      runId: run.runId,
      previousRunId: intent.previousRunId,
      assigneeKind: task.assigneeKind,
      assigneeId: task.assigneeId,
      mode: task.mode,
      dependsOnTaskIds: task.dependsOnTaskIds,
      agentId: run.agentId,
      runtimeId: run.runtimeId,
      attempt: run.attempt,
      promptDigest: task.promptDigest,
      ...(recoveryInput.workspaceRootDigest === undefined
        ? {}
        : { workspaceRootDigest: recoveryInput.workspaceRootDigest }),
      ...(recoveryInput.model === undefined ? {} : { model: recoveryInput.model }),
      externalTargetIdentity,
      capabilityIds,
    });
    if (
      digests.payloadDigest !== intent.payloadDigest ||
      digests.capabilityDigest !== intent.capabilityDigest
    ) {
      return deferred(
        "run_start_manual_digest_mismatch",
        "当前启动身份与 manual intent 摘要不一致，已拒绝自动对账。",
      );
    }

    const persistedReceipt = yield* Effect.result(
      validateCompositionRunStartReceipt({
        policy,
        startResult: {
          ...(intent.runtimeTaskId === null ? {} : { runtimeTaskId: intent.runtimeTaskId }),
          ...(intent.capabilityHandshakeId === null
            ? {}
            : { capabilityHandshakeId: intent.capabilityHandshakeId }),
        },
        capabilityGrantIds: run.capabilityGrantIds,
      }),
    );
    if (persistedReceipt._tag === "Failure") {
      return deferred(persistedReceipt.failure.code, persistedReceipt.failure.detail);
    }

    const reconciliation = yield* withCompositionRunStartManualLeases(
      options,
      intent,
      run,
      driver.reconcileStart({
        task,
        run,
        intent,
        capabilityIds: [...capabilityIds],
      }),
    );
    if (reconciliation._tag === "Failure") {
      return deferred(
        "run_start_manual_driver_reconciliation_failed",
        "Agent Driver 的 receipt-bound 核对失败，manual receipt 已延后处理。",
      );
    }
    const decision = reconciliation.success;
    if (decision.action !== "accepted") {
      return deferred(
        decision.action === "replay" ? "run_start_manual_replay_forbidden" : decision.code,
        decision.action === "replay"
          ? "Agent Driver 要求重放，但 manual recovery 禁止创建新的外部任务。"
          : decision.detail,
      );
    }
    if (!sameReceipt(intent, decision)) {
      return deferred(
        "run_start_manual_reconciled_receipt_mismatch",
        "Agent Driver 核对出的 receipt 与持久 manual receipt 不一致，已拒绝自动恢复。",
      );
    }
    return { _tag: "Accepted" } as const;
  });
