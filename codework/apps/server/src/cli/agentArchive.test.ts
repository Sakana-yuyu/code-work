import { CommandId, ORCHESTRATION_WS_METHODS } from "@codework/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, vi } from "vite-plus/test";

import type { ControlClientOpen } from "./controlClient.ts";
import { makeAgentThread } from "./agentControl.testFixtures.ts";
import { formatAgentArchiveResult } from "./agentControlArchiveOutput.ts";
import { archiveAgent } from "./agentControlArchiveRpc.ts";
import { planAgentArchiveCommand } from "./agentControlArchiveState.ts";

describe("Agent archive CLI", () => {
  it("纯规划对已归档 Agent 返回稳定错误语义", () => {
    expect(
      planAgentArchiveCommand(
        makeAgentThread({ archivedAt: "2026-08-30T01:00:00.000Z" }),
        CommandId.make("command-archive-1"),
      ),
    ).toMatchObject({ ok: false, reason: "already-archived" });
  });

  it.effect("读取快照后 dispatch thread.archive 并返回 receipt", () =>
    Effect.gen(function* () {
      const dispatch = vi.fn(() => Effect.succeed({ sequence: 51 }));
      const open: ControlClientOpen = (_connection, use) =>
        use({
          [ORCHESTRATION_WS_METHODS.subscribeThread]: () =>
            Stream.fromIterable([
              {
                kind: "snapshot" as const,
                snapshot: { snapshotSequence: 12, thread: makeAgentThread() },
              },
            ]),
          [ORCHESTRATION_WS_METHODS.dispatchCommand]: dispatch,
        } as never);

      const result = yield* archiveAgent(
        { serverUrl: "http://127.0.0.1:3773", agentId: "thread-agent-1" },
        open,
        () => CommandId.make("command-archive-1"),
      );

      expect(dispatch).toHaveBeenCalledWith({
        type: "thread.archive",
        commandId: "command-archive-1",
        threadId: "thread-agent-1",
      });
      expect(result).toEqual({
        agentId: "thread-agent-1",
        commandId: "command-archive-1",
        sequence: 51,
      });
    }),
  );

  it("文本和 JSON 输出保留 receipt", () => {
    const result = {
      agentId: "thread-agent-1",
      commandId: "command-archive-1",
      sequence: 51,
    };

    expect(formatAgentArchiveResult(result, false)).toContain("Sequence: 51");
    expect(formatAgentArchiveResult(result, true)).toBe(JSON.stringify(result, null, 2));
  });
});
