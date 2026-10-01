import { describe, expect, it } from "vite-plus/test";
import { EventId, ProviderDriverKind, ThreadId, TurnId } from "@codework/contracts";
import { runtimeEventToActivities } from "../../orchestration/Layers/ProviderRuntimeIngestion.ts";
import { projectActivityPayload } from "../../orchestration/ActivityPayloadProjection.ts";
import { makeAcpToolCallEvent } from "./AcpCoreRuntimeEvents.ts";
import { parseSessionUpdateEvent } from "./AcpRuntimeModel.ts";

describe("ACP 文件结果与展示摘要", () => {
  it.each(["        1→MISTRAL_SOURCE_72319", "首行\n" + "x".repeat(10000) + "\nFILE_TAIL"])(
    "读取正文保留在有界详情中，原始字段仍可检查",
    (content) => {
      const [event] = parseSessionUpdateEvent({
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "read",
          kind: "read",
          status: "completed",
          rawInput: { filePath: "source.txt" },
          rawOutput: { filePath: "source.txt", content, numLines: 1 },
          content: [
            { type: "content", content: { type: "text", text: "Read 1 line from source.txt" } },
          ],
        },
      }).events;
      if (event?._tag !== "ToolCallUpdated") throw new Error("缺少文件读取事件");
      expect(event.toolCall.status).toBe("completed");
      expect(event.toolCall.detail).toContain(content.slice(-20));
      expect(event.toolCall.detail!.length).toBeLessThanOrEqual(8000);
      expect(event.toolCall.data.content).toEqual([
        { type: "content", content: { type: "text", text: "Read 1 line from source.txt" } },
      ]);
      expect(event.toolCall.data.rawOutput).toMatchObject({ filePath: "source.txt", numLines: 1 });
      const [activity] = runtimeEventToActivities(
        makeAcpToolCallEvent({
          stamp: { eventId: EventId.make("read-output"), createdAt: "2026-10-01T00:00:00.000Z" },
          provider: ProviderDriverKind.make("acpAgent"),
          threadId: ThreadId.make("thread"),
          turnId: TurnId.make("turn"),
          toolCall: event.toolCall,
          rawPayload: event.rawPayload,
        }),
      );
      if (!activity) throw new Error("缺少读取活动");
      expect(projectActivityPayload(activity).payload).toMatchObject({
        detail: event.toolCall.detail,
      });
    },
  );

  it.each([false, 0, null, {}, ""])("非文本或空正文 %s 保留协议详情", (content) => {
    const [event] = parseSessionUpdateEvent({
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "read",
        kind: "read",
        status: "failed",
        rawOutput: { content },
        content: [{ type: "content", content: { type: "text", text: "读取失败" } }],
      },
    }).events;
    if (event?._tag !== "ToolCallUpdated") throw new Error("缺少读取失败事件");
    expect(event.toolCall).toMatchObject({ status: "failed", detail: "读取失败" });
  });

  it("其它工具的 content 字符串不推断为文件正文", () => {
    const [event] = parseSessionUpdateEvent({
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "unknown",
        kind: "other",
        rawOutput: { content: "内部元数据" },
        content: [{ type: "content", content: { type: "text", text: "工具结果" } }],
      },
    }).events;
    if (event?._tag !== "ToolCallUpdated") throw new Error("缺少工具事件");
    expect(event.toolCall.detail).toBe("工具结果");
  });
});
