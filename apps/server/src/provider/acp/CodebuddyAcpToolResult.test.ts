import type * as AcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vite-plus/test";
import { parseSessionUpdateEvent } from "./AcpRuntimeModel.ts";
import {
  normalizeCodebuddyToolResult,
  normalizeCodebuddyCancelledToolNotification,
} from "./CodebuddyAcpToolResult.ts";

const text = "Command: exit 7\nStdout: (empty)\nExit Code: 7";
const notification = {
  sessionId: "s",
  update: {
    sessionUpdate: "tool_call_update",
    toolCallId: "call_codebuddy_4",
    status: "completed",
    _meta: {
      "codebuddy.ai/toolName": "PowerShell",
      "codebuddy.ai/rawResponse": { exitCode: 7, signal: null, interrupted: false },
    },
    rawOutput: { type: "text", text },
    content: [{ type: "content", content: { type: "text", text } }],
  },
} satisfies AcpSchema.SessionNotification;

describe("CodeBuddy 命令退出结果", () => {
  it("真实省略 kind 的终态按专有退出码失败，保留正文与原帧", () => {
    const normalized = normalizeCodebuddyToolResult(notification);
    expect(parseSessionUpdateEvent(normalized).events[0]).toMatchObject({
      _tag: "ToolCallUpdated",
      toolCall: {
        status: "failed",
        detail: text,
        data: { rawOutput: { type: "text", text, exitCode: 7 } },
      },
    });
    expect(normalized.update._meta).toBe(notification.update._meta);
    expect(normalized.update).toMatchObject({ content: notification.update.content });
    expect(notification.update.status).toBe("completed");
    expect(notification.update.rawOutput).not.toHaveProperty("exitCode");
    expect(
      normalizeCodebuddyToolResult({
        ...notification,
        update: { ...notification.update, kind: null },
      }).update,
    ).toMatchObject({ status: "failed" });
  });
  it("零码保持完成，已有字段与其它工具/阶段不覆盖", () => {
    const zero = {
      ...notification,
      update: {
        ...notification.update,
        _meta: { "codebuddy.ai/toolName": "Bash", "codebuddy.ai/rawResponse": { exitCode: 0 } },
      },
    };
    expect(normalizeCodebuddyToolResult(zero).update).toMatchObject({
      status: "completed",
      rawOutput: { exitCode: 0 },
    });
    for (const patch of [
      { kind: "read" as const },
      { status: "failed" as const },
      { rawOutput: { ...notification.update.rawOutput, exitCode: 0 } },
      { _meta: { "codebuddy.ai/toolName": "Read", "codebuddy.ai/rawResponse": { exitCode: 7 } } },
    ]) {
      const input = { ...notification, update: { ...notification.update, ...patch } };
      expect(normalizeCodebuddyToolResult(input)).toBe(input);
    }
  });
  it("无厂商信封或畸形码不从正文推断", () => {
    const noMeta = { ...notification, update: { ...notification.update, _meta: null } };
    expect(normalizeCodebuddyToolResult(noMeta)).toBe(noMeta);
    for (const rawResponse of [
      null,
      [],
      {},
      { exitCode: "7" },
      { exitCode: -1 },
      { exitCode: 1.5 },
      { exitCode: 4294967296 },
    ]) {
      const input = {
        ...notification,
        update: {
          ...notification.update,
          _meta: { "codebuddy.ai/toolName": "PowerShell", "codebuddy.ai/rawResponse": rawResponse },
        },
      };
      expect(normalizeCodebuddyToolResult(input)).toBe(input);
    }
  });
  it("专有取消保留原帧和元数据，拒绝及会话取消均显示终态原因", () => {
    for (const reason of ["permission_denied", "session_interrupted"] as const) {
      const raw = {
        sessionId: "s",
        _meta: { "codebuddy.ai": { mode: "history" } },
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "c",
          status: "cancelled",
          _meta: { "codebuddy.ai/toolCancelReason": reason, "codebuddy.ai/toolName": "Write" },
        },
      };
      const normalized = normalizeCodebuddyCancelledToolNotification(raw);
      expect(normalized?.update._meta).toBe(raw.update._meta);
      expect(normalized?._meta).toBe(raw._meta);
      expect(normalized && parseSessionUpdateEvent(normalized).events[0]).toMatchObject({
        _tag: "ToolCallUpdated",
        toolCall: {
          status: "failed",
          detail:
            reason === "permission_denied" ? "用户已拒绝工具执行。" : "会话已取消，工具未完成。",
        },
      });
      expect(raw.update.status).toBe("cancelled");
      for (const patch of [
        { _meta: {} },
        { status: "failed" },
        { toolCallId: "" },
        { kind: "unknown" },
      ])
        expect(
          normalizeCodebuddyCancelledToolNotification({
            ...raw,
            update: { ...raw.update, ...patch },
          }),
        ).toBeUndefined();
    }
  });
});
