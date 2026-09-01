import type {
  CompositionAutomation,
  CompositionAutomationDeleteResult,
  CompositionAutomationResult,
} from "@codework/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, vi } from "vite-plus/test";

import type { ControlClientOpen } from "./controlClient.ts";
import {
  deleteAutomation,
  formatAutomationDeleteResult,
  pauseAutomation,
  resumeAutomation,
} from "./automation.ts";

const automation: CompositionAutomation = {
  automationId: "automation-daily-review",
  projectId: "project-1",
  name: "Daily review",
  prompt: "Review open issues",
  cadence: { type: "every", intervalMs: 60_000 },
  target: {
    type: "agent",
    agentId: "agent-review",
    capabilityIds: ["fs.read"],
    executionContext: { mode: "existing_thread", threadId: "thread-review" },
  },
  status: "paused",
  revision: 3,
  maxRuns: null,
  runCount: 1,
  createdAtUnixMs: 1_000,
  updatedAtUnixMs: 2_000,
  nextRunAtUnixMs: null,
  lastRunAtUnixMs: 1_500,
  pausedAtUnixMs: 2_000,
  expiresAtUnixMs: null,
};

const result: CompositionAutomationResult = { automation };
const deleted: CompositionAutomationDeleteResult = {
  automationId: automation.automationId,
  deletedAtUnixMs: 3_000,
};

describe("Automation lifecycle CLI", () => {
  it.effect("暂停、恢复和删除必须携带 expected revision", () =>
    Effect.gen(function* () {
      const pauseRpc = vi.fn(() => Effect.succeed(result));
      const resumeRpc = vi.fn(() => Effect.succeed(result));
      const deleteRpc = vi.fn(() => Effect.succeed(deleted));
      const open: ControlClientOpen = (_connection, use) =>
        use({
          "server.pauseCompositionAutomation": pauseRpc,
          "server.resumeCompositionAutomation": resumeRpc,
          "server.deleteCompositionAutomation": deleteRpc,
        } as never);

      yield* pauseAutomation(
        {
          serverUrl: "http://127.0.0.1:3773",
          automationId: automation.automationId,
          expectedRevision: 2,
        },
        open,
      );
      yield* resumeAutomation(
        {
          serverUrl: "http://127.0.0.1:3773",
          automationId: automation.automationId,
          expectedRevision: 3,
        },
        open,
      );
      yield* deleteAutomation(
        {
          serverUrl: "http://127.0.0.1:3773",
          automationId: automation.automationId,
          expectedRevision: 4,
        },
        open,
      );

      expect(pauseRpc).toHaveBeenCalledWith({
        automationId: "automation-daily-review",
        expectedRevision: 2,
      });
      expect(resumeRpc).toHaveBeenCalledWith({
        automationId: "automation-daily-review",
        expectedRevision: 3,
      });
      expect(deleteRpc).toHaveBeenCalledWith({
        automationId: "automation-daily-review",
        expectedRevision: 4,
      });
    }),
  );

  it("输出稳定的 Automation 删除结果", () => {
    expect(formatAutomationDeleteResult(deleted, true)).toBe(JSON.stringify(deleted, null, 2));
    expect(formatAutomationDeleteResult(deleted, false)).toBe(
      "Deleted automation-daily-review at 1970-01-01T00:00:03.000Z",
    );
  });
});
