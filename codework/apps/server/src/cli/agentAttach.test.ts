import { EventId, MessageId, ThreadId, TurnId } from "@codework/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import type { ControlClientOpen } from "./controlClient.ts";
import { makeAgentThread } from "./agentControl.testFixtures.ts";
import { initialAgentAttachState, reduceAgentAttachState } from "./agentControlAttachState.ts";
import { formatAgentAttachFrame } from "./agentControlAttachOutput.ts";
import { attachToAgent } from "./agentControlAttachRpc.ts";

const messageDeltaEvent = {
  eventId: EventId.make("event-message-delta"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  sequence: 9,
  occurredAt: "2026-08-30T00:01:00.000Z",
  aggregateKind: "thread" as const,
  aggregateId: ThreadId.make("thread-agent-1"),
  type: "thread.message-sent" as const,
  payload: {
    threadId: ThreadId.make("thread-agent-1"),
    messageId: MessageId.make("message-assistant-1"),
    role: "assistant" as const,
    text: "，已完成",
    turnId: TurnId.make("turn-1"),
    streaming: true,
    createdAt: "2026-08-30T00:00:01.000Z",
    updatedAt: "2026-08-30T00:01:00.000Z",
  },
};

const completionEvent = {
  eventId: EventId.make("event-session-ready"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  sequence: 10,
  occurredAt: "2026-08-30T00:01:01.000Z",
  aggregateKind: "thread" as const,
  aggregateId: ThreadId.make("thread-agent-1"),
  type: "thread.session-set" as const,
  payload: {
    threadId: ThreadId.make("thread-agent-1"),
    session: {
      threadId: ThreadId.make("thread-agent-1"),
      status: "ready" as const,
      providerName: "codex",
      runtimeMode: "full-access" as const,
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-08-30T00:01:01.000Z",
    },
  },
};

const makeCompletedAgentThread = () => {
  const thread = makeAgentThread();
  return {
    ...thread,
    latestTurn: {
      ...thread.latestTurn!,
      state: "completed" as const,
      completedAt: "2026-08-30T00:01:00.000Z",
    },
    session: {
      ...thread.session!,
      status: "ready" as const,
      activeTurnId: null,
      updatedAt: "2026-08-30T00:01:00.000Z",
    },
  };
};

const secondTurnStartedEvent = {
  eventId: EventId.make("event-second-turn-running"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  sequence: 11,
  occurredAt: "2026-08-30T00:02:00.000Z",
  aggregateKind: "thread" as const,
  aggregateId: ThreadId.make("thread-agent-1"),
  type: "thread.session-set" as const,
  payload: {
    threadId: ThreadId.make("thread-agent-1"),
    session: {
      threadId: ThreadId.make("thread-agent-1"),
      status: "running" as const,
      providerName: "codex",
      runtimeMode: "full-access" as const,
      activeTurnId: TurnId.make("turn-2"),
      lastError: null,
      updatedAt: "2026-08-30T00:02:00.000Z",
    },
  },
};

const secondTurnCompletedEvent = {
  eventId: EventId.make("event-second-turn-ready"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  sequence: 12,
  occurredAt: "2026-08-30T00:02:30.000Z",
  aggregateKind: "thread" as const,
  aggregateId: ThreadId.make("thread-agent-1"),
  type: "thread.session-set" as const,
  payload: {
    threadId: ThreadId.make("thread-agent-1"),
    session: {
      threadId: ThreadId.make("thread-agent-1"),
      status: "ready" as const,
      providerName: "codex",
      runtimeMode: "full-access" as const,
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-08-30T00:02:30.000Z",
    },
  },
};

describe("Agent attach CLI", () => {
  it("纯投影从快照输出消息，并把后续流式内容压缩为 append 帧", () => {
    const snapshot = reduceAgentAttachState(initialAgentAttachState, {
      kind: "snapshot",
      snapshot: { snapshotSequence: 8, thread: makeAgentThread() },
    });
    const delta = reduceAgentAttachState(snapshot.state, {
      kind: "event",
      event: messageDeltaEvent,
    });

    expect(snapshot.frames).toHaveLength(2);
    expect(snapshot.frames[0]).toMatchObject({
      kind: "message",
      change: "snapshot",
      messageId: "message-user-1",
      text: "检查 CLI",
    });
    expect(delta.frames).toEqual([
      expect.objectContaining({
        kind: "message",
        change: "append",
        messageId: "message-assistant-1",
        text: "，已完成",
        streaming: true,
      }),
    ]);
  });

  it("同步前不输出旧终态，并在补发的新 turn 完成后只输出一次终态", () => {
    const staleTerminal = reduceAgentAttachState(initialAgentAttachState, {
      kind: "snapshot",
      snapshot: { snapshotSequence: 10, thread: makeCompletedAgentThread() },
    });
    const runningSecondTurn = reduceAgentAttachState(staleTerminal.state, {
      kind: "event",
      event: secondTurnStartedEvent,
    });
    const synchronized = reduceAgentAttachState(runningSecondTurn.state, {
      kind: "synchronized",
    });
    const completedSecondTurn = reduceAgentAttachState(synchronized.state, {
      kind: "event",
      event: secondTurnCompletedEvent,
    });

    expect(staleTerminal.done).toBe(false);
    expect(staleTerminal.frames.some((frame) => frame.kind === "status")).toBe(false);
    expect(runningSecondTurn.state.stream.thread?.latestTurn?.turnId).toBe("turn-2");
    expect(synchronized.done).toBe(false);
    expect(completedSecondTurn.done).toBe(true);
    expect(completedSecondTurn.frames).toEqual([
      expect.objectContaining({
        kind: "status",
        status: "completed",
        snapshot: expect.objectContaining({ latestTurnId: "turn-2" }),
      }),
    ]);
  });

  it.effect("订阅持续输出消息帧，并在终态状态帧后结束", () =>
    Effect.gen(function* () {
      const connections: Array<Parameters<ControlClientOpen>[0]> = [];
      const open: ControlClientOpen = (connection, use) => {
        connections.push(connection);
        return use({
          "orchestration.subscribeThread": () =>
            Stream.fromIterable([
              {
                kind: "snapshot" as const,
                snapshot: { snapshotSequence: 8, thread: makeAgentThread() },
              },
              { kind: "synchronized" as const },
              { kind: "event" as const, event: messageDeltaEvent },
              { kind: "event" as const, event: completionEvent },
            ]),
        } as never);
      };
      const frames: Array<Parameters<typeof formatAgentAttachFrame>[0]> = [];

      yield* attachToAgent(
        {
          serverUrl: "https://codework.example.test",
          accessToken: "session-token",
          agentId: "thread-agent-1",
        },
        (frame) => Effect.sync(() => frames.push(frame)),
        open,
      );

      expect(frames.map((frame) => frame.kind)).toEqual([
        "message",
        "message",
        "message",
        "status",
      ]);
      expect(frames.at(-1)).toMatchObject({ kind: "status", status: "completed" });
      expect(connections).toEqual([
        { serverUrl: "https://codework.example.test", accessToken: "session-token" },
      ]);
    }),
  );

  it.effect("消费同步前补发的新 turn，并仅输出该 turn 的终态帧", () =>
    Effect.gen(function* () {
      const open: ControlClientOpen = (_connection, use) =>
        use({
          "orchestration.subscribeThread": () =>
            Stream.fromIterable([
              {
                kind: "snapshot" as const,
                snapshot: { snapshotSequence: 10, thread: makeCompletedAgentThread() },
              },
              { kind: "event" as const, event: secondTurnStartedEvent },
              { kind: "synchronized" as const },
              { kind: "event" as const, event: secondTurnCompletedEvent },
            ]),
        } as never);
      const frames: Array<Parameters<typeof formatAgentAttachFrame>[0]> = [];

      yield* attachToAgent(
        { serverUrl: "http://127.0.0.1:3773", agentId: "thread-agent-1" },
        (frame) => Effect.sync(() => frames.push(frame)),
        open,
      );

      const statusFrames = frames.filter((frame) => frame.kind === "status");
      expect(statusFrames).toHaveLength(1);
      expect(statusFrames[0]).toMatchObject({
        status: "completed",
        snapshot: { latestTurnId: "turn-2", latestTurnState: "completed" },
      });
    }),
  );

  it.effect("同步后仍没有 turn 时返回明确错误", () =>
    Effect.gen(function* () {
      const open: ControlClientOpen = (_connection, use) =>
        use({
          "orchestration.subscribeThread": () =>
            Stream.fromIterable([
              {
                kind: "snapshot" as const,
                snapshot: {
                  snapshotSequence: 1,
                  thread: makeAgentThread({ latestTurn: null, session: null, messages: [] }),
                },
              },
              { kind: "synchronized" as const },
            ]),
        } as never);

      const error = yield* Effect.flip(
        attachToAgent(
          { serverUrl: "http://127.0.0.1:3773", agentId: "thread-agent-1" },
          () => Effect.void,
          open,
        ),
      );

      expect(error).toMatchObject({
        _tag: "AgentAttachUnavailableError",
        agentId: "thread-agent-1",
        reason: "missing-turn",
      });
    }),
  );

  it("文本输出清除控制字符，JSON 输出保持单行结构", () => {
    const frame = {
      kind: "message" as const,
      change: "append" as const,
      agentId: "thread-agent-1",
      messageId: "message-assistant-1",
      role: "assistant" as const,
      turnId: "turn-1",
      text: "完成\u001b[31m失败点\u001b[0m\u0000",
      streaming: true,
      createdAt: "2026-08-30T00:00:01.000Z",
      updatedAt: "2026-08-30T00:01:00.000Z",
    };

    expect(formatAgentAttachFrame(frame, false)).toContain("完成失败点");
    expect(formatAgentAttachFrame(frame, false)).not.toContain("\u001b");
    expect(formatAgentAttachFrame(frame, true)).toBe(JSON.stringify(frame));
  });
});
