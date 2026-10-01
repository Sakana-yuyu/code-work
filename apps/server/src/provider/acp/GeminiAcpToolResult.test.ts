import type * as AcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vite-plus/test";
import { parseSessionUpdateEvent } from "./AcpRuntimeModel.ts";
import { normalizeGeminiToolResult } from "./GeminiAcpToolResult.ts";

const notification = {
  sessionId: "s",
  update: {
    sessionUpdate: "tool_call_update",
    toolCallId: "run_shell_command__gemini-tool-4",
    kind: "execute",
    status: "completed",
    title: "exit 7",
    content: [{ type: "content", content: { type: "text", text: "Command exited with code: 7" } }],
    locations: [],
  },
} satisfies AcpSchema.SessionNotification;

describe("Gemini 命令结果边界", () => {
  it("实际0.61.0失败帧进入现有工具失败合同，原始通知不变", () => {
    const normalized = normalizeGeminiToolResult(notification, "gemini-cli");
    const parsed = parseSessionUpdateEvent(normalized).events;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      _tag: "ToolCallUpdated",
      toolCall: {
        status: "failed",
        detail: "Command exited with code: 7",
        data: { rawOutput: { exitCode: 7 } },
      },
    });
    expect(notification.update).toMatchObject({ status: "completed" });
  });

  it("其它Agent、工具、阶段和已有结构化结果不做文本推断", () => {
    expect(normalizeGeminiToolResult(notification, "other-agent")).toBe(notification);
    for (const patch of [
      { toolCallId: "other-tool" },
      { kind: "read" as const },
      { status: "in_progress" as const },
      { rawOutput: { exitCode: 0 } },
    ]) {
      const input = { ...notification, update: { ...notification.update, ...patch } };
      expect(normalizeGeminiToolResult(input, "gemini-cli")).toBe(input);
    }
  });

  it("成功输出、零值、超范围及非标准正文保持原值", () => {
    for (const text of [
      "GEMINI_SHELL_72319",
      "Command exited with code: 0",
      "Command exited with code: 4294967296",
      "Command exited with code: 9007199254740993",
      "引用：Command exited with code: 7",
      "Command exited with code: 7\n更多正文",
    ]) {
      const input: AcpSchema.SessionNotification = {
        ...notification,
        update: {
          ...notification.update,
          content: [{ type: "content", content: { type: "text", text } }],
        },
      };
      expect(normalizeGeminiToolResult(input, "gemini-cli")).toBe(input);
    }
  });
});
