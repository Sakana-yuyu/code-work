import type { CompositionSquadListResult } from "@codework/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, vi } from "vite-plus/test";

import type { ControlClientOpen } from "./controlClient.ts";
import { formatSquadList, listSquads } from "./squad.ts";

const result: CompositionSquadListResult = {
  squads: [
    {
      squadId: "squad-build",
      name: "Build squad",
      leaderAgentId: "agent-lead",
      memberAgentIds: ["agent-lead", "agent-build"],
      instructions: "Build and review",
      createdAtUnixMs: 1_000,
      updatedAtUnixMs: 2_000,
      revision: 3,
      collaborationMode: "review_critic",
      maxConcurrency: 2,
      maxRetries: 1,
      failurePolicy: "continue_independent",
      partialSuccessPolicy: "require_review",
      approvalStages: ["before_finalize"],
      members: [
        {
          agentId: "agent-lead",
          role: "leader",
          order: 0,
          required: true,
          capabilityIds: ["fs.read"],
          maxConcurrentTasks: 1,
        },
        {
          agentId: "agent-build",
          role: "worker",
          order: 1,
          required: true,
          capabilityIds: ["fs.read", "fs.write"],
          maxConcurrentTasks: 1,
        },
      ],
    },
  ],
};

describe("Squad CLI", () => {
  it.effect("通过 typed RPC 查询 Squad，并透传归档过滤", () =>
    Effect.gen(function* () {
      const rpc = vi.fn(() => Effect.succeed(result));
      const connections: Array<Parameters<ControlClientOpen>[0]> = [];
      const open: ControlClientOpen = (connection, use) => {
        connections.push(connection);
        return use({
          "server.listCompositionSquads": rpc,
        } as never);
      };

      const listed = yield* listSquads(
        {
          serverUrl: "http://127.0.0.1:3773",
          accessToken: "session-token",
          includeArchived: true,
        },
        open,
      );

      expect(listed).toEqual(result);
      expect(connections).toEqual([
        {
          serverUrl: "http://127.0.0.1:3773",
          accessToken: "session-token",
        },
      ]);
      expect(rpc).toHaveBeenCalledWith({ includeArchived: true });
    }),
  );

  it("输出稳定的 JSON 或紧凑的人类可读列表", () => {
    expect(formatSquadList(result, true)).toBe(JSON.stringify(result.squads, null, 2));
    expect(formatSquadList(result, false)).toBe(
      "Build squad  squad-build  r3  review_critic  2 members  active",
    );
    expect(formatSquadList({ squads: [] }, false)).toBe("No squads found.");
  });
});
