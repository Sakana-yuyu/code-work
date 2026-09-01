import type {
  WorkspaceScriptRunResult,
  WorkspaceScriptStartRequest,
  WorkspaceScriptStopRequest,
} from "@codework/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, vi } from "vite-plus/test";

import type { ControlClientOpen } from "./controlClient.ts";
import {
  decodeWorkspaceScriptStartInput,
  startWorkspaceScript,
  stopWorkspaceScript,
} from "./script.ts";

const startInput: WorkspaceScriptStartRequest = {
  operationId: "operation-start",
  projectId: "project-1",
  threadId: "thread-1",
  scriptId: "preview",
  worktreePath: "E:\\repo\\.worktrees\\feature",
  compositionTaskId: "composition-task-1",
  compositionRunId: "composition-run-1",
};

const result: WorkspaceScriptRunResult = {
  run: {
    workspaceScriptRunId: "workspace-script-run:operation-start",
    idempotencyKey: "workspace-script:project-1:thread-1:preview:operation-start",
    projectId: "project-1",
    threadId: "thread-1",
    scriptId: "preview",
    scriptName: "Preview",
    terminalId: "workspace-script-operation-start",
    cwd: "E:\\repo\\.worktrees\\feature",
    worktreePath: "E:\\repo\\.worktrees\\feature",
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
    compositionTaskId: "composition-task-1",
    compositionRunId: "composition-run-1",
    updatedAtUnixMs: 1_100,
  },
};

describe("Workspace Script lifecycle CLI", () => {
  it.effect("start 通过 typed RPC 透传完整合同和稳定 operation id", () =>
    Effect.gen(function* () {
      const rpc = vi.fn(() => Effect.succeed(result));
      const open: ControlClientOpen = (_connection, use) =>
        use({ "server.startWorkspaceScript": rpc } as never);

      expect(
        yield* startWorkspaceScript(
          {
            serverUrl: "http://127.0.0.1:3773",
            input: startInput,
          },
          open,
        ),
      ).toEqual(result);
      expect(rpc).toHaveBeenCalledWith(startInput);
    }),
  );

  it.effect("start 省略可选关联时不会补写 null 或空字符串", () =>
    Effect.gen(function* () {
      const rpc = vi.fn(() => Effect.succeed(result));
      const open: ControlClientOpen = (_connection, use) =>
        use({ "server.startWorkspaceScript": rpc } as never);
      const minimalInput: WorkspaceScriptStartRequest = {
        operationId: "operation-minimal",
        projectId: "project-1",
        threadId: "thread-1",
        scriptId: "preview",
      };

      yield* startWorkspaceScript(
        {
          serverUrl: "http://127.0.0.1:3773",
          input: minimalInput,
        },
        open,
      );

      expect(rpc).toHaveBeenCalledWith(minimalInput);
    }),
  );

  it.effect("stop 通过 typed RPC 透传 run、operation id 和 expected revision", () =>
    Effect.gen(function* () {
      const rpc = vi.fn(() => Effect.succeed(result));
      const open: ControlClientOpen = (_connection, use) =>
        use({ "server.stopWorkspaceScript": rpc } as never);
      const input: WorkspaceScriptStopRequest = {
        workspaceScriptRunId: result.run.workspaceScriptRunId,
        operationId: "operation-stop",
        expectedRevision: 2,
      };

      expect(
        yield* stopWorkspaceScript(
          {
            serverUrl: "http://127.0.0.1:3773",
            input,
          },
          open,
        ),
      ).toEqual(result);
      expect(rpc).toHaveBeenCalledWith(input);
    }),
  );

  it.effect("start 使用完整合同校验 Composition task 和 run 必须成对", () =>
    Effect.gen(function* () {
      expect(yield* decodeWorkspaceScriptStartInput(startInput)).toEqual(startInput);
      expect(
        yield* decodeWorkspaceScriptStartInput({
          operationId: "operation-minimal",
          projectId: "project-1",
          threadId: "thread-1",
          scriptId: "preview",
        }),
      ).toEqual({
        operationId: "operation-minimal",
        projectId: "project-1",
        threadId: "thread-1",
        scriptId: "preview",
      });

      const missingRun = yield* decodeWorkspaceScriptStartInput({
        operationId: "operation-invalid",
        projectId: "project-1",
        threadId: "thread-1",
        scriptId: "preview",
        compositionTaskId: "composition-task-1",
      }).pipe(Effect.flip);
      expect(missingRun).toMatchObject({
        _tag: "WorkspaceScriptStartInputError",
        message:
          "Workspace Script start input does not match the Code Work contract; Composition task and run ids must be provided together.",
      });

      const missingTask = yield* decodeWorkspaceScriptStartInput({
        operationId: "operation-invalid",
        projectId: "project-1",
        threadId: "thread-1",
        scriptId: "preview",
        compositionRunId: "composition-run-1",
      }).pipe(Effect.flip);
      expect(missingTask).toMatchObject({ _tag: "WorkspaceScriptStartInputError" });
    }),
  );
});
