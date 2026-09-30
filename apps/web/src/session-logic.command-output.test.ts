import { EventId, TurnId, type OrchestrationThreadActivity } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveWorkLogEntries, workLogEntryIsToolLike } from "./session-logic";
import { summarizeToolGroup, toolGroupAction } from "./components/chat/MessagesTimeline.logic";

function makeCommandActivity(
  id: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    createdAt: "2026-07-17T10:00:00.000Z",
    kind: "tool.completed",
    summary: "Ran command",
    tone: "tool",
    payload,
    turnId: TurnId.make("turn-1"),
  };
}

describe("deriveWorkLogEntries command output", () => {
  it("ACP 输出不是缺失的命令，完整详情只保留在输出字段", () => {
    const detail = "terminal result\n- **exit_code:** 7";
    const [entry] = deriveWorkLogEntries([
      makeCommandActivity("hermes-command", {
        itemType: "command_execution",
        status: "failed",
        detail,
        data: { kind: "execute", rawOutput: { content: "terminal result" } },
      }),
    ]);
    expect(entry?.command).toBeUndefined();
    expect(entry?.rawCommand).toBeUndefined();
    expect(entry?.detail).toBe(detail);
    expect(entry?.toolLifecycleStatus).toBe("failed");
  });
  it("审批不计为工具，同一调用跨审批更新仍合并且保留失败输出", () => {
    const events = [
      {
        kind: "tool.updated",
        payload: { toolCallId: "read", itemType: "dynamic_tool_call", status: "inProgress" },
      },
      {
        kind: "approval.requested",
        payload: { requestKind: "file-read", detail: "/tmp/source.txt" },
      },
      { kind: "approval.resolved", payload: { requestKind: "file-read", decision: "accept" } },
      {
        kind: "tool.updated",
        payload: { toolCallId: "read", itemType: "dynamic_tool_call", status: "inProgress" },
      },
      {
        kind: "tool.completed",
        payload: {
          toolCallId: "read",
          itemType: "dynamic_tool_call",
          status: "completed",
          detail: "SOURCE_CONTENT",
        },
      },
      {
        kind: "tool.updated",
        payload: {
          toolCallId: "command",
          itemType: "command_execution",
          status: "inProgress",
          data: { command: "exit 7" },
        },
      },
      { kind: "approval.requested", payload: { requestKind: "command", detail: "exit 7" } },
      { kind: "approval.resolved", payload: { requestKind: "command", decision: "accept" } },
      {
        kind: "tool.completed",
        payload: {
          toolCallId: "command",
          itemType: "command_execution",
          status: "failed",
          detail: "Command exited with code 7",
          data: { command: "exit 7" },
        },
      },
    ];
    const activities = events.map(({ kind, payload }, index) => ({
      ...makeCommandActivity(`event-${index}`, payload),
      kind,
      summary: payload.toolCallId === "read" ? "Read file" : kind,
      tone: kind.startsWith("approval.") ? ("approval" as const) : ("tool" as const),
      createdAt: new Date(Date.UTC(2026, 8, 30, 0, 0, index)).toISOString(),
    }));
    const live = deriveWorkLogEntries(activities.slice(0, 4));
    expect(live.filter(workLogEntryIsToolLike)).toHaveLength(1);
    expect(live.find(workLogEntryIsToolLike)?.toolLifecycleStatus).toBe("inProgress");
    const entries = deriveWorkLogEntries(activities);
    const tools = entries.filter(workLogEntryIsToolLike);
    expect(entries).toHaveLength(6);
    expect(tools).toHaveLength(2);
    expect(toolGroupAction(tools[0]!)).toBe("read");
    expect(tools[1]).toMatchObject({
      toolLifecycleStatus: "failed",
      detail: "Command exited with code 7",
    });
    expect(summarizeToolGroup(entries)).toBe(summarizeToolGroup(tools));
    expect(entries.filter((entry) => !workLogEntryIsToolLike(entry))).toHaveLength(4);
  });
  it("ACP search 是本地代码搜索，fetch 仍归为网络检索", () => {
    const entries = deriveWorkLogEntries([
      makeCommandActivity("acp-search", {
        toolCallId: "search",
        itemType: "web_search",
        title: "Find `*.ts`",
        status: "completed",
        data: { toolCallId: "search", kind: "search" },
      }),
      makeCommandActivity("acp-fetch", {
        toolCallId: "fetch",
        itemType: "web_search",
        title: "Fetch https://example.com",
        status: "completed",
        data: { toolCallId: "fetch", kind: "fetch" },
      }),
    ]);
    const actions = Object.fromEntries(
      entries.map((entry) => [entry.toolCallId, toolGroupAction(entry)]),
    );
    expect(actions).toEqual({ search: "code-search", fetch: "search" });
  });

  it("ACP search 状态更新不带 kind 时沿用首条记录的分类", () => {
    const [entry] = deriveWorkLogEntries([
      {
        ...makeCommandActivity("acp-search-start", {
          toolCallId: "search",
          itemType: "web_search",
          title: "Search files",
          status: "inProgress",
          data: { toolCallId: "search", kind: "search" },
        }),
        kind: "tool.updated",
      },
      {
        ...makeCommandActivity("acp-search-done", {
          toolCallId: "search",
          itemType: "web_search",
          status: "completed",
        }),
        createdAt: "2026-07-17T10:00:01.000Z",
      },
    ]);
    expect(entry && toolGroupAction(entry)).toBe("code-search");
  });

  it("Cline 批量命令显示规范化输出和失败状态", () => {
    const [entry] = deriveWorkLogEntries([
      makeCommandActivity("cline-batch", {
        itemType: "command_execution",
        title: "Ran command",
        status: "failed",
        detail: "echo OK\nOK\n\nexit 7\nExit code: 7",
        data: { command: "echo OK\nexit 7" },
      }),
    ]);
    expect(entry).toMatchObject({
      command: "echo OK\nexit 7",
      detail: "echo OK\nOK\n\nexit 7\nExit code: 7",
      toolLifecycleStatus: "failed",
    });
  });
  it("uses Codex aggregated output instead of repeating the command", () => {
    const [entry] = deriveWorkLogEntries([
      makeCommandActivity("codex-command", {
        itemType: "command_execution",
        title: "Ran command",
        detail: "/bin/zsh -lc \"printf 'hello\\n'\"",
        data: {
          item: {
            type: "commandExecution",
            command: "/bin/zsh -lc \"printf 'hello\\n'\"",
            commandActions: [{ command: "printf 'hello\\n'", type: "unknown" }],
            aggregatedOutput: "hello\n<exited with exit code 0>",
            status: "completed",
          },
        },
      }),
    ]);

    expect(entry).toMatchObject({
      command: "printf 'hello\\n'",
      rawCommand: "/bin/zsh -lc \"printf 'hello\\n'\"",
      detail: "hello",
    });
  });

  it("uses a projected Claude output summary instead of repeating the command", () => {
    const [entry] = deriveWorkLogEntries([
      makeCommandActivity("claude-command", {
        itemType: "command_execution",
        title: "Ran command",
        detail: "printf hello",
        data: {
          kind: "execute",
          command: "printf hello",
          rawOutput: {
            content: "hello from claude",
          },
        },
      }),
    ]);

    expect(entry).toMatchObject({
      command: "printf hello",
      detail: "hello from claude",
    });
  });

  it("drops duplicated command detail when the command has no output", () => {
    const [entry] = deriveWorkLogEntries([
      makeCommandActivity("empty-command", {
        itemType: "command_execution",
        title: "Ran command",
        detail: "true",
        data: {
          kind: "execute",
          command: "true",
        },
      }),
    ]);

    expect(entry?.command).toBe("true");
    expect(entry?.detail).toBeUndefined();
  });
});
