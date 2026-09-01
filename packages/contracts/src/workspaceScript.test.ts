import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  makeWorkspaceScriptRunId,
  WORKSPACE_SCRIPT_LOG_MAX_BYTES,
  validateWorkspaceScriptRun,
  WorkspaceScriptLogsRequest,
  WorkspaceScriptLogsResult,
  WorkspaceScriptRun,
  WorkspaceScriptStartRequest,
  WorkspaceScriptStopRequest,
} from "./workspaceScript.ts";

const decodeRun = Schema.decodeUnknownSync(WorkspaceScriptRun);
const decodeStart = Schema.decodeUnknownSync(WorkspaceScriptStartRequest);
const decodeStop = Schema.decodeUnknownSync(WorkspaceScriptStopRequest);
const decodeLogsRequest = Schema.decodeUnknownSync(WorkspaceScriptLogsRequest);
const decodeLogsResult = Schema.decodeUnknownSync(WorkspaceScriptLogsResult);

const runningRun = {
  workspaceScriptRunId: "workspace-script-run:operation-1",
  idempotencyKey: "workspace-script:project-1:thread-1:serve:operation-1",
  projectId: "project-1",
  threadId: "thread-1",
  scriptId: "serve",
  scriptName: "启动开发服务",
  terminalId: "workspace-script-operation-1",
  cwd: "E:/workspace/project-1",
  worktreePath: null,
  status: "running" as const,
  healthStatus: "healthy" as const,
  healthCheckedAtUnixMs: 1_200,
  healthDetail: null,
  ports: [
    {
      port: 5173,
      protocol: "http" as const,
      source: "discovered" as const,
      url: "http://127.0.0.1:5173",
    },
  ],
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
  updatedAtUnixMs: 1_200,
};

describe("Workspace Script contracts", () => {
  it("使用 operationId 生成稳定 Run ID，并保存终端、健康和端口投影", () => {
    expect(makeWorkspaceScriptRunId("operation-1")).toBe("workspace-script-run:operation-1");
    expect(decodeRun(runningRun)).toMatchObject({
      status: "running",
      healthStatus: "healthy",
      ports: [{ port: 5173, protocol: "http", source: "discovered" }],
    });
    expect(validateWorkspaceScriptRun(runningRun)).toEqual([]);
  });

  it("启动与停止请求携带稳定幂等身份和乐观 revision", () => {
    expect(
      decodeStart({
        operationId: "operation-1",
        projectId: "project-1",
        threadId: "thread-1",
        scriptId: "serve",
        worktreePath: "E:/workspace/project-1-worktree",
        compositionTaskId: "task-1",
        compositionRunId: "run-1",
      }),
    ).toMatchObject({ operationId: "operation-1", scriptId: "serve" });
    expect(
      decodeStop({
        workspaceScriptRunId: "workspace-script-run:operation-1",
        operationId: "stop-operation-1",
        expectedRevision: 2,
      }),
    ).toMatchObject({ expectedRevision: 2 });
  });

  it("日志快照只接受有效 Run ID，并允许终端暂时没有输出", () => {
    expect(decodeLogsRequest({ workspaceScriptRunId: "workspace-script-run:operation-1" })).toEqual(
      { workspaceScriptRunId: "workspace-script-run:operation-1" },
    );
    expect(
      decodeLogsResult({
        workspaceScriptRunId: "workspace-script-run:operation-1",
        terminalId: "workspace-script-operation-1",
        history: "",
        truncated: false,
      }),
    ).toEqual({
      workspaceScriptRunId: "workspace-script-run:operation-1",
      terminalId: "workspace-script-operation-1",
      history: "",
      truncated: false,
    });
    expect(() => decodeLogsRequest({ workspaceScriptRunId: " " })).toThrow();
    expect(() =>
      decodeLogsResult({
        workspaceScriptRunId: "workspace-script-run:operation-1",
        terminalId: "workspace-script-operation-1",
        history: "x".repeat(WORKSPACE_SCRIPT_LOG_MAX_BYTES + 1),
        truncated: true,
      }),
    ).toThrow();
  });

  it("拒绝与状态不一致的开始、结束时间", () => {
    expect(() =>
      decodeRun({
        ...runningRun,
        startedAtUnixMs: null,
      }),
    ).toThrow();
    expect(() =>
      decodeRun({
        ...runningRun,
        status: "exited",
        finishedAtUnixMs: null,
      }),
    ).toThrow();
  });

  it("拒绝尚未启动的 Run 进入 stopping 和 stopped", () => {
    const startingRun = {
      ...runningRun,
      status: "starting" as const,
      healthStatus: "unknown" as const,
      healthCheckedAtUnixMs: null,
      ports: [],
      revision: 1,
      startedAtUnixMs: null,
      updatedAtUnixMs: 1_000,
    };

    expect(() =>
      decodeRun({
        ...startingRun,
        status: "stopping",
        revision: 2,
        updatedAtUnixMs: 1_001,
      }),
    ).toThrow();
    expect(() =>
      decodeRun({
        ...startingRun,
        status: "stopped",
        revision: 3,
        finishedAtUnixMs: 1_002,
        updatedAtUnixMs: 1_002,
      }),
    ).toThrow();
  });

  it("失败终态必须有成对错误信息，非失败状态不得伪装错误", () => {
    expect(() =>
      decodeRun({
        ...runningRun,
        status: "failed",
        finishedAtUnixMs: 1_300,
        updatedAtUnixMs: 1_300,
        healthStatus: "unknown",
        healthCheckedAtUnixMs: null,
        errorCode: "workspace_script_start_failed",
        errorDetail: null,
      }),
    ).toThrow();
    expect(() =>
      decodeRun({
        ...runningRun,
        errorCode: "unexpected",
        errorDetail: "运行中不能携带终态错误。",
      }),
    ).toThrow();
  });

  it("拒绝重复端口和越界端口", () => {
    expect(() =>
      decodeRun({
        ...runningRun,
        ports: [runningRun.ports[0], runningRun.ports[0]],
      }),
    ).toThrow();
    expect(() =>
      decodeRun({
        ...runningRun,
        ports: [{ ...runningRun.ports[0], port: 70_000 }],
      }),
    ).toThrow();
  });
});
