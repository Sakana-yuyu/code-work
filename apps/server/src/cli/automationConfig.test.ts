import type {
  CompositionAutomationCreateRequest,
  CompositionAutomationResult,
  CompositionAutomationUpdateRequest,
} from "@codework/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, vi } from "vite-plus/test";

import type { ControlClientOpen } from "./controlClient.ts";
import {
  createAutomation,
  decodeAutomationCreateConfigText,
  decodeAutomationUpdateConfigText,
  updateAutomation,
} from "./automation.ts";

const createRequest: CompositionAutomationCreateRequest = {
  automationId: "automation-daily-review",
  projectId: "project-1",
  name: "Daily review",
  prompt: "Review open issues",
  cadence: {
    type: "every",
    intervalMs: 60_000,
  },
  target: {
    type: "agent",
    agentId: "agent-review",
    model: "review-model",
    capabilityIds: ["fs.read"],
    executionContext: {
      mode: "existing_thread",
      threadId: "thread-review",
    },
  },
  maxRuns: 5,
  expiresAtUnixMs: null,
  runOnCreate: false,
};

const updateRequest: CompositionAutomationUpdateRequest = {
  automationId: "automation-daily-review",
  expectedRevision: 2,
  name: "Daily repository review",
};

const result: CompositionAutomationResult = {
  automation: {
    ...createRequest,
    name: updateRequest.name ?? createRequest.name,
    status: "active",
    revision: 3,
    runCount: 0,
    createdAtUnixMs: 1_000,
    updatedAtUnixMs: 2_000,
    nextRunAtUnixMs: 61_000,
    lastRunAtUnixMs: null,
    pausedAtUnixMs: null,
  },
};

const createJson = `{
  "automationId": "automation-daily-review",
  "projectId": "project-1",
  "name": "Daily review",
  "prompt": "Review open issues",
  "cadence": {"type": "every", "intervalMs": 60000},
  "target": {
    "type": "agent",
    "agentId": "agent-review",
    "model": "review-model",
    "capabilityIds": ["fs.read"],
    "executionContext": {"mode": "existing_thread", "threadId": "thread-review"}
  },
  "maxRuns": 5,
  "expiresAtUnixMs": null,
  "runOnCreate": false
}`;

const updateJson = `{
  "automationId": "automation-daily-review",
  "expectedRevision": 2,
  "name": "Daily repository review"
}`;

describe("Automation config CLI", () => {
  it.effect("通过合同 Schema 解码创建和更新配置", () =>
    Effect.gen(function* () {
      expect(yield* decodeAutomationCreateConfigText(createJson)).toEqual(createRequest);
      expect(yield* decodeAutomationUpdateConfigText(updateJson)).toEqual(updateRequest);

      const createError = yield* decodeAutomationCreateConfigText('{"automationId":"broken"}').pipe(
        Effect.flip,
      );
      expect(createError).toMatchObject({
        _tag: "AutomationConfigInputError",
        message: "Automation create config does not match the Code Work contract.",
      });

      const updateError = yield* decodeAutomationUpdateConfigText(
        '{"automationId":"automation-daily-review","expectedRevision":2}',
      ).pipe(Effect.flip);
      expect(updateError).toMatchObject({
        _tag: "AutomationConfigInputError",
        message: "Automation update config does not match the Code Work contract.",
      });
    }),
  );

  it.effect("创建和更新只通过 typed RPC 提交合同数据", () =>
    Effect.gen(function* () {
      const createRpc = vi.fn(() => Effect.succeed(result));
      const updateRpc = vi.fn(() => Effect.succeed(result));
      const open: ControlClientOpen = (_connection, use) =>
        use({
          "server.createCompositionAutomation": createRpc,
          "server.updateCompositionAutomation": updateRpc,
        } as never);

      expect(
        yield* createAutomation({ serverUrl: "http://127.0.0.1:3773", input: createRequest }, open),
      ).toEqual(result);
      expect(
        yield* updateAutomation({ serverUrl: "http://127.0.0.1:3773", input: updateRequest }, open),
      ).toEqual(result);

      expect(createRpc).toHaveBeenCalledWith(createRequest);
      expect(updateRpc).toHaveBeenCalledWith(updateRequest);
    }),
  );
});
