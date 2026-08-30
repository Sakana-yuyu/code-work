import type { WorkspaceScriptRun, WorkspaceScriptStopRequest } from "@codework/contracts";

export const createWorkspaceScriptStopRequest = (
  run: WorkspaceScriptRun,
): WorkspaceScriptStopRequest => ({
  workspaceScriptRunId: run.workspaceScriptRunId,
  operationId: `workspace-script-stop:${run.workspaceScriptRunId}`,
  expectedRevision: run.revision,
});
