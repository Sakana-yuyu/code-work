import type { WorkspaceScriptRun } from "@codework/contracts";

export const isFinishedWorkspaceScriptRun = (run: WorkspaceScriptRun): boolean =>
  run.status === "stopped" || run.status === "exited" || run.status === "failed";

export const makeWorkspaceScriptStopping = (
  run: WorkspaceScriptRun,
  observedAtUnixMs: number,
): WorkspaceScriptRun => ({
  ...run,
  ...(isFinishedWorkspaceScriptRun(run)
    ? {}
    : {
        status: "stopping" as const,
        startedAtUnixMs: run.startedAtUnixMs ?? observedAtUnixMs,
      }),
  revision: run.revision + 1,
  updatedAtUnixMs: observedAtUnixMs,
});

/** stop operation 身份始终保留；stopping 表示执行中，running 表示上次结果未知且可重试。 */
export const makeWorkspaceScriptStopRetryable = (
  run: WorkspaceScriptRun,
  observedAtUnixMs: number,
): WorkspaceScriptRun =>
  run.status !== "stopping"
    ? run
    : {
        ...run,
        status: "running",
        revision: run.revision + 1,
        finishedAtUnixMs: null,
        exitCode: null,
        exitSignal: null,
        errorCode: null,
        errorDetail: null,
        updatedAtUnixMs: observedAtUnixMs,
      };

export const makeWorkspaceScriptExited = (input: {
  readonly run: WorkspaceScriptRun;
  readonly stopOperationId: string | null;
  readonly observedAtUnixMs: number;
  readonly exitCode: number | null;
  readonly exitSignal: number | null;
}): WorkspaceScriptRun => {
  if (isFinishedWorkspaceScriptRun(input.run)) return input.run;
  return {
    ...input.run,
    status:
      input.stopOperationId !== null || input.run.status === "stopping" ? "stopped" : "exited",
    healthStatus: "unknown",
    healthCheckedAtUnixMs: null,
    healthDetail: null,
    revision: input.run.revision + 1,
    startedAtUnixMs: input.run.startedAtUnixMs ?? input.observedAtUnixMs,
    finishedAtUnixMs: input.observedAtUnixMs,
    exitCode: input.exitCode,
    exitSignal: input.exitSignal,
    errorCode: null,
    errorDetail: null,
    updatedAtUnixMs: input.observedAtUnixMs,
  };
};

export const makeWorkspaceScriptClosed = (input: {
  readonly run: WorkspaceScriptRun;
  readonly stopOperationId: string | null;
  readonly observedAtUnixMs: number;
}): WorkspaceScriptRun => {
  if (isFinishedWorkspaceScriptRun(input.run)) return input.run;
  const stopped = input.stopOperationId !== null || input.run.status === "stopping";
  return {
    ...input.run,
    status: stopped ? "stopped" : "failed",
    healthStatus: "unknown",
    healthCheckedAtUnixMs: null,
    healthDetail: null,
    revision: input.run.revision + 1,
    finishedAtUnixMs: input.observedAtUnixMs,
    ...(stopped
      ? { errorCode: null, errorDetail: null }
      : {
          errorCode: "workspace_script_terminal_closed",
          errorDetail: "受监督终端在脚本完成前被关闭。",
        }),
    updatedAtUnixMs: input.observedAtUnixMs,
  };
};
