import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@codework/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, vi } from "vite-plus/test";

import type { ControlClientOpen } from "./controlClient.ts";
import { getAgentStatus } from "./agentControlRpc.ts";
import { formatAgentStatus } from "./agentControlOutput.ts";
import { deriveAgentStatus, type AgentStatusSnapshot } from "./agentControlState.ts";

const thread: OrchestrationThread = {
  id: ThreadId.make("thread-agent-1"),
  projectId: ProjectId.make("project-1"),
  title: "修复 CLI",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "codex/cli-agent-controls",
  worktreePath: "C:/repo",
  latestTurn: {
    turnId: TurnId.make("turn-1"),
    state: "running",
    requestedAt: "2026-08-30T00:00:00.000Z",
    startedAt: "2026-08-30T00:00:01.000Z",
    completedAt: null,
    assistantMessageId: null,
  },
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:01.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: {
    threadId: ThreadId.make("thread-agent-1"),
    status: "running",
    providerName: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access",
    activeTurnId: TurnId.make("turn-1"),
    lastError: null,
    updatedAt: "2026-08-30T00:00:01.000Z",
  },
};

describe("Agent status CLI", () => {
  it.effect("通过只读 Thread 订阅读取明确 Agent ID 的权威快照", () =>
    Effect.gen(function* () {
      const subscribe = vi.fn(() =>
        Stream.fromIterable([
          {
            kind: "snapshot" as const,
            snapshot: { snapshotSequence: 7, thread },
          },
          { kind: "synchronized" as const },
        ]),
      );
      const connections: Array<Parameters<ControlClientOpen>[0]> = [];
      const open: ControlClientOpen = (connection, use) => {
        connections.push(connection);
        return use({ "orchestration.subscribeThread": subscribe } as never);
      };

      const result = yield* getAgentStatus(
        {
          serverUrl: "https://codework.example.test",
          accessToken: "session-token",
          agentId: "thread-agent-1",
        },
        open,
      );

      expect(result).toMatchObject({
        agentId: "thread-agent-1",
        projectId: "project-1",
        status: "running",
        activeTurnId: "turn-1",
      });
      expect(connections).toEqual([
        {
          serverUrl: "https://codework.example.test",
          accessToken: "session-token",
        },
      ]);
      expect(subscribe).toHaveBeenCalledWith({
        threadId: "thread-agent-1",
        requestCompletionMarker: true,
      });
    }),
  );

  it("纯状态映射优先识别归档和终态，不依赖 CLI 副作用", () => {
    expect(deriveAgentStatus(thread)).toBe("running");
    expect(
      deriveAgentStatus({
        ...thread,
        archivedAt: "2026-08-30T00:10:00.000Z",
      }),
    ).toBe("archived");
    expect(
      deriveAgentStatus({
        ...thread,
        latestTurn: { ...thread.latestTurn!, state: "error" },
        session: { ...thread.session!, status: "error", lastError: "provider failed" },
      }),
    ).toBe("failed");
  });

  it("文本输出可读，JSON 输出保留稳定结构", () => {
    const status = {
      agentId: "thread-agent-1",
      projectId: "project-1",
      title: "修复 CLI",
      status: "running" as const,
      sessionStatus: "running" as const,
      activeTurnId: "turn-1",
      latestTurnId: "turn-1",
      latestTurnState: "running" as const,
      providerInstanceId: "codex",
      model: "gpt-5.6",
      archivedAt: null,
      updatedAt: "2026-08-30T00:00:01.000Z",
    };

    expect(formatAgentStatus(status, true)).toBe(JSON.stringify(status, null, 2));
    expect(formatAgentStatus(status, false)).toContain("Agent: thread-agent-1");
    expect(formatAgentStatus(status, false)).toContain("Status: running");
    expect(formatAgentStatus(status, false)).toContain("Active turn: turn-1");
  });

  it("文本输出清理全部字符串字段中的 ANSI、C0 和 C1，JSON 保留原值", () => {
    const status = {
      agentId: "\u001b[31mthread-agent-1\u001b[0m",
      projectId: "project\u0000-1",
      title: "修复\u0085 CLI",
      status: "run\u0007ning" as AgentStatusSnapshot["status"],
      sessionStatus: "\u001b[2mrunning\u001b[0m" as AgentStatusSnapshot["sessionStatus"],
      activeTurnId: "turn\u009b-1",
      latestTurnId: "turn\u0001-1",
      latestTurnState: "run\u001fning" as AgentStatusSnapshot["latestTurnState"],
      providerInstanceId: "\u001b[36mcodex\u001b[0m",
      model: "gpt-\u009f5.6",
      archivedAt: "2026-08-30T00:00:00.000Z\u0000",
      updatedAt: "\u001b[33m2026-08-30T00:00:01.000Z\u001b[0m",
    } satisfies AgentStatusSnapshot;

    expect(formatAgentStatus(status, false)).toBe(
      [
        "Agent: thread-agent-1",
        "Project: project-1",
        "Title: 修复 CLI",
        "Status: running",
        "Session: running",
        "Active turn: turn-1",
        "Latest turn: turn-1",
        "Latest turn state: running",
        "Provider: codex",
        "Model: gpt-5.6",
        "Archived at: 2026-08-30T00:00:00.000Z",
        "Updated at: 2026-08-30T00:00:01.000Z",
      ].join("\n"),
    );
    expect(JSON.parse(formatAgentStatus(status, true))).toEqual(status);
  });
});
