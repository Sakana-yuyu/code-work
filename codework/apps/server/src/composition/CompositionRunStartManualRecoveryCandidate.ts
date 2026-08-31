import type { CompositionTaskStatus } from "@codework/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  CompositionRunStartIntent,
  CompositionRunStartManualRecoverySnapshot,
} from "../persistence/Services/CompositionRunStartStore.ts";
import type {
  CompositionRunStartManualRecoveryOptions,
  CompositionRunStartManualRecoveryOutcome,
} from "./CompositionRunStartManualRecovery.ts";
import { renewCompositionRunStartManualWorkspaceLease } from "./CompositionRunStartManualRecoveryLease.ts";
import { reconcileCompositionRunStartManualCandidate } from "./CompositionRunStartManualRecoveryReconciliation.ts";

export const COMPOSITION_RUN_START_MANUAL_RECOVERY_RETRY_MS = 20_000;

const terminalStatuses: ReadonlySet<CompositionTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

const nowOf = (options: CompositionRunStartManualRecoveryOptions): Effect.Effect<number> =>
  options.now ?? Effect.clockWith((clock) => clock.currentTimeMillis);

export const deferCompositionRunStartManualRecovery = (
  intent: Pick<CompositionRunStartIntent, "taskId" | "runId">,
  nowUnixMs: number,
  code: string,
  detail: string,
): CompositionRunStartManualRecoveryOutcome => ({
  taskId: intent.taskId,
  runId: intent.runId,
  action: "defer",
  code,
  detail,
  nextRecoveryAtUnixMs: nowUnixMs + COMPOSITION_RUN_START_MANUAL_RECOVERY_RETRY_MS,
});

const completed = (
  intent: Pick<CompositionRunStartIntent, "taskId" | "runId">,
  action: "resume" | "settle",
  code: string,
  detail: string,
): CompositionRunStartManualRecoveryOutcome => ({
  taskId: intent.taskId,
  runId: intent.runId,
  action,
  code,
  detail,
});

const releaseForDefer = (
  options: CompositionRunStartManualRecoveryOptions,
  intent: CompositionRunStartIntent,
  snapshot: CompositionRunStartManualRecoverySnapshot,
  code: string,
  detail: string,
) =>
  Effect.gen(function* () {
    const nowUnixMs = yield* nowOf(options);
    yield* options.runStartStore.releaseManualRecovery({
      runId: intent.runId,
      expectedRevision: intent.revision,
      claimId: intent.claimId ?? "",
      ownerEpoch: intent.ownerEpoch,
      ...snapshot,
      releasedAtUnixMs: Math.max(nowUnixMs, intent.updatedAtUnixMs),
    });
    return deferCompositionRunStartManualRecovery(intent, nowUnixMs, code, detail);
  });

