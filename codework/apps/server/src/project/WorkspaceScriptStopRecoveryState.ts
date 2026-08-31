import type { TerminalSessionInspectionReceipt } from "../terminal/Manager.ts";

export type WorkspaceScriptStopRecoveryAssessment =
  | {
      readonly _tag: "Confirmed";
      readonly exitCode: number | null;
      readonly exitSignal: number | null;
    }
  | {
      readonly _tag: "Unconfirmed";
      readonly reason: "active" | "inactive" | "missing" | "quarantined";
    };

/** 只接受同 owner 会话内可证明的真实退出或确定性无进程状态。 */
export const assessWorkspaceScriptStopRecovery = (
  receipt: TerminalSessionInspectionReceipt,
): WorkspaceScriptStopRecoveryAssessment => {
  const snapshot = receipt.snapshot;
  if (snapshot === null || receipt.inspection === "missing") {
    return { _tag: "Unconfirmed", reason: "missing" };
  }
  if (snapshot.status === "exited") {
    return {
      _tag: "Confirmed",
      exitCode: snapshot.exitCode,
      exitSignal: snapshot.exitSignal,
    };
  }
  if (receipt.inspection === "inactive" && snapshot.status === "error" && snapshot.pid === null) {
    return { _tag: "Confirmed", exitCode: null, exitSignal: null };
  }
  return { _tag: "Unconfirmed", reason: receipt.inspection };
};
