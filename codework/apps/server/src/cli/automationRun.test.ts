import type { CompositionAutomationRunResult } from "@codework/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, vi } from "vite-plus/test";

import type { ControlClientOpen } from "./controlClient.ts";
import { formatAutomationRunResult, retryAutomationRun, runAutomationOnce } from "./automation.ts";

const runResult: CompositionAutomationRunResult = {
  run: {
    automationRunId: "automation-run-1",
    automationId: "automation-daily-review",
    automationRevision: 3,
    scheduledForUnixMs: 2_000,
    idempotencyKey: "composition-automation:automation-daily-review:2000",
    trigger: "run_once",
    operationId: "operation-run-once",
    status: "queued",
    attempt: 1,
    requestedAtUnixMs: 2_000,
    startedAtUnixMs: null,
    finishedAtUnixMs: null,
    compositionTaskId: null,
    compositionRunId: null,
    outputSummary: null,
    errorCode: null,
    errorDetail: null,
  },
};

describe("Automation run CLI", () => {
  it.effect("run-once 和 retry 通过 typed RPC 传递稳定 operation id", () =>
    Effect.gen(function* () {
      const runOnceRpc = vi.fn(() => Effect.succeed(runResult));
      const retryRpc = vi.fn(() =>
        Effect.succeed({
          run: {
            ...runResult.run,
            automationRunId: "automation-run-2",
            trigger: "retry" as const,
            operationId: "operation-retry",
            sourceAutomationRunId: "automation-run-1",
          },
        }),
      );
      const open: ControlClientOpen = (_connection, use) =>
        use({
          "server.runCompositionAutomationOnce": runOnceRpc,
          "server.retryCompositionAutomationRun": retryRpc,
        } as never);

      yield* runAutomationOnce(
        {
          serverUrl: "http://127.0.0.1:3773",
          automationId: "automation-daily-review",
          expectedRevision: 3,
          operationId: "operation-run-once",
        },
        open,
      );
      yield* retryAutomationRun(
        {
          serverUrl: "http://127.0.0.1:3773",
          automationId: "automation-daily-review",
          automationRunId: "automation-run-1",
          expectedRevision: 3,
          operationId: "operation-retry",
        },
        open,
      );

      expect(runOnceRpc).toHaveBeenCalledWith({
        automationId: "automation-daily-review",
        expectedRevision: 3,
        operationId: "operation-run-once",
      });
      expect(retryRpc).toHaveBeenCalledWith({
        automationId: "automation-daily-review",
        automationRunId: "automation-run-1",
        expectedRevision: 3,
        operationId: "operation-retry",
      });
    }),
  );

  it("输出稳定的 Automation 运行结果", () => {
    expect(formatAutomationRunResult(runResult, true)).toBe(JSON.stringify(runResult.run, null, 2));
    expect(formatAutomationRunResult(runResult, false)).toBe(
      [
        "Run: automation-run-1",
        "Automation: automation-daily-review r3",
        "Status: queued",
        "Trigger: run_once",
        "Operation ID: operation-run-once",
        "Scheduled for: 1970-01-01T00:00:02.000Z",
        "Attempt: 1",
        "Task: none",
        "Composition run: none",
        "Output: none",
        "Error: none",
      ].join("\n"),
    );
  });
});
