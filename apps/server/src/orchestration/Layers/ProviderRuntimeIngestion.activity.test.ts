import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";
import { projectActivityPayload } from "../ActivityPayloadProjection.ts";

const base = {
  provider: ProviderDriverKind.make("codex"),
  createdAt: "2026-08-06T00:00:00.000Z",
  threadId: ThreadId.make("thread-1"),
};

describe("runtimeEventToActivities reasoning summaries", () => {
  it("异常会话退出保留关闭失败说明，普通退出保持安静", () => {
    const event = {
      ...base,
      type: "session.exited",
      eventId: EventId.make("close-failed"),
      payload: {
        exitKind: "error",
        reason: "ACP 会话关闭未确认，已释放本地连接。",
        recoverable: true,
      },
    } as const;
    expect(runtimeEventToActivities(event)).toMatchObject([
      {
        tone: "error",
        kind: "session.exited",
        summary: event.payload.reason,
        payload: { exitKind: "error", recoverable: true },
      },
    ]);
    expect(runtimeEventToActivities({ ...event, payload: { exitKind: "graceful" } })).toEqual([]);
    expect(runtimeEventToActivities({ ...event, payload: {} })).toEqual([]);
  });
  it("模型和命令在同一启动事件中投影为不同 ID，空目录和 null 原样保留", () => {
    const activities = runtimeEventToActivities({
      ...base,
      eventId: EventId.make("start"),
      type: "session.started",
      providerInstanceId: ProviderInstanceId.make("acp-a"),
      payload: { slashCommands: [], models: [] },
    });
    expect(activities.map((activity) => activity.id)).toEqual(["start", "start:models"]);
    expect(activities[1]?.payload).toEqual({ providerInstanceId: "acp-a", models: [] });
    expect(
      runtimeEventToActivities({
        ...base,
        eventId: EventId.make("reset"),
        type: "session.started",
        payload: { models: null },
      })[0]?.payload,
    ).toEqual({ providerInstanceId: "codex", models: null });
  });
  it("会话启动命令快照按实例投影，空数组撤回而缺省保持旧协议兼容", () => {
    const event = {
      ...base,
      type: "session.started",
      eventId: EventId.make("commands-start"),
      providerInstanceId: ProviderInstanceId.make("custom-acp"),
      payload: { slashCommands: [] },
    } as const;
    expect(runtimeEventToActivities(event)).toMatchObject([
      {
        kind: "session.commands.updated",
        turnId: null,
        payload: { providerInstanceId: "custom-acp", commands: [] },
      },
    ]);
    expect(runtimeEventToActivities({ ...event, payload: {} })).toEqual([]);
  });
  it("persists provider reasoning summaries but ignores raw reasoning text", () => {
    const summary = runtimeEventToActivities({
      ...base,
      type: "content.delta",
      eventId: EventId.make("evt-reasoning-summary"),
      turnId: TurnId.make("turn-1"),
      payload: {
        streamKind: "reasoning_summary_text",
        summaryIndex: 0,
        delta: "先检查现有实现。",
      },
    });
    const rawReasoning = runtimeEventToActivities({
      ...base,
      type: "content.delta",
      eventId: EventId.make("evt-reasoning-raw"),
      turnId: TurnId.make("turn-1"),
      payload: {
        streamKind: "reasoning_text",
        delta: "内部逐步推理不应展示。",
      },
    });

    expect(summary).toMatchObject([
      {
        tone: "info",
        kind: "reasoning.summary.delta",
        payload: { delta: "先检查现有实现。", summaryIndex: 0 },
      },
    ]);
    expect(rawReasoning).toEqual([]);
  });
});

