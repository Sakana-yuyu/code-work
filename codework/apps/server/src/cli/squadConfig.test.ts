import type {
  CompositionSquadCreateRequest,
  CompositionSquadResult,
  CompositionSquadUpdateRequest,
} from "@codework/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, vi } from "vite-plus/test";

import type { ControlClientOpen } from "./controlClient.ts";
import {
  createSquad,
  decodeSquadCreateConfigText,
  decodeSquadUpdateConfigText,
  updateSquad,
} from "./squad.ts";

const createRequest: CompositionSquadCreateRequest = {
  squadId: "squad-build",
  name: "Build squad",
  leaderAgentId: "agent-lead",
  instructions: "Implement and review",
  collaborationMode: "leader_workers",
  maxConcurrency: 2,
  maxRetries: 1,
  failurePolicy: "fail_fast",
  partialSuccessPolicy: "reject",
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
};

const updateRequest: CompositionSquadUpdateRequest = {
  ...createRequest,
  expectedRevision: 3,
  name: "Build and review squad",
};

const result: CompositionSquadResult = {
  squad: {
    ...updateRequest,
    memberAgentIds: updateRequest.members.map((member) => member.agentId),
    revision: 4,
    createdAtUnixMs: 1_000,
    updatedAtUnixMs: 2_000,
  },
};

const createJson = `{
  "squadId": "squad-build",
  "name": "Build squad",
  "leaderAgentId": "agent-lead",
  "instructions": "Implement and review",
  "collaborationMode": "leader_workers",
  "maxConcurrency": 2,
  "maxRetries": 1,
  "failurePolicy": "fail_fast",
  "partialSuccessPolicy": "reject",
  "approvalStages": ["before_finalize"],
  "members": [
    {"agentId":"agent-lead","role":"leader","order":0,"required":true,"capabilityIds":["fs.read"],"maxConcurrentTasks":1},
    {"agentId":"agent-build","role":"worker","order":1,"required":true,"capabilityIds":["fs.read","fs.write"],"maxConcurrentTasks":1}
  ]
}`;

const updateJson = createJson
  .replace('"name": "Build squad"', '"name": "Build and review squad"')
  .replace("{\n", '{\n  "expectedRevision": 3,\n');

describe("Squad config CLI", () => {
  it.effect("通过合同 Schema 解码创建和更新配置", () =>
    Effect.gen(function* () {
      expect(yield* decodeSquadCreateConfigText(createJson)).toEqual(createRequest);
      expect(yield* decodeSquadUpdateConfigText(updateJson)).toEqual(updateRequest);

      const error = yield* decodeSquadCreateConfigText('{"squadId":"broken"}').pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "SquadConfigInputError",
        message: "Squad create config does not match the Code Work contract.",
      });
    }),
  );

  it.effect("创建和更新只通过 typed RPC 提交合同数据", () =>
    Effect.gen(function* () {
      const createRpc = vi.fn(() => Effect.succeed(result));
      const updateRpc = vi.fn(() => Effect.succeed(result));
      const open: ControlClientOpen = (_connection, use) =>
        use({
          "server.createCompositionSquad": createRpc,
          "server.updateCompositionSquad": updateRpc,
        } as never);

      expect(
        yield* createSquad({ serverUrl: "http://127.0.0.1:3773", input: createRequest }, open),
      ).toEqual(result);
      expect(
        yield* updateSquad({ serverUrl: "http://127.0.0.1:3773", input: updateRequest }, open),
      ).toEqual(result);

      expect(createRpc).toHaveBeenCalledWith(createRequest);
      expect(updateRpc).toHaveBeenCalledWith(updateRequest);
    }),
  );
});
