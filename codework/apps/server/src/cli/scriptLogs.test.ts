import {
  WORKSPACE_SCRIPT_LOG_MAX_BYTES,
  type WorkspaceScriptLogsResult,
} from "@codework/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, vi } from "vite-plus/test";

import type { ControlClientOpen } from "./controlClient.ts";
import { formatWorkspaceScriptLogs, getWorkspaceScriptLogs } from "./script.ts";

const result: WorkspaceScriptLogsResult = {
  workspaceScriptRunId: "workspace-script-run:operation-1",
  terminalId: "workspace-script-operation-1",
  history: "server ready\nrequest handled\n",
  truncated: false,
};

describe("Workspace Script logs CLI", () => {
  it.effect("通过只读 typed RPC 查询 Run 自己持有的终端日志", () =>
    Effect.gen(function* () {
      const rpc = vi.fn(() => Effect.succeed(result));
      const connections: Array<Parameters<ControlClientOpen>[0]> = [];
      const open: ControlClientOpen = (connection, use) => {
        connections.push(connection);
        return use({ "server.getWorkspaceScriptLogs": rpc } as never);
      };

      expect(
        yield* getWorkspaceScriptLogs(
          {
            serverUrl: "https://codework.example.test",
            accessToken: "session-token",
            workspaceScriptRunId: result.workspaceScriptRunId,
          },
          open,
        ),
      ).toEqual(result);
      expect(connections).toEqual([
        {
          serverUrl: "https://codework.example.test",
          accessToken: "session-token",
        },
      ]);
      expect(rpc).toHaveBeenCalledWith({
        workspaceScriptRunId: result.workspaceScriptRunId,
      });
    }),
  );

  it("文本模式输出 transcript，JSON 模式保留完整合同", () => {
    expect(formatWorkspaceScriptLogs(result, false)).toBe("server ready\nrequest handled");
    expect(formatWorkspaceScriptLogs(result, true)).toBe(JSON.stringify(result, null, 2));
    expect(formatWorkspaceScriptLogs({ ...result, history: "" }, false)).toBe(
      "No workspace script output.",
    );
  });

  it("文本模式移除终端控制序列并显式提示尾部截断", () => {
    const output = formatWorkspaceScriptLogs(
      {
        ...result,
        history: "\u001b[2J\u001b]0;spoofed title\u0007server ready\r\n",
        truncated: true,
      },
      false,
    );

    expect(output).toBe(
      `[Earlier output truncated to the last ${String(WORKSPACE_SCRIPT_LOG_MAX_BYTES)} bytes]\nserver ready`,
    );
    expect(
      [...output].some((character) => {
        const codePoint = character.codePointAt(0)!;
        return (
          (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a) ||
          (codePoint >= 0x7f && codePoint <= 0x9f)
        );
      }),
    ).toBe(false);
  });
});
