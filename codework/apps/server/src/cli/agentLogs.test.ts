import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, vi } from "vite-plus/test";

import type { ControlClientOpen } from "./controlClient.ts";
import { makeAgentThread } from "./agentControl.testFixtures.ts";
import { formatAgentLogs } from "./agentControlOutput.ts";
import { getAgentLogs } from "./agentControlRpc.ts";

describe("Agent logs CLI", () => {
  it.effect("通过只读 Thread 快照返回 Agent 消息历史", () =>
    Effect.gen(function* () {
      const thread = makeAgentThread();
      const subscribe = vi.fn(() =>
        Stream.fromIterable([
          {
            kind: "snapshot" as const,
            snapshot: { snapshotSequence: 8, thread },
          },
        ]),
      );
      const open: ControlClientOpen = (_connection, use) =>
        use({ "orchestration.subscribeThread": subscribe } as never);

      const result = yield* getAgentLogs(
        {
          serverUrl: "http://127.0.0.1:3773",
          agentId: "thread-agent-1",
        },
        open,
      );

      expect(result.agentId).toBe("thread-agent-1");
      expect(result.messages).toEqual(thread.messages);
      expect(subscribe).toHaveBeenCalledWith({
        threadId: "thread-agent-1",
        requestCompletionMarker: true,
      });
    }),
  );

  it("文本模式按时间和角色输出，并移除终端控制字符", () => {
    const logs = {
      agentId: "thread-agent-1",
      messages: makeAgentThread().messages,
    };

    const output = formatAgentLogs(logs, false);

    expect(output).toContain("[2026-08-30T00:00:00.000Z] user");
    expect(output).toContain("[2026-08-30T00:00:01.000Z] assistant (streaming)");
    expect(output).toContain("正在检查失败点");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u0000");
  });

  it("JSON 模式保留消息合同，空历史返回明确文本", () => {
    const logs = {
      agentId: "thread-agent-1",
      messages: makeAgentThread().messages,
    };

    expect(formatAgentLogs(logs, true)).toBe(JSON.stringify(logs, null, 2));
    expect(formatAgentLogs({ agentId: "thread-agent-1", messages: [] }, false)).toBe(
      "No agent messages found.",
    );
  });
});
