import type { TerminalSessionSnapshot } from "@codework/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  assessWorkspaceScriptStart,
  isWorkspaceScriptStartTerminationOperationId,
  makeWorkspaceScriptStartFailed,
  makeWorkspaceScriptStartTerminationOperationId,
  WORKSPACE_SCRIPT_START_FAILED_DETAIL,
} from "./WorkspaceScriptStartState.ts";

const snapshot = (overrides: Partial<TerminalSessionSnapshot> = {}): TerminalSessionSnapshot => ({
  threadId: "thread-1",
  terminalId: "workspace-script-operation-1",
  cwd: "E:/workspace/project-1",
  worktreePath: null,
  status: "running",
  pid: 1234,
  history: "",
  exitCode: null,
  exitSignal: null,
  label: "pnpm dev",
  updatedAt: "2026-08-30T00:00:00.000Z",
  sequence: 1,
  ...overrides,
});

describe("WorkspaceScriptStartState", () => {
  it("仅接受 running、有 PID 且处于 active 的受监督会话", () => {
    assert.deepEqual(assessWorkspaceScriptStart({ snapshot: snapshot(), inspection: "active" }), {
      _tag: "Ready",
    });
  });

  it("区分无进程与仍受监督的 error 快照", () => {
    const withoutProcess = assessWorkspaceScriptStart({
      snapshot: snapshot({ status: "error", pid: null }),
      inspection: "inactive",
    });
    const retainedProcess = assessWorkspaceScriptStart({
      snapshot: snapshot({ status: "error", pid: 4321 }),
      inspection: "active",
    });

    assert.equal(withoutProcess._tag, "Failed");
    assert.equal(retainedProcess._tag, "TerminationRequired");
    if (withoutProcess._tag === "Failed") assert.equal(withoutProcess.reason, "terminal-status");
    if (retainedProcess._tag === "TerminationRequired") {
      assert.equal(retainedProcess.reason, "active-error");
    }
  });

  it("quarantined 会话始终 fail-closed", () => {
    const assessed = assessWorkspaceScriptStart({
      snapshot: snapshot(),
      inspection: "quarantined",
    });

    assert.equal(assessed._tag, "TerminationRequired");
    if (assessed._tag === "TerminationRequired") assert.equal(assessed.reason, "quarantined");
  });

  it("exited 快照保留真实退出结果", () => {
    const assessed = assessWorkspaceScriptStart({
      snapshot: snapshot({ status: "exited", pid: null, exitCode: 0, exitSignal: null }),
      inspection: "inactive",
    });

    assert.deepEqual(assessed, { _tag: "Settled", exitCode: 0, exitSignal: null });
  });

  it("启动失败终止 operationId 仅匹配当前 Run", () => {
    const workspaceScriptRunId = "workspace-script-run:operation-1";
    const operationId = makeWorkspaceScriptStartTerminationOperationId(workspaceScriptRunId);

    assert.isTrue(isWorkspaceScriptStartTerminationOperationId(workspaceScriptRunId, operationId));
    assert.isFalse(
      isWorkspaceScriptStartTerminationOperationId("workspace-script-run:operation-2", operationId),
    );
    assert.isFalse(isWorkspaceScriptStartTerminationOperationId(workspaceScriptRunId, null));
  });

  it("启动失败状态使用稳定错误码与固定中文详情", () => {
    const failed = makeWorkspaceScriptStartFailed(
      {
        workspaceScriptRunId: "workspace-script-run:operation-1",
        idempotencyKey: "workspace-script:project-1:thread-1:serve:operation-1",
        projectId: "project-1",
        threadId: "thread-1",
        scriptId: "serve",
        scriptName: "启动开发服务",
        terminalId: "workspace-script-operation-1",
        cwd: "E:/workspace/project-1",
        worktreePath: null,
        status: "starting",
        healthStatus: "unknown",
        healthCheckedAtUnixMs: null,
        healthDetail: null,
        ports: [],
        revision: 1,
        requestedAtUnixMs: 1_000,
        startedAtUnixMs: null,
        finishedAtUnixMs: null,
        exitCode: null,
        exitSignal: null,
        errorCode: null,
        errorDetail: null,
        compositionTaskId: null,
        compositionRunId: null,
        updatedAtUnixMs: 1_000,
      },
      1_001,
    );

    assert.equal(failed.status, "failed");
    assert.equal(failed.revision, 2);
    assert.equal(failed.finishedAtUnixMs, 1_001);
    assert.equal(failed.errorCode, "workspace_script_start_failed");
    assert.equal(failed.errorDetail, WORKSPACE_SCRIPT_START_FAILED_DETAIL);
  });

  it("启动失败不能覆盖已经领取的 stopping", () => {
    const stopping = makeWorkspaceScriptStartFailed(
      {
        workspaceScriptRunId: "workspace-script-run:operation-stopping",
        idempotencyKey: "workspace-script:project-1:thread-1:serve:operation-stopping",
        projectId: "project-1",
        threadId: "thread-1",
        scriptId: "serve",
        scriptName: "启动开发服务",
        terminalId: "workspace-script-operation-stopping",
        cwd: "E:/workspace/project-1",
        worktreePath: null,
        status: "stopping",
        healthStatus: "unknown",
        healthCheckedAtUnixMs: null,
        healthDetail: null,
        ports: [],
        revision: 2,
        requestedAtUnixMs: 1_000,
        startedAtUnixMs: 1_000,
        finishedAtUnixMs: null,
        exitCode: null,
        exitSignal: null,
        errorCode: null,
        errorDetail: null,
        compositionTaskId: null,
        compositionRunId: null,
        updatedAtUnixMs: 1_001,
      },
      1_002,
    );

    assert.equal(stopping.status, "stopping");
    assert.equal(stopping.revision, 2);
  });
});
