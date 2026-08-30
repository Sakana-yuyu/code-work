import type { CompositionTask, CompositionTaskRun } from "@codework/contracts";
import * as Effect from "effect/Effect";

import type { CompositionRunStartIntent } from "../persistence/Services/CompositionRunStartStore.ts";
import type { CompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import { validateCompositionRunStartReceipt } from "./CompositionRunStartLifecycle.ts";

export type CompositionRunStartRecoveryCandidate = {
  readonly task: CompositionTask;
  readonly run: CompositionTaskRun;
  readonly intent: CompositionRunStartIntent;
  readonly capabilityIds: ReadonlyArray<string> | null;
};

export type CompositionRunStartRecoveryReconciliation =
  | "provider-sessions"
  | "ide-sessions"
  | "runtime-adapters";

export type CompositionRunStartRecoveryPlan = {
  readonly taskId: string;
  readonly runId: string;
  readonly action: "replay" | "accept" | "defer" | "manual" | "quarantine";
  readonly code?: string;
  readonly detail?: string;
  readonly runtimeTaskId?: string;
  readonly capabilityHandshakeId?: string | null;
};

const requiredReconciliations = [
  {
    key: "provider-sessions",
    code: "run_start_provider_sessions_reconciliation_pending",
    detail: "Provider session 启动收口尚未完成，Run Start 恢复已延后。",
  },
  {
    key: "ide-sessions",
    code: "run_start_ide_sessions_reconciliation_pending",
    detail: "IDE session 启动收口尚未完成，Run Start 恢复已延后。",
  },
  {
    key: "runtime-adapters",
    code: "run_start_runtime_adapters_reconciliation_pending",
    detail: "Runtime Adapter 启动收口尚未完成，Run Start 恢复已延后。",
  },
] as const satisfies ReadonlyArray<{
  readonly key: CompositionRunStartRecoveryReconciliation;
  readonly code: string;
  readonly detail: string;
}>;

const planFor = Effect.fn("planCompositionRunStartRecovery")(function* (
  candidate: CompositionRunStartRecoveryCandidate,
  driverRegistry: CompositionAgentDriverRegistry,
  reconciled: ReadonlySet<CompositionRunStartRecoveryReconciliation>,
): Effect.fn.Return<CompositionRunStartRecoveryPlan> {
  const pendingReconciliation = requiredReconciliations.find(({ key }) => !reconciled.has(key));
  if (pendingReconciliation !== undefined) {
    return {
      taskId: candidate.task.taskId,
      runId: candidate.run.runId,
      action: "defer",
      code: pendingReconciliation.code,
      detail: pendingReconciliation.detail,
    };
  }

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
  if (policy.mode === "manual") {
    return {
      taskId: candidate.task.taskId,
      runId: candidate.run.runId,
      action: "manual",
      code: "run_start_manual_recovery_required",
      detail: "Agent Driver 声明该启动只能人工核对，禁止自动重放。",
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

  const reconciliation = yield* Effect.exit(
    reconcileStart({
      task: candidate.task,
      run: candidate.run,
      intent: candidate.intent,
      capabilityIds: candidate.capabilityIds,
    }),
  );
  if (reconciliation._tag === "Failure") {
    return {
      taskId: candidate.task.taskId,
      runId: candidate.run.runId,
      action: "defer",
      code: "run_start_driver_reconciliation_failed",
      detail: "Agent Driver 启动事实核对失败，已隔离当前 Run 并继续处理其他恢复项。",
    };
  }

  const decision = reconciliation.value;
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
  };
});

export const planCompositionRunStartRecoveries = (input: {
  readonly candidates: ReadonlyArray<CompositionRunStartRecoveryCandidate>;
  readonly driverRegistry: CompositionAgentDriverRegistry;
  readonly reconciled: ReadonlySet<CompositionRunStartRecoveryReconciliation>;
}): Effect.Effect<ReadonlyArray<CompositionRunStartRecoveryPlan>> =>
  Effect.forEach(input.candidates, (candidate) =>
    planFor(candidate, input.driverRegistry, input.reconciled),
  );
