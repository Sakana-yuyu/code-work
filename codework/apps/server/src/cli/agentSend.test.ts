import { CommandId, MessageId, ORCHESTRATION_WS_METHODS, TurnId } from "@codework/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, vi } from "vite-plus/test";

import type { ControlClientOpen } from "./controlClient.ts";
import { makeAgentThread } from "./agentControl.testFixtures.ts";
import { formatAgentSendResult } from "./agentControlSendOutput.ts";
import { sendToAgent } from "./agentControlSendRpc.ts";
import { planAgentSendCommand } from "./agentControlSendState.ts";

const idleThread = makeAgentThread({
  latestTurn: {
    turnId: TurnId.make("turn-1"),
    state: "completed",
    requestedAt: "2026-08-30T00:00:00.000Z",
    startedAt: "2026-08-30T00:00:01.000Z",
    completedAt: "2026-08-30T00:01:00.000Z",
    assistantMessageId: MessageId.make("message-assistant-1"),
  },
  session: {
    threadId: makeAgentThread().id,
    status: "ready",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-08-30T00:01:00.000Z",
  },
});

describe("Agent send CLI", () => {
  it("纯规划拒绝归档或仍在运行的 Agent", () => {
    const identity = {
      commandId: CommandId.make("command-send-1"),
      messageId: MessageId.make("message-send-1"),
      createdAt: "2026-08-30T01:00:00.000Z",
    };

    expect(
      planAgentSendCommand(
        { ...idleThread, archivedAt: "2026-08-30T00:30:00.000Z" },
        "继续处理",
        identity,
      ),
    ).toMatchObject({ ok: false, reason: "archived" });
    expect(planAgentSendCommand(makeAgentThread(), "继续处理", identity)).toMatchObject({
      ok: false,
      reason: "busy",
    });
    expect(planAgentSendCommand(idleThread, "   ", identity)).toMatchObject({
      ok: false,
      reason: "invalid-prompt",
    });
  });

  it.effect("读取权威快照后 dispatch 新 turn，并返回结构化 receipt", () =>
    Effect.gen(function* () {
      const dispatch = vi.fn(() => Effect.succeed({ sequence: 42 }));
      const connections: Array<Parameters<ControlClientOpen>[0]> = [];
      const open: ControlClientOpen = (connection, use) => {
        connections.push(connection);
        return use({
          [ORCHESTRATION_WS_METHODS.subscribeThread]: () =>
            Stream.fromIterable([
              {
                kind: "snapshot" as const,
                snapshot: { snapshotSequence: 8, thread: idleThread },
              },
            ]),
          [ORCHESTRATION_WS_METHODS.dispatchCommand]: dispatch,
        } as never);
      };

      const result = yield* sendToAgent(
        {
          serverUrl: "https://codework.example.test",
          accessToken: "session-token",
          agentId: "thread-agent-1",
          prompt: "继续处理",
        },
        open,
        () =>
          Effect.succeed({
            commandId: CommandId.make("command-send-1"),
            messageId: MessageId.make("message-send-1"),
            createdAt: "2026-08-30T01:00:00.000Z",
          }),
      );

      expect(dispatch).toHaveBeenCalledWith({
        type: "thread.turn.start",
        commandId: "command-send-1",
        threadId: "thread-agent-1",
        message: {
          messageId: "message-send-1",
          role: "user",
          text: "继续处理",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-08-30T01:00:00.000Z",
      });
      expect(result).toEqual({
        agentId: "thread-agent-1",
        commandId: "command-send-1",
        messageId: "message-send-1",
        sequence: 42,
        createdAt: "2026-08-30T01:00:00.000Z",
      });
      expect(connections).toEqual([
        { serverUrl: "https://codework.example.test", accessToken: "session-token" },
      ]);
    }),
  );

  it("文本和 JSON 输出都保留可追踪标识", () => {
    const result = {
      agentId: "thread-agent-1",
      commandId: "command-send-1",
      messageId: "message-send-1",
      sequence: 42,
      createdAt: "2026-08-30T01:00:00.000Z",
    };

    expect(formatAgentSendResult(result, false)).toContain("Command: command-send-1");
    expect(formatAgentSendResult(result, true)).toBe(JSON.stringify(result, null, 2));
  });
});
