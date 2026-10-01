import type * as AcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vite-plus/test";
import { parseSessionUpdateEvent } from "./AcpRuntimeModel.ts";
import { normalizeKiloToolResult } from "./KiloAcpToolResult.ts";

const notification = {
  sessionId: "s",
  update: {
    sessionUpdate: "tool_call_update",
    toolCallId: "call_kilo_4",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "(no output)" } }],
    rawOutput: {
      output: "(no output)",
      metadata: { output: "(no output)", exit: 7, description: "exit 7", truncated: false },
    },
  },
} satisfies AcpSchema.SessionNotification;

describe("Kilo 命令退出结果", () => {
  it("无 kind 的真实终态根据退出码失败，详情可见，原帧不变", () => {
    const normalized = normalizeKiloToolResult(notification, "Kilo");
    expect(parseSessionUpdateEvent(normalized).events[0]).toMatchObject({
      _tag: "ToolCallUpdated",
      toolCall: {
        status: "failed",
        detail: "(no output)\nExit code: 7",
        data: { rawOutput: { exitCode: 7, metadata: notification.update.rawOutput.metadata } },
      },
    });
    expect(notification.update.status).toBe("completed");
    expect(notification.update.rawOutput).not.toHaveProperty("exitCode");
    expect(normalized.update).toMatchObject({
      content: [
        ...notification.update.content,
        { type: "content", content: { type: "text", text: "Exit code: 7" } },
      ],
    });
  });
  it("退出0仍完成，已有字段、其它Agent/工具/阶段不覆盖", () => {
    const zero = {
      ...notification,
      update: { ...notification.update, rawOutput: { metadata: { exit: 0 } } },
    };
    expect(normalizeKiloToolResult(zero, "Kilo").update).toMatchObject({
      status: "completed",
      rawOutput: { exitCode: 0 },
    });
    expect(normalizeKiloToolResult(notification, "Copilot")).toBe(notification);
    for (const patch of [
      { kind: "read" as const },
      { status: "failed" as const },
      { rawOutput: { ...notification.update.rawOutput, exitCode: 0 } },
    ]) {
      const input = { ...notification, update: { ...notification.update, ...patch } };
      expect(normalizeKiloToolResult(input, "Kilo")).toBe(input);
    }
  });
  it("缺少结构化码或畸形码不从文字推断", () => {
    for (const rawOutput of [
      null,
      [],
      { output: "Exit code: 7" },
      { metadata: null },
      { metadata: { exit: "7" } },
      { metadata: { exit: -1 } },
      { metadata: { exit: 1.5 } },
      { metadata: { exit: 4294967296 } },
    ]) {
      const input = { ...notification, update: { ...notification.update, rawOutput } };
      expect(normalizeKiloToolResult(input, "Kilo")).toBe(input);
    }
  });
});
