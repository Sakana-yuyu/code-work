import type { WorkspaceScriptRun } from "@codework/contracts";

import {
  isFinishedWorkspaceScriptRun,
  makeWorkspaceScriptExited,
} from "./WorkspaceScriptStopState.ts";

export type WorkspaceScriptTerminalInspection = "active" | "inactive" | "missing";

export const settleRecoveredWorkspaceScriptStop = (input: {
  readonly run: WorkspaceScriptRun;
  readonly stopOperationId: string;
  readonly inspection: WorkspaceScriptTerminalInspection;
  readonly observedAtUnixMs: number;
}): WorkspaceScriptRun => {
  if (isFinishedWorkspaceScriptRun(input.run) || input.inspection === "active") {
    return input.run;
  }
  if (input.inspection === "inactive") {
    return makeWorkspaceScriptExited({
      run: input.run,
      stopOperationId: input.stopOperationId,
      observedAtUnixMs: input.observedAtUnixMs,
      exitCode: null,
      exitSignal: null,
    });
  }
  return {
    ...input.run,
    status: "failed",
    healthStatus: "unknown",
    healthCheckedAtUnixMs: null,
    healthDetail: null,
    revision: input.run.revision + 1,
    startedAtUnixMs: input.run.startedAtUnixMs ?? input.observedAtUnixMs,
    finishedAtUnixMs: input.observedAtUnixMs,
    exitCode: null,
    exitSignal: null,
    errorCode: "workspace_script_terminal_supervision_lost",
    errorDetail: "Code Work 服务重启后未找到受监督终端，无法确认进程已停止。",
    updatedAtUnixMs: input.observedAtUnixMs,
  };
};
