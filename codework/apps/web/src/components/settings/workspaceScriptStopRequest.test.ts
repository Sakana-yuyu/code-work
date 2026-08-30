import type { WorkspaceScriptRun } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createWorkspaceScriptStopRequest } from "./workspaceScriptStopRequest";

const RUN: WorkspaceScriptRun = {
  workspaceScriptRunId: "workspace-script-run:operation-1",
  idempotencyKey: "workspace-script:project-1:thread-1:serve:operation-1",
  projectId: "project-1",
  threadId: "thread-1",
  scriptId: "serve",
  scriptName: "启动开发服务",
  terminalId: "workspace-script-operation-1",
  cwd: "E:/workspace/project-1",
  worktreePath: null,
  status: "running",
  healthStatus: "unknown",
  healthCheckedAtUnixMs: null,
  healthDetail: null,
  ports: [],
  revision: 2,
  requestedAtUnixMs: 1_000,
  startedAtUnixMs: 1_100,
  finishedAtUnixMs: null,
  exitCode: null,
  exitSignal: null,
  errorCode: null,
  errorDetail: null,
  compositionTaskId: null,
  compositionRunId: null,
  updatedAtUnixMs: 1_100,
};

describe("workspace script stop request", () => {
  it("失败后的新 revision 继续复用同一 stop operation", () => {
    const first = createWorkspaceScriptStopRequest(RUN);
    const retry = createWorkspaceScriptStopRequest({
      ...RUN,
      revision: 4,
      updatedAtUnixMs: 1_200,
    });

    expect(retry.operationId).toBe(first.operationId);
    expect(retry.expectedRevision).toBe(4);
  });

  it("组件重新挂载后可从 Run 身份重建同一 stop operation", () => {
    expect(createWorkspaceScriptStopRequest(RUN)).toEqual(createWorkspaceScriptStopRequest(RUN));
    expect(createWorkspaceScriptStopRequest(RUN).operationId).toBe(
      "workspace-script-stop:workspace-script-run:operation-1",
    );
  });
});
