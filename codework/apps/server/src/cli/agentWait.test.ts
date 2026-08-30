import { EventId, ThreadId } from "@codework/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, vi } from "vite-plus/test";

import type { ControlClientOpen } from "./controlClient.ts";
import { makeAgentThread } from "./agentControl.testFixtures.ts";
import {
  initialAgentStreamState,
  isAgentWaitComplete,
  reduceAgentStreamState,
} from "./agentControlStreamState.ts";
import { waitForAgent } from "./agentControlRpc.ts";

const completionEvent = {
  eventId: EventId.make("event-session-ready"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  sequence: 9,
  occurredAt: "2026-08-30T00:01:00.000Z",
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
      updatedAt: "2026-08-30T00:01:00.000Z",
    },
  },
};

describe("Agent wait CLI", () => {
  it("纯状态机从快照和事件推导完成状态", () => {
    const running = reduceAgentStreamState(initialAgentStreamState, {
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 8,
        thread: makeAgentThread(),
      },
    });
    const completed = reduceAgentStreamState(running, {
      kind: "event",
      event: completionEvent,
    });

    expect(running.thread?.latestTurn?.state).toBe("running");
    expect(completed.thread?.latestTurn?.state).toBe("completed");
    expect(isAgentWaitComplete(completed)).toBe(true);
  });

  it.effect("等待事件流到达终态后返回结构化状态", () =>
    Effect.gen(function* () {
      const subscribe = vi.fn(() =>
        Stream.fromIterable([
          {
            kind: "snapshot" as const,
            snapshot: { snapshotSequence: 8, thread: makeAgentThread() },
          },
          { kind: "synchronized" as const },
          { kind: "event" as const, event: completionEvent },
        ]),
      );
      const open: ControlClientOpen = (_connection, use) =>
        use({ "orchestration.subscribeThread": subscribe } as never);

      const result = yield* waitForAgent(
        {
          serverUrl: "http://127.0.0.1:3773",
          agentId: "thread-agent-1",
        },
        open,
      );

      expect(result).toMatchObject({
        agentId: "thread-agent-1",
        status: "completed",
        latestTurnId: "turn-1",
        latestTurnState: "completed",
      });
      expect(subscribe).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("没有当前或历史 turn 时返回明确错误而不是永久等待", () =>
    Effect.gen(function* () {
      const idleThread = makeAgentThread({ latestTurn: null, session: null });
      const open: ControlClientOpen = (_connection, use) =>
        use({
          "orchestration.subscribeThread": () =>
            Stream.fromIterable([
              {
                kind: "snapshot" as const,
                snapshot: { snapshotSequence: 1, thread: idleThread },
              },
              { kind: "synchronized" as const },
            ]),
        } as never);

      const error = yield* Effect.flip(
        waitForAgent(
          {
            serverUrl: "http://127.0.0.1:3773",
            agentId: "thread-agent-1",
          },
          open,
        ),
      );

      expect(error).toMatchObject({
        _tag: "AgentWaitUnavailableError",
        agentId: "thread-agent-1",
      });
    }),
  );

  it.effect("超过 timeout-seconds 时返回结构化超时错误", () =>
    Effect.gen(function* () {
      const open: ControlClientOpen = (_connection, use) =>
        use({
          "orchestration.subscribeThread": () => Stream.never,
        } as never);
      const waiting = yield* Effect.forkChild(
        waitForAgent(
          {
            serverUrl: "http://127.0.0.1:3773",
            agentId: "thread-agent-1",
            timeoutSeconds: 2,
          },
          open,
        ),
      );

      yield* TestClock.adjust("2 seconds");
      const error = yield* Fiber.join(waiting).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "AgentWaitTimeoutError",
        agentId: "thread-agent-1",
        timeoutSeconds: 2,
      });
    }),
  );
});
