import type { WorkspaceScriptRun } from "@codework/contracts";

import type { TerminalSessionInspectionReceipt } from "../terminal/Manager.ts";

export const WORKSPACE_SCRIPT_START_FAILED_DETAIL =
  "受监督终端未确认 Workspace Script 已成功启动。";

const WORKSPACE_SCRIPT_START_TERMINATION_PREFIX = "workspace-script-start-termination:";

export const makeWorkspaceScriptStartTerminationOperationId = (
  workspaceScriptRunId: string,
): string => `${WORKSPACE_SCRIPT_START_TERMINATION_PREFIX}${workspaceScriptRunId}`;

export const isWorkspaceScriptStartTerminationOperationId = (
  workspaceScriptRunId: string,
  operationId: string | null,
): boolean => operationId === makeWorkspaceScriptStartTerminationOperationId(workspaceScriptRunId);

export type WorkspaceScriptStartFailureReason = "terminal-status";

export type WorkspaceScriptStartPendingReason = "starting" | "inactive" | "missing";

export type WorkspaceScriptStartTerminationReason =
  | "active-error"
  | "active-without-pid"
  | "quarantined";

export type WorkspaceScriptStartAssessment =
  | { readonly _tag: "Ready" }
  | {
      readonly _tag: "Settled";
      readonly exitCode: number | null;
      readonly exitSignal: number | null;
    }
  | { readonly _tag: "Pending"; readonly reason: WorkspaceScriptStartPendingReason }
  | { readonly _tag: "Failed"; readonly reason: WorkspaceScriptStartFailureReason }
  | {
      readonly _tag: "TerminationRequired";
      readonly reason: WorkspaceScriptStartTerminationReason;
    };

export const assessWorkspaceScriptStart = (
  receipt: TerminalSessionInspectionReceipt,
): WorkspaceScriptStartAssessment => {
  const snapshot = receipt.snapshot;
  if (snapshot === null || receipt.inspection === "missing") {
    return { _tag: "Pending", reason: "missing" };
  }
  if (snapshot.status === "exited") {
    return {
      _tag: "Settled",
      exitCode: snapshot.exitCode,
      exitSignal: snapshot.exitSignal,
    };
  }
  if (receipt.inspection === "quarantined") {
    return { _tag: "TerminationRequired", reason: "quarantined" };
  }
  if (receipt.inspection === "inactive") {
    return snapshot.status === "error"
      ? { _tag: "Failed", reason: "terminal-status" }
      : { _tag: "Pending", reason: "inactive" };
  }
  if (snapshot.status === "starting") {
    return { _tag: "Pending", reason: "starting" };
  }
  if (snapshot.status === "error") {
    return { _tag: "TerminationRequired", reason: "active-error" };
  }
  if (snapshot.pid === null) {
    return { _tag: "TerminationRequired", reason: "active-without-pid" };
  }
  return { _tag: "Ready" };
};

export const makeWorkspaceScriptStartFailed = (
  run: WorkspaceScriptRun,
  observedAtUnixMs: number,
): WorkspaceScriptRun =>
  run.status !== "starting"
    ? run
    : {
        ...run,
        status: "failed",
        healthStatus: "unknown",
        healthCheckedAtUnixMs: null,
        healthDetail: null,
        revision: run.revision + 1,
        finishedAtUnixMs: observedAtUnixMs,
        exitCode: null,
        exitSignal: null,
        errorCode: "workspace_script_start_failed",
        errorDetail: WORKSPACE_SCRIPT_START_FAILED_DETAIL,
        updatedAtUnixMs: observedAtUnixMs,
      };

/** 内部补偿终止尚未确认时保留 starting，释放执行 claim 供后续实例重试。 */
export const makeWorkspaceScriptStartTerminationRetryable = (
  run: WorkspaceScriptRun,
  observedAtUnixMs: number,
): WorkspaceScriptRun =>
  run.status !== "starting"
    ? run
    : {
        ...run,
        revision: run.revision + 1,
        updatedAtUnixMs: observedAtUnixMs,
      };
