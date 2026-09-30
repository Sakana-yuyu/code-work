import {
  EventId,
  ProviderDriverKind,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";
import { projectActivityPayload } from "../../orchestration/ActivityPayloadProjection.ts";
import { parseSessionUpdateEvent } from "./AcpRuntimeModel.ts";
import { runtimeEventToActivities } from "../../orchestration/Layers/ProviderRuntimeIngestion.ts";

import {
  makeAcpAssistantItemEvent,
  makeAcpCommandsUpdatedEvent,
  makeAcpConfigOptionsUpdatedEvent,
  makeAcpModelsUpdatedEvent,
  makeAcpModesUpdatedEvent,
  makeAcpContentDeltaEvent,
  makeAcpUsageUpdatedEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "./AcpCoreRuntimeEvents.ts";

describe("AcpCoreRuntimeEvents", () => {
  it("上下文用量清零时仍投影新快照，防止客户端保留旧值", () => {
    const rawPayload = {
      update: {
        sessionUpdate: "usage_update",
        used: 0,
        size: 64_000,
        cost: { amount: 7, currency: "USD" },
      },
    };
    const event = makeAcpUsageUpdatedEvent({
      stamp: { eventId: EventId.make("usage-zero"), createdAt: "2026-09-30T00:00:00.000Z" },
      provider: ProviderDriverKind.make("acpAgent"),
      threadId: ThreadId.make("thread-1"),
      turnId: undefined,
      usage: { usedTokens: 0, maxTokens: 64_000 },
      rawPayload,
    });
    expect(event.raw?.payload).toEqual(rawPayload);
    expect(runtimeEventToActivities(event)).toMatchObject([
      { kind: "context-window.updated", payload: { usedTokens: 0, maxTokens: 64_000 } },
    ]);
    expect(runtimeEventToActivities(event)[0]?.payload).not.toHaveProperty("cost");
    expect(runtimeEventToActivities(event)[0]?.payload).not.toHaveProperty("totalProcessedTokens");
  });

  it("ACP 思考沿用 reasoning_text 合同，不能作为正文或摘要活动持久化", () => {
    const event = makeAcpContentDeltaEvent({
      stamp: { eventId: "thought-1" as never, createdAt: "2026-09-29T00:00:00.000Z" },
      provider: ProviderDriverKind.make("acpAgent"),
      threadId: "thread-1" as never,
      turnId: TurnId.make("turn-1"),
      streamKind: "reasoning_text",
      text: "协议测试思考片段",
      rawPayload: {},
    });
    expect(event).toMatchObject({
      type: "content.delta",
      payload: { streamKind: "reasoning_text", delta: "协议测试思考片段" },
    });
    expect(runtimeEventToActivities(event)).toEqual([]);
  });
  it("动态元数据统一进入会话活动，保留原始选择和撤回值", () => {
    const base = {
      stamp: { eventId: EventId.make("metadata"), createdAt: "2026-09-30T00:00:00.000Z" },
      provider: ProviderDriverKind.make("acpAgent"),
      threadId: ThreadId.make("thread-1"),
      rawPayload: { sessionId: "root" },
    };
    const mode = {
      id: "acpMode",
      label: "Agent 模式",
      type: "select" as const,
      currentValue: "https://example.com/modes#review",
      options: [{ id: "https://example.com/modes#review", label: "审查" }],
    };
    const events = [
      makeAcpCommandsUpdatedEvent({ ...base, commands: [] }),
      makeAcpModelsUpdatedEvent({ ...base, models: [] }),
      makeAcpModesUpdatedEvent({ ...base, mode }),
      makeAcpConfigOptionsUpdatedEvent({ ...base, configOptions: [] }),
      makeAcpModesUpdatedEvent({ ...base, mode: null }),
    ];
    expect(events.every((event) => event.type === "session.configured")).toBe(true);
    expect(events.flatMap((event) => runtimeEventToActivities(event))).toMatchObject([
      {
        kind: "session.commands.updated",
        payload: { providerInstanceId: "acpAgent", commands: [] },
      },
      { kind: "session.models.updated", payload: { providerInstanceId: "acpAgent", models: [] } },
      { kind: "session.mode.updated", payload: { providerInstanceId: "acpAgent", mode } },
      {
        kind: "session.config-options.updated",
        payload: { providerInstanceId: "acpAgent", configOptions: [] },
      },
      { kind: "session.mode.updated", payload: { providerInstanceId: "acpAgent", mode: null } },
    ]);
  });
  it.each(["content", "mcp", "batch"] as const)(
    "%s 长输出的末尾通过终态和公开历史投影，截断标记计入上限",
    (shape) => {
      const text = `${"x".repeat(20_000)}FINAL_OUTPUT`;
      const [event] = parseSessionUpdateEvent({
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "long-output",
          kind: "execute",
          status: "completed",
          ...(shape === "content"
            ? { content: [{ type: "content" as const, content: { type: "text" as const, text } }] }
            : {
                rawOutput:
                  shape === "mcp"
                    ? { content: [{ type: "text", text }] }
                    : [{ query: "long command", result: text, success: true }],
              }),
        },
      }).events;
      if (event?._tag !== "ToolCallUpdated") throw new Error("缺少工具事件");
      const [activity] = runtimeEventToActivities(
        makeAcpToolCallEvent({
          stamp: { eventId: "long-output" as never, createdAt: "2026-09-30T00:00:00.000Z" },
          provider: ProviderDriverKind.make("acpAgent"),
          threadId: "t" as never,
          turnId: TurnId.make("turn"),
          toolCall: event.toolCall,
          rawPayload: event.rawPayload,
        }),
      );
      if (!activity) throw new Error("缺少工具活动");
      const payload = projectActivityPayload(activity).payload as { detail: string };
      expect(payload.detail).toHaveLength(8_000);
      expect(payload.detail).toContain("[Earlier output truncated]");
      expect(payload.detail).toMatch(/FINAL_OUTPUT$/);
      expect(payload.detail).toEqual(event.toolCall.detail);
    },
  );
  it.each(["acpAgent", "grok"])("%s 批量工具的输出和失败进入同一活动投影", (driver) => {
    const raw = {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "batch",
        title: "run_commands",
        kind: "execute",
        status: "completed",
        rawInput: { commands: ["exit 7"] },
        rawOutput: [{ query: "exit 7", result: "Exit code: 7", success: false }],
      },
    } as const;
    const [event] = parseSessionUpdateEvent(raw).events;
    if (event?._tag !== "ToolCallUpdated") throw new Error("缺少工具事件");
    expect(
      runtimeEventToActivities(
        makeAcpToolCallEvent({
          stamp: { eventId: "batch" as never, createdAt: "2026-09-30T00:00:00.000Z" },
          provider: ProviderDriverKind.make(driver),
          threadId: "t" as never,
          turnId: TurnId.make("turn"),
          toolCall: event.toolCall,
          rawPayload: raw,
        }),
      ),
    ).toMatchObject([
      {
        kind: "tool.completed",
        payload: {
          toolCallId: "batch",
          status: "failed",
          detail: "exit 7\nExit code: 7",
          data: { command: "exit 7" },
        },
      },
    ]);
  });
  it.each(["cursor", "grok"])("%s 的 ACP 工具失败保留同一调用 ID 与详情", (driver) => {
    const event = makeAcpToolCallEvent({
      stamp: { eventId: `failed-${driver}` as never, createdAt: "2026-03-27T00:00:00.000Z" },
      provider: ProviderDriverKind.make(driver),
      threadId: "thread-1" as never,
      turnId: TurnId.make("turn-1"),
      toolCall: {
        toolCallId: "tool-failed-1",
        kind: "execute",
        status: "failed",
        title: "Terminal",
        detail: "命令执行失败",
        data: { command: "check" },
      },
      rawPayload: { sessionId: "session-1" },
    });

    expect(event).toMatchObject({ type: "item.completed", payload: { status: "failed" } });
    expect(runtimeEventToActivities(event)).toMatchObject([
      {
        kind: "tool.completed",
        payload: { toolCallId: "tool-failed-1", status: "failed", detail: "命令执行失败" },
      },
    ]);
  });

  it.each(["cursor", "grok"])("%s 的 ACP 工具失败保留同一调用 ID 与详情", (driver) => {
    const event = makeAcpToolCallEvent({
      stamp: { eventId: `failed-${driver}` as never, createdAt: "2026-03-27T00:00:00.000Z" },
      provider: ProviderDriverKind.make(driver),
      threadId: "thread-1" as never,
      turnId: TurnId.make("turn-1"),
      toolCall: {
        toolCallId: "tool-failed-1",
        kind: "execute",
        status: "failed",
        title: "Terminal",
        detail: "命令执行失败",
        data: { command: "check" },
      },
      rawPayload: { sessionId: "session-1" },
    });

    expect(event).toMatchObject({ type: "item.completed", payload: { status: "failed" } });
    expect(runtimeEventToActivities(event)).toMatchObject([
      {
        kind: "tool.completed",
        payload: { toolCallId: "tool-failed-1", status: "failed", detail: "命令执行失败" },
      },
    ]);
  });

  it("maps ACP permission requests to canonical runtime events", () => {
    const stamp = { eventId: "event-1" as never, createdAt: "2026-03-27T00:00:00.000Z" };
    const turnId = TurnId.make("turn-1");
    const permissionRequest = {
      kind: "execute" as const,
      detail: "cat package.json",
      toolCall: {
        toolCallId: "tool-1",
        kind: "execute",
        status: "pending" as const,
        command: "cat package.json",
        detail: "cat package.json",
        data: { toolCallId: "tool-1", kind: "execute" },
      },
    };

    expect(
      makeAcpRequestOpenedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        requestId: RuntimeRequestId.make("request-1"),
        permissionRequest,
        detail: "cat package.json",
        args: { command: ["cat", "package.json"] },
        source: "acp.jsonrpc",
        method: "session/request_permission",
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "request.opened",
      payload: {
        requestType: "exec_command_approval",
        detail: "cat package.json",
      },
    });

    expect(
      makeAcpRequestResolvedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        requestId: RuntimeRequestId.make("request-1"),
        permissionRequest,
        decision: "accept",
      }),
    ).toMatchObject({
      type: "request.resolved",
      payload: {
        requestType: "exec_command_approval",
        decision: "accept",
      },
    });
  });

  it("maps generic ACP permission kinds to dynamic tool approvals", () => {
    const stamp = { eventId: "event-1" as never, createdAt: "2026-03-27T00:00:00.000Z" };

    for (const kind of ["search", "fetch", "other", "unknown", "future-tool-kind"]) {
      const permissionRequest = { kind };
      const request = {
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId: TurnId.make("turn-1"),
        requestId: RuntimeRequestId.make(`request-${kind}`),
        permissionRequest,
      };

      expect(
        makeAcpRequestOpenedEvent({
          ...request,
          detail: kind,
          args: {},
          source: "acp.jsonrpc",
          method: "session/request_permission",
          rawPayload: { sessionId: "session-1" },
        }),
      ).toMatchObject({
        type: "request.opened",
        payload: { requestType: "dynamic_tool_call" },
      });

      expect(
        makeAcpRequestResolvedEvent({
          ...request,
          decision: "accept",
        }),
      ).toMatchObject({
        type: "request.resolved",
        payload: { requestType: "dynamic_tool_call" },
      });
    }
  });

  it("maps ACP core plan, tool-call, and content updates", () => {
    const stamp = { eventId: "event-1" as never, createdAt: "2026-03-27T00:00:00.000Z" };
    const turnId = TurnId.make("turn-1");

    expect(
      makeAcpPlanUpdatedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        payload: {
          plan: [{ step: "Inspect state", status: "inProgress" }],
        },
        source: "acp.cursor.extension",
        method: "cursor/update_todos",
        rawPayload: { todos: [] },
      }),
    ).toMatchObject({
      type: "turn.plan.updated",
      raw: {
        method: "cursor/update_todos",
      },
    });

    expect(
      makeAcpToolCallEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        toolCall: {
          toolCallId: "tool-1",
          kind: "execute",
          status: "completed",
          title: "Terminal",
          detail: "bun run test",
          data: { command: "bun run test" },
        },
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "command_execution",
        status: "completed",
      },
    });

    expect(
      makeAcpContentDeltaEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        itemId: "assistant:session-1:segment:0",
        streamKind: "assistant_text",
        text: "hello",
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "content.delta",
      itemId: "assistant:session-1:segment:0",
      payload: {
        delta: "hello",
      },
    });

    expect(
      makeAcpAssistantItemEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        itemId: "assistant:session-1:segment:0",
        lifecycle: "item.started",
      }),
    ).toMatchObject({
      type: "item.started",
      itemId: "assistant:session-1:segment:0",
      payload: {
        itemType: "assistant_message",
        status: "inProgress",
      },
    });
  });
});
