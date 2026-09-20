import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@codework/contracts";

import {
  deriveLatestAccountQuotaSnapshot,
  deriveCacheHitRate,
  deriveLatestContextWindowSnapshot,
  deriveModelResponseCount,
  deriveToolDurationMs,
  formatContextWindowTokens,
} from "./contextWindow";

function makeActivity(
  id: string,
  kind: string,
  payload: unknown,
  overrides: Partial<OrchestrationThreadActivity> = {},
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
    ...overrides,
  };
}

describe("contextWindow", () => {
  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
        autoCompactThreshold: 200_000,
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
    expect(snapshot?.autoCompactThreshold).toBe(200_000);
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {}),
    ]);

    expect(snapshot).toBeNull();
  });

  it("keeps valid zero-usage snapshots", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        maxTokens: 100_000,
      }),
    ]);

    expect(snapshot).toMatchObject({
      usedTokens: 0,
      maxTokens: 100_000,
      remainingTokens: 100_000,
      usedPercentage: 0,
      remainingPercentage: 100,
    });
  });

  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
  });

  it("includes total processed tokens when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        maxTokens: 258_400,
        lastUsedTokens: 81_659,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(81_659);
    expect(snapshot?.totalProcessedTokens).toBe(748_126);
  });

  it("derives the conversation cache hit rate from cumulative input tokens", () => {
    const usage = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1_500,
        inputTokens: 1_000,
        cachedInputTokens: 250,
      }),
    ]);

    expect(deriveCacheHitRate(usage)).toBe(25);
    expect(deriveCacheHitRate(null)).toBeNull();
    expect(
      deriveCacheHitRate(
        deriveLatestContextWindowSnapshot([
          makeActivity("activity-2", "context-window.updated", {
            usedTokens: 10,
            inputTokens: 10,
            cachedInputTokens: 20,
          }),
        ]),
      ),
    ).toBe(100);
  });

  it.each([
    [
      {
        inputTokens: 1000,
        cachedInputTokens: 800,
        lastInputTokens: 100,
        lastCachedInputTokens: 90,
      },
      80,
    ],
    [{ inputTokens: 1000, lastInputTokens: 100, lastCachedInputTokens: 90 }, 90],
    [{ cachedInputTokens: 800, lastInputTokens: 100, lastCachedInputTokens: 90 }, 90],
    [{ inputTokens: 1000, lastCachedInputTokens: 90 }, null],
    [
      { inputTokens: 1000, cachedInputTokens: 0, lastInputTokens: 100, lastCachedInputTokens: 90 },
      0,
    ],
  ])("缓存率不得混用累计与单轮字段 %j", (payload, expected) => {
    expect(
      deriveCacheHitRate(
        deriveLatestContextWindowSnapshot([
          makeActivity("cache-scope", "context-window.updated", { usedTokens: 1000, ...payload }),
        ]),
      ),
    ).toBe(expected);
  });

  it("sums only matched tool lifecycle durations", () => {
    expect(
      deriveToolDurationMs([
        makeActivity("tool-1-start", "tool.started", { toolCallId: "tool-1" }),
        makeActivity(
          "tool-1-end",
          "tool.completed",
          { toolCallId: "tool-1" },
          {
            createdAt: "2026-03-23T00:00:00.250Z",
          },
        ),
        makeActivity(
          "tool-2-start",
          "tool.started",
          { toolCallId: "tool-2" },
          {
            createdAt: "2026-03-23T00:00:01.000Z",
          },
        ),
        makeActivity(
          "tool-2-end",
          "tool.completed",
          { toolCallId: "tool-2" },
          {
            createdAt: "2026-03-23T00:00:01.250Z",
          },
        ),
      ]),
    ).toBe(500);
    expect(
      deriveToolDurationMs([
        makeActivity("tool-unmatched", "tool.completed", {
          toolCallId: "missing-start",
        }),
      ]),
    ).toBeNull();
  });

  it("counts each usage activity as one model response step", () => {
    expect(
      deriveModelResponseCount([
        makeActivity("usage-1", "context-window.updated", { usedTokens: 100 }),
        makeActivity("tool-1", "tool.completed", { toolCallId: "tool-1" }),
        makeActivity("usage-2", "context-window.updated", { usedTokens: 200 }),
        makeActivity("usage-3", "context-window.updated", { usedTokens: 300 }),
      ]),
    ).toBe(3);
    expect(deriveModelResponseCount([])).toBe(0);
    expect(deriveModelResponseCount([makeActivity("tool-only", "tool.completed", {})])).toBe(0);
  });

  it("derives official account quota windows without inventing missing values", () => {
    const snapshot = deriveLatestAccountQuotaSnapshot([
      makeActivity("activity-1", "account.rate-limits.updated", {
        rateLimits: {
          primary: { usedPercent: 18, resetsAt: "2026-03-23T01:00:00.000Z" },
          secondary: { utilization: 0.25, remaining: 750 },
        },
      }),
    ]);

    expect(snapshot).toMatchObject({ balance: null, unlimited: false });
    expect(snapshot?.windows).toEqual([
      {
        label: "primary",
        usedPercentage: 18,
        remaining: null,
        resetAt: "2026-03-23T01:00:00.000Z",
      },
      { label: "secondary", usedPercentage: 25, remaining: 750, resetAt: null },
    ]);
  });
});
