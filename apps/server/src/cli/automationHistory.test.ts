import type { CompositionAutomationRunListResult } from "@codework/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, vi } from "vite-plus/test";

import type { ControlClientOpen } from "./controlClient.ts";
import { formatAutomationRunHistory, listAutomationRuns } from "./automation.ts";

const history: CompositionAutomationRunListResult = {
  runs: [
    {
      automationRunId: "automation-run-2",
      automationId: "automation-daily-review",
      automationRevision: 3,
      scheduledForUnixMs: 2_000,
      idempotencyKey: "composition-automation:automation-daily-review:2000",
      trigger: "retry",
      operationId: "operation-retry",
      sourceAutomationRunId: "automation-run-1",
      status: "succeeded",
      attempt: 2,
      requestedAtUnixMs: 2_000,
      startedAtUnixMs: 2_100,
      finishedAtUnixMs: 2_500,
      compositionTaskId: "task-2",
      compositionRunId: "run-2",
      outputSummary: "Review completed",
      errorCode: null,
      errorDetail: null,
    },
  ],
  nextCursor: "cursor-next",
};

describe("Automation history CLI", () => {
  it.effect("通过 typed RPC 查询带游标和上限的运行历史", () =>
    Effect.gen(function* () {
      const rpc = vi.fn(() => Effect.succeed(history));
      const open: ControlClientOpen = (_connection, use) =>
        use({ "server.listCompositionAutomationRuns": rpc } as never);

      const result = yield* listAutomationRuns(
        {
          serverUrl: "http://127.0.0.1:3773",
          automationId: "automation-daily-review",
          cursor: "cursor-current",
          limit: 50,
        },
        open,
      );

      expect(result).toEqual(history);
      expect(rpc).toHaveBeenCalledWith({
        automationId: "automation-daily-review",
        cursor: "cursor-current",
        limit: 50,
      });
    }),
  );

  it("输出稳定的分页历史", () => {
    expect(formatAutomationRunHistory(history, true)).toBe(JSON.stringify(history, null, 2));
    expect(formatAutomationRunHistory(history, false)).toBe(
      [
        "automation-run-2  succeeded  retry  r3  attempt=2  scheduled=1970-01-01T00:00:02.000Z  task=task-2  output=Review completed",
        "Next cursor: cursor-next",
      ].join("\n"),
    );
    expect(formatAutomationRunHistory({ runs: [], nextCursor: null }, false)).toBe(
      "No automation runs found.",
    );
  });
});
