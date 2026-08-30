import { CommandId, ORCHESTRATION_WS_METHODS } from "@codework/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, vi } from "vite-plus/test";

import type { ControlClientOpen } from "./controlClient.ts";
import { makeAgentThread } from "./agentControl.testFixtures.ts";
import { formatAgentArchiveResult } from "./agentControlArchiveOutput.ts";
import { archiveAgent, unarchiveAgent } from "./agentControlArchiveRpc.ts";
import { planAgentArchiveCommand, planAgentUnarchiveCommand } from "./agentControlArchiveState.ts";

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

  it("纯规划拒绝取消归档仍在活跃列表中的 Agent", () => {
    expect(
      planAgentUnarchiveCommand(makeAgentThread(), CommandId.make("command-unarchive-1")),
    ).toMatchObject({ ok: false, reason: "not-archived" });
  });

  it.effect("读取已归档快照后 dispatch thread.unarchive 并返回 receipt", () =>
    Effect.gen(function* () {
      const dispatch = vi.fn(() => Effect.succeed({ sequence: 52 }));
      const open: ControlClientOpen = (_connection, use) =>
        use({
          [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: () =>
            Effect.succeed({
              snapshotSequence: 13,
              projects: [],
              threads: [makeAgentThread({ archivedAt: "2026-08-30T01:00:00.000Z" })],
              updatedAt: "2026-08-30T01:00:00.000Z",
            }),
          [ORCHESTRATION_WS_METHODS.dispatchCommand]: dispatch,
        } as never);

      const result = yield* unarchiveAgent(
        { serverUrl: "http://127.0.0.1:3773", agentId: "thread-agent-1" },
        open,
        () => CommandId.make("command-unarchive-1"),
      );

      expect(dispatch).toHaveBeenCalledWith({
        type: "thread.unarchive",
        commandId: "command-unarchive-1",
        threadId: "thread-agent-1",
      });
      expect(result).toEqual({
        agentId: "thread-agent-1",
        commandId: "command-unarchive-1",
        sequence: 52,
      });
    }),
  );

  it.effect("归档快照没有目标时返回 not-archived 且不派发命令", () =>
    Effect.gen(function* () {
      const dispatch = vi.fn(() => Effect.succeed({ sequence: 52 }));
      const open: ControlClientOpen = (_connection, use) =>
        use({
          [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: () =>
            Effect.succeed({
              snapshotSequence: 13,
              projects: [],
              threads: [],
              updatedAt: "2026-08-30T01:00:00.000Z",
            }),
          [ORCHESTRATION_WS_METHODS.dispatchCommand]: dispatch,
        } as never);

      const error = yield* unarchiveAgent(
        { serverUrl: "http://127.0.0.1:3773", agentId: "thread-agent-1" },
        open,
        () => CommandId.make("command-unarchive-1"),
      ).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "AgentUnarchiveRejectedError",
        agentId: "thread-agent-1",
        reason: "not-archived",
      });
      expect(dispatch).not.toHaveBeenCalled();
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
