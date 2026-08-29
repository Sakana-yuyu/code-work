import type { CompositionSquad, CompositionSquadResult } from "@codework/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, vi } from "vite-plus/test";

import type { ControlClientOpen } from "./controlClient.ts";
import { archiveSquad, duplicateSquad, restoreSquad } from "./squad.ts";

const squad: CompositionSquad = {
  squadId: "squad-build",
  name: "Build squad",
  leaderAgentId: "agent-lead",
  memberAgentIds: ["agent-lead", "agent-build"],
  revision: 4,
  collaborationMode: "leader_workers",
  maxConcurrency: 2,
  failurePolicy: "fail_fast",
  partialSuccessPolicy: "reject",
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
};

const result: CompositionSquadResult = { squad };

describe("Squad lifecycle CLI", () => {
  it.effect("复制 Squad 时显式传递来源、新 ID 和名称", () =>
    Effect.gen(function* () {
      const rpc = vi.fn(() => Effect.succeed(result));
      const open: ControlClientOpen = (_connection, use) =>
        use({ "server.duplicateCompositionSquad": rpc } as never);

      expect(
        yield* duplicateSquad(
          {
            serverUrl: "http://127.0.0.1:3773",
            sourceSquadId: "squad-source",
            squadId: "squad-build",
            name: "Build squad",
          },
          open,
        ),
      ).toEqual(result);
      expect(rpc).toHaveBeenCalledWith({
        sourceSquadId: "squad-source",
        squadId: "squad-build",
        name: "Build squad",
      });
    }),
  );

  it.effect("归档和恢复必须携带 expected revision", () =>
    Effect.gen(function* () {
      const archiveRpc = vi.fn(() => Effect.succeed(result));
      const restoreRpc = vi.fn(() => Effect.succeed(result));
      const open: ControlClientOpen = (_connection, use) =>
        use({
          "server.archiveCompositionSquad": archiveRpc,
          "server.restoreCompositionSquad": restoreRpc,
        } as never);

      yield* archiveSquad(
        {
          serverUrl: "http://127.0.0.1:3773",
          squadId: "squad-build",
          expectedRevision: 3,
        },
        open,
      );
      yield* restoreSquad(
        {
          serverUrl: "http://127.0.0.1:3773",
          squadId: "squad-build",
          expectedRevision: 4,
        },
        open,
      );

      expect(archiveRpc).toHaveBeenCalledWith({
        squadId: "squad-build",
        expectedRevision: 3,
      });
      expect(restoreRpc).toHaveBeenCalledWith({
        squadId: "squad-build",
        expectedRevision: 4,
      });
    }),
  );
});
