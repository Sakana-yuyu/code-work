import type {
  WorkspaceScriptRun,
  WorkspaceScriptRunListResult,
  WorkspaceScriptRunResult,
} from "@codework/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, vi } from "vite-plus/test";

import type { ControlClientOpen } from "./controlClient.ts";
import {
  decodeWorkspaceScriptStatuses,
  formatWorkspaceScriptRunDetails,
  formatWorkspaceScriptRunList,
  getWorkspaceScriptRun,
  listWorkspaceScriptRuns,
} from "./script.ts";

const run: WorkspaceScriptRun = {
  workspaceScriptRunId: "workspace-script-run:operation-1",
  idempotencyKey: "workspace-script:project-1:thread-1:preview:operation-1",
  projectId: "project-1",
  threadId: "thread-1",
  scriptId: "preview",
  scriptName: "Preview",
  terminalId: "terminal-1",
  cwd: "E:\\repo",
  worktreePath: null,
  status: "running",
  healthStatus: "healthy",
  healthCheckedAtUnixMs: 1_500,
  healthDetail: null,
  ports: [
    {
      port: 4_173,
      protocol: "http",
      source: "declared",
      url: "http://127.0.0.1:4173",
    },
  ],
  revision: 3,
  requestedAtUnixMs: 1_000,
  startedAtUnixMs: 1_200,
  finishedAtUnixMs: null,
  exitCode: null,
  exitSignal: null,
  errorCode: null,
  errorDetail: null,
  compositionTaskId: "composition-task-1",
  compositionRunId: "composition-run-1",
  updatedAtUnixMs: 2_000,
};

const listResult: WorkspaceScriptRunListResult = { runs: [run] };
const detailsResult: WorkspaceScriptRunResult = { run };

describe("Workspace Script CLI", () => {
  it.effect("通过 typed RPC 查询运行记录，并透传项目、线程和状态过滤", () =>
    Effect.gen(function* () {
      const rpc = vi.fn(() => Effect.succeed(listResult));
      const connections: Array<Parameters<ControlClientOpen>[0]> = [];
      const open: ControlClientOpen = (connection, use) => {
        connections.push(connection);
        return use({ "server.listWorkspaceScriptRuns": rpc } as never);
      };

      const result = yield* listWorkspaceScriptRuns(
        {
          serverUrl: "https://codework.example.test",
          accessToken: "session-token",
          projectId: "project-1",
          threadId: "thread-1",
          statuses: ["starting", "running"],
        },
        open,
      );

      expect(result).toEqual(listResult);
      expect(connections).toEqual([
        {
          serverUrl: "https://codework.example.test",
          accessToken: "session-token",
        },
      ]);
      expect(rpc).toHaveBeenCalledWith({
        projectId: "project-1",
        threadId: "thread-1",
        statuses: ["starting", "running"],
      });
    }),
  );

  it.effect("通过 typed RPC 精确查询单个运行记录", () =>
    Effect.gen(function* () {
      const rpc = vi.fn(() => Effect.succeed(detailsResult));
      const open: ControlClientOpen = (_connection, use) =>
        use({ "server.getWorkspaceScriptRun": rpc } as never);

      const result = yield* getWorkspaceScriptRun(
        {
          serverUrl: "http://127.0.0.1:3773",
          workspaceScriptRunId: run.workspaceScriptRunId,
        },
        open,
      );

      expect(result).toEqual(detailsResult);
      expect(rpc).toHaveBeenCalledWith({
        workspaceScriptRunId: "workspace-script-run:operation-1",
      });
    }),
  );

  it.effect("使用 Effect Schema 校验逗号分隔的运行状态", () =>
    Effect.gen(function* () {
      expect(yield* decodeWorkspaceScriptStatuses("starting, running")).toEqual([
        "starting",
        "running",
      ]);

      const unknownStatus = yield* decodeWorkspaceScriptStatuses("running,unknown").pipe(
        Effect.flip,
      );
      expect(unknownStatus).toMatchObject({
        _tag: "WorkspaceScriptStatusInputError",
        message:
          "Workspace script statuses must be starting, running, stopping, stopped, exited, or failed.",
      });

      const emptyStatuses = yield* decodeWorkspaceScriptStatuses(",").pipe(Effect.flip);
      expect(emptyStatuses).toMatchObject({ _tag: "WorkspaceScriptStatusInputError" });
    }),
  );

  it("输出稳定的 JSON 或紧凑的人类可读列表", () => {
    expect(formatWorkspaceScriptRunList(listResult, true)).toBe(
      JSON.stringify(listResult.runs, null, 2),
    );
    expect(formatWorkspaceScriptRunList(listResult, false)).toBe(
      "Preview  workspace-script-run:operation-1  r3  running  healthy  project=project-1  thread=thread-1  updated=1970-01-01T00:00:02.000Z",
    );
    expect(formatWorkspaceScriptRunList({ runs: [] }, false)).toBe(
      "No workspace script runs found.",
    );
  });

  it("输出包含运行、健康、终端、端口和 Composition 关联的详情", () => {
    expect(formatWorkspaceScriptRunDetails(detailsResult, true)).toBe(JSON.stringify(run, null, 2));
    expect(formatWorkspaceScriptRunDetails(detailsResult, false)).toBe(
      [
        "Preview (workspace-script-run:operation-1)",
        "Project: project-1",
        "Thread: thread-1",
        "Script: preview",
        "Revision: 3",
        "Status: running",
        "Health: healthy at 1970-01-01T00:00:01.500Z",
        "Terminal: terminal-1",
        "CWD: E:\\repo",
        "Worktree: none",
        "Ports: http:4173 declared http://127.0.0.1:4173",
        "Requested: 1970-01-01T00:00:01.000Z",
        "Started: 1970-01-01T00:00:01.200Z",
        "Finished: none",
        "Updated: 1970-01-01T00:00:02.000Z",
        "Exit: none",
        "Error: none",
        "Composition: task=composition-task-1 run=composition-run-1",
      ].join("\n"),
    );
  });
});