describe("runtimeEventToActivities task progress", () => {
  it("persists usage independently from replaceable activity", () => {
    const taskId = RuntimeTaskId.make("agent-1");
    const usageOnly = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-usage"),
      payload: {
        taskId,
        description: "Agent one",
        typedUsage: { totalTokens: 73_700_000 },
      },
    } satisfies ProviderRuntimeEvent;
    const command = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-command"),
      payload: {
        taskId,
        description: "Agent one",
        summary: "Running tests",
        lastToolName: "exec_command",
      },
    } satisfies ProviderRuntimeEvent;

    const usageActivities = runtimeEventToActivities(usageOnly);
    const commandActivities = runtimeEventToActivities(command);

    expect(usageActivities.map((activity) => activity.id)).toEqual(["task-usage:thread-1:agent-1"]);
    expect(commandActivities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-1",
    ]);
    const usagePayload = usageActivities[0]?.payload as Record<string, unknown> | undefined;
    expect(usagePayload?.typedUsage).toEqual({ totalTokens: 73_700_000 });
    expect(usagePayload?.usageSnapshot).toBe(true);
  });

  it("splits combined progress and usage into their independent snapshots", () => {
    const event = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-combined"),
      payload: {
        taskId: RuntimeTaskId.make("agent-2"),
        description: "Agent two",
        summary: "Inspecting the panel",
        typedUsage: { totalTokens: 4_200, toolUses: 7 },
        status: "running",
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);
    const progressPayload = activities[0]?.payload as Record<string, unknown>;
    const usagePayload = activities[1]?.payload as Record<string, unknown>;

    expect(activities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-2",
      "task-usage:thread-1:agent-2",
    ]);
    expect(progressPayload.summary).toBe("Inspecting the panel");
    expect(progressPayload.status).toBe("running");
    expect(progressPayload).not.toHaveProperty("typedUsage");
    expect(usagePayload.typedUsage).toEqual({ totalTokens: 4_200, toolUses: 7 });
    expect(usagePayload.usageSnapshot).toBe(true);
    expect(usagePayload).not.toHaveProperty("status");
  });
});
describe("runtimeEventToActivities tool streaming persistence", () => {
  it("终态完整详情通过实时和历史共用投影，长输出仍有上限", () => {
    for (const detail of [`${"文件保护说明。".repeat(60)}文件未修改。`, "x".repeat(9_000)]) {
      const [activity] = runtimeEventToActivities({
        ...base,
        type: "item.completed",
        eventId: EventId.make("hermes-full-detail"),
        payload: { itemType: "file_change", status: "failed", detail, data: { kind: "edit" } },
      });
      expect(activity?.payload).toMatchObject({
        detail: detail.length > 8_000 ? `${detail.slice(0, 7_997)}...` : detail,
        status: "failed",
      });
      expect(projectActivityPayload(activity!).payload).toEqual(activity?.payload);
    }
  });
  const accumulatedStdout = [
    "first line of output",
    ...Array.from({ length: 500 }, (_, index) => `Capturing frame ${index}/9028`),
  ].join("\n");
  const streamingData = {
    toolCallId: "tool-call-1",
    kind: "execute",
    command: "blender --render",
    rawOutput: { stdout: accumulatedStdout },
    content: [{ type: "content", content: { type: "text", text: accumulatedStdout } }],
  };

  it("persists tool.updated with the wire projection of data, not the accumulated stream", () => {
    const event = {
      ...base,
      type: "item.updated",
      eventId: EventId.make("evt-tool-streaming-updated"),
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Render",
        detail: accumulatedStdout,
        data: streamingData,
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);

    expect(activities).toHaveLength(1);
    const payload = activities[0]?.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    expect(payload.status).toBe("inProgress");
    expect(data.toolCallId).toBe("tool-call-1");
    expect(data.command).toBe("blender --render");
    expect(data.rawOutput).toEqual({ content: "first line of output" });
    expect(data.content).toBeUndefined();
    expect(JSON.stringify(data).length).toBeLessThan(1_000);
  });

  it("persists the full terminal payload on tool.completed", () => {
    const event = {
      ...base,
      type: "item.completed",
      eventId: EventId.make("evt-tool-streaming-completed"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Render",
        data: streamingData,
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);

    expect(activities).toHaveLength(1);
    const payload = activities[0]?.payload as Record<string, unknown>;
    expect(payload.data).toEqual(streamingData);
  });
});
