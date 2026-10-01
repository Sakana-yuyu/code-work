import type * as AcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vite-plus/test";
import { parseSessionUpdateEvent } from "./AcpRuntimeModel.ts";
import { normalizeCopilotToolResult } from "./CopilotAcpToolResult.ts";

const notification = {
  sessionId: "s",
  update: {
    sessionUpdate: "tool_call_update",
    toolCallId: "call_copilot_4",
    status: "completed",
    content: [
      {
        type: "content",
        content: { type: "text", text: "\n<shellId: 1 completed with exit code 7>" },
      },
    ],
    rawOutput: {
      content: "\n<shellId: 1 completed with exit code 7>",
      detailedContent: "\n<shellId: 1 completed with exit code 7>",
      contents: [{ type: "shell_exit", shellId: "1", exitCode: 7 }],
    },
  },
} satisfies AcpSchema.SessionNotification;

describe("Copilot shell_exit 结构化结果", () => {
  it("真实无 kind 终态保留完整结果并进入失败合同，原始帧不变", () => {
    const normalized = normalizeCopilotToolResult(notification, "Copilot");
    expect(parseSessionUpdateEvent(normalized).events[0]).toMatchObject({
      _tag: "ToolCallUpdated",
      toolCall: {
        status: "failed",
        data: { rawOutput: { exitCode: 7, contents: [{ type: "shell_exit", exitCode: 7 }] } },
      },
    });
    expect(notification.update.status).toBe("completed");
    expect(notification.update.rawOutput).not.toHaveProperty("exitCode");
    expect(normalized.update).toMatchObject({ content: notification.update.content });
  });
  it("退出0显示完成且提供原生退出码，其它Agent/工具/阶段和已有字段不覆盖", () => {
    const zero = {
      ...notification,
      update: {
        ...notification.update,
        rawOutput: { contents: [{ type: "shell_exit", exitCode: 0 }] },
      },
    };
    expect(normalizeCopilotToolResult(zero, "Copilot").update).toMatchObject({
      status: "completed",
      rawOutput: { exitCode: 0 },
    });
    expect(normalizeCopilotToolResult(notification, "other-agent")).toBe(notification);
    for (const patch of [
      { kind: "read" as const },
      { status: "in_progress" as const },
      { rawOutput: { ...notification.update.rawOutput, exitCode: 0 } },
    ]) {
      const input = { ...notification, update: { ...notification.update, ...patch } };
      expect(normalizeCopilotToolResult(input, "Copilot")).toBe(input);
    }
  });
  it("拒绝畸形/非唯一退出码，不从完成标签和文字推断", () => {
    for (const rawOutput of [
      null,
      [],
      { content: "exit code 7" },
      { contents: [] },
      {
        contents: [
          { type: "shell_exit", exitCode: 0 },
          { type: "shell_exit", exitCode: 7 },
        ],
      },
      ...["7", -1, 1.5, 4294967296, NaN].map((exitCode) => ({
        contents: [{ type: "shell_exit", exitCode }],
      })),
    ]) {
      const input = { ...notification, update: { ...notification.update, rawOutput } };
      expect(normalizeCopilotToolResult(input, "Copilot")).toBe(input);
    }
  });
});