export const recoverClaimedCompositionRunStartManualCandidate = (
  options: CompositionRunStartManualRecoveryOptions,
  intent: CompositionRunStartIntent,
  snapshot: CompositionRunStartManualRecoverySnapshot,
) => {
  const deferClaim = (code: string, detail: string) =>
    releaseForDefer(options, intent, snapshot, code, detail);
  return Effect.gen(function* () {
    const [taskOption, runOption, latestRunOption, recoveryInputOption] = yield* Effect.all(
      [
        options.taskStore.getTask(intent.taskId),
        options.taskStore.getRun(intent.runId),
        options.taskStore.getLatestRun(intent.taskId),
        options.inputStore.get(intent.taskId),
      ] as const,
      { concurrency: "unbounded" },
    );

    if (Option.isNone(runOption)) {
      return yield* deferClaim(
        "run_start_manual_run_missing",
        "manual receipt 对应的 Run 不存在，无法证明外部终态，已延后处理。",
      );
    }
    const run = runOption.value;
    if (!(yield* renewCompositionRunStartManualWorkspaceLease(options, run))) {
      return yield* deferClaim(
        "run_start_manual_workspace_lease_renew_failed",
        "manual receipt 对应的 workspace lease 无法续期，已保留资源并延后处理。",
      );
    }
    if (Option.isNone(taskOption)) {
      return yield* deferClaim(
        "run_start_manual_task_missing",
        "manual receipt 对应的 Task 不存在，无法证明外部终态，已延后处理。",
      );
    }
    const task = taskOption.value;
    if (Option.isNone(latestRunOption) || latestRunOption.value.runId !== run.runId) {
      return yield* deferClaim(
        "run_start_manual_run_replaced",
        "Task 已存在更新 Run，旧 manual receipt 未自动覆盖当前运行。",
      );
    }
    if (
      task.taskId !== run.taskId ||
      run.taskId !== intent.taskId ||
      run.runId !== intent.runId ||
      run.agentId !== intent.agentId ||
      run.runtimeId !== intent.runtimeId ||
      run.attempt !== intent.attempt
    ) {
      return yield* deferClaim(
        "run_start_manual_identity_changed",
        "Task、Run 或 Runtime 启动身份已变化，manual receipt 未自动恢复。",
      );
    }
    if (
      (run.runtimeTaskId !== undefined && run.runtimeTaskId !== intent.runtimeTaskId) ||
      (run.capabilityHandshakeId !== undefined &&
        run.capabilityHandshakeId !== intent.capabilityHandshakeId)
    ) {
      return yield* deferClaim(
        "run_start_manual_persisted_receipt_mismatch",
        "当前 Run 与 manual intent 的持久 receipt 不一致，已拒绝自动对账。",
      );
    }
    if (task.status !== run.status) {
      return yield* deferClaim(
        "run_start_manual_status_mismatch",
        `Task/Run 状态不一致：${task.status}/${run.status}，无法证明真实终态。`,
      );
    }
    if (terminalStatuses.has(task.status) && terminalStatuses.has(run.status)) {
      yield* options.runStartStore.settleManualRecovery({
        runId: intent.runId,
        expectedRevision: intent.revision,
        claimId: intent.claimId ?? "",
        ownerEpoch: intent.ownerEpoch,
        ...snapshot,
        settledAtUnixMs: Math.max(yield* nowOf(options), intent.updatedAtUnixMs),
      });
      return completed(
        intent,
        "settle",
        "run_start_manual_terminal_settled",
        "同一最新 Task/Run 已进入一致可信终态，manual receipt 已完成持久结算。",
      );
    }
    if (run.cancelRequestedAtUnixMs !== undefined) {
      return yield* deferClaim(
        "run_start_manual_cancel_pending",
        "当前 Run 已存在取消请求，manual receipt 等待终态后再结算。",
      );
    }

    if (Option.isNone(recoveryInputOption)) {
      return yield* deferClaim(
        "run_start_manual_input_missing",
        "manual receipt 缺少加密恢复输入，已延后处理。",
      );
    }
    const recoveryInput = recoveryInputOption.value;
    if (recoveryInput.taskId !== intent.taskId) {
      return yield* deferClaim(
        "run_start_manual_input_identity_mismatch",
        "加密恢复输入与 manual intent 的 Task 身份不一致，已延后处理。",
      );
    }
    if (recoveryInput.capabilityIds === undefined) {
      return yield* deferClaim(
        "run_start_legacy_input_capabilities_unknown",
        "旧加密输入无法证明 capabilityIds，manual receipt 保持待人工状态。",
      );
    }

    const reconciliation = yield* reconcileCompositionRunStartManualCandidate(
      options,
      intent,
      task,
      run,
      recoveryInput,
      recoveryInput.capabilityIds,
    );
    if (reconciliation._tag === "Deferred") {
      return yield* deferClaim(reconciliation.code, reconciliation.detail);
    }

    yield* options.runStartStore.resumeManualRecoveryToAccepted({
      runId: intent.runId,
      expectedRevision: intent.revision,
      claimId: intent.claimId ?? "",
      ownerEpoch: intent.ownerEpoch,
      ...snapshot,
      resumedAtUnixMs: Math.max(yield* nowOf(options), intent.updatedAtUnixMs),
    });
    return completed(
      intent,
      "resume",
      "run_start_manual_receipt_reconciled",
      "Agent Driver 已确认同一持久 receipt，manual intent 已恢复为 accepted。",
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.interruptors(cause).size > 0
        ? Effect.interrupt
        : deferClaim(
            "run_start_manual_candidate_failed",
            "manual receipt 候选处理失败，已释放当前 claim 并等待下一轮。",
          ),
    ),
  );
};
