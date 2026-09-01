import { CommandId, MessageId, ORCHESTRATION_WS_METHODS, TurnId } from "@codework/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, vi } from "vite-plus/test";

import type { ControlClientOpen } from "./controlClient.ts";
import { makeAgentThread } from "./agentControl.testFixtures.ts";
import { formatAgentKillResult } from "./agentControlKillOutput.ts";
import { killAgent } from "./agentControlKillRpc.ts";
import { planAgentKillCommand } from "./agentControlKillState.ts";

const identity = {
  commandId: CommandId.make("command-kill-1"),
  createdAt: "2026-08-30T02:00:00.000Z",
};

describe("Agent kill CLI", () => {
  it("纯规划始终携带明确 active turnId，并拒绝空闲 Agent", () => {
    expect(planAgentKillCommand(makeAgentThread(), identity)).toMatchObject({
      ok: true,
      command: { type: "thread.turn.interrupt", turnId: "turn-1" },
    });
    expect(
      planAgentKillCommand(
        makeAgentThread({
          latestTurn: {
            turnId: TurnId.make("turn-1"),
            state: "completed",
            requestedAt: "2026-08-30T00:00:00.000Z",
            startedAt: "2026-08-30T00:00:01.000Z",
            completedAt: "2026-08-30T00:01:00.000Z",
            assistantMessageId: MessageId.make("message-assistant-1"),
          },
          session: null,
        }),
        identity,
      ),
    ).toMatchObject({ ok: false, reason: "no-active-turn" });
  });

  it.effect("读取快照后 dispatch 精确 turn interrupt 并返回 receipt", () =>
    Effect.gen(function* () {
      const dispatch = vi.fn(() => Effect.succeed({ sequence: 61 }));
      const open: ControlClientOpen = (_connection, use) =>
        use({
          [ORCHESTRATION_WS_METHODS.subscribeThread]: () =>
            Stream.fromIterable([
              {
                kind: "snapshot" as const,
                snapshot: { snapshotSequence: 18, thread: makeAgentThread() },
              },
            ]),
          [ORCHESTRATION_WS_METHODS.dispatchCommand]: dispatch,
        } as never);

      const result = yield* killAgent(
        { serverUrl: "http://127.0.0.1:3773", agentId: "thread-agent-1" },
        open,
        () => Effect.succeed(identity),
      );

      expect(dispatch).toHaveBeenCalledWith({
        type: "thread.turn.interrupt",
        commandId: "command-kill-1",
        threadId: "thread-agent-1",
        turnId: "turn-1",
        createdAt: "2026-08-30T02:00:00.000Z",
      });
      expect(result).toEqual({
        agentId: "thread-agent-1",
        turnId: "turn-1",
        commandId: "command-kill-1",
        sequence: 61,
        createdAt: "2026-08-30T02:00:00.000Z",
      });
    }),
  );

  it("文本和 JSON 输出保留被中断的 turn", () => {
    const result = {
      agentId: "thread-agent-1",
      turnId: "turn-1",
      commandId: "command-kill-1",
      sequence: 61,
      createdAt: "2026-08-30T02:00:00.000Z",
    };

    expect(formatAgentKillResult(result, false)).toContain("Turn: turn-1");
    expect(formatAgentKillResult(result, true)).toBe(JSON.stringify(result, null, 2));
  });
});
