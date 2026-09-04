import { describe, expect, it } from "vite-plus/test";

import type { ModelTotals } from "./usageMerge.ts";
import {
  activityLevel,
  aggregateWeeks,
  computeActivityStats,
  cumulativeTotals,
  modelShareSlices,
  rankModelsByTokens,
} from "./usageStats.ts";

const DAYS = [
  "2026-08-03", // Monday
  "2026-08-04",
  "2026-08-05",
  "2026-08-06",
  "2026-08-07",
  "2026-08-08",
  "2026-08-09",
  "2026-08-10",
  "2026-08-11",
];

function tokensByDay(entries: readonly (readonly [string, number])[]): Map<string, number> {
  return new Map(entries);
}

describe("computeActivityStats", () => {
  it("finds the peak day and streaks across active days", () => {
    const stats = computeActivityStats(
      DAYS,
      tokensByDay([
        ["2026-08-03", 100],
        ["2026-08-04", 900],
        ["2026-08-05", 10],
        ["2026-08-07", 5],
        ["2026-08-08", 6],
        ["2026-08-09", 7],
        ["2026-08-11", 1],
      ]),
      "2026-08-11",
    );

    expect(stats.peakDay).toBe("2026-08-04");
    expect(stats.peakDayTokens).toBe(900);
    expect(stats.activeDays).toBe(7);
    expect(stats.currentStreak).toBe(1);
    expect(stats.longestStreak).toBe(3);
  });

  it("keeps the current streak alive through an inactive today", () => {
    const stats = computeActivityStats(
      DAYS,
      tokensByDay([
        ["2026-08-09", 7],
        ["2026-08-10", 6],
      ]),
      "2026-08-11",
    );

    expect(stats.currentStreak).toBe(2);
  });

  it("reads zero streaks when the window ends idle", () => {
    const stats = computeActivityStats(
      DAYS,
      tokensByDay([
        ["2026-08-03", 7],
        ["2026-08-04", 6],
      ]),
      "2026-08-11",
    );

    expect(stats.currentStreak).toBe(0);
    expect(stats.longestStreak).toBe(2);
  });

  it("counts a fully active window as one unbroken streak", () => {
    const stats = computeActivityStats(
      DAYS.slice(0, 5),
      tokensByDay(DAYS.slice(0, 5).map((day) => [day, 1] as const)),
      "2026-08-07",
    );

    expect(stats.currentStreak).toBe(5);
    expect(stats.longestStreak).toBe(5);
    expect(stats.activeDays).toBe(5);
  });
});

describe("aggregateWeeks", () => {
  it("rolls days into Monday-start weeks", () => {
    const weeks = aggregateWeeks(
      DAYS,
      tokensByDay(DAYS.map((day, index) => [day, index + 1] as const)),
    );

    expect(weeks.map((week) => week.weekStart)).toEqual(["2026-08-03", "2026-08-10"]);
    expect(weeks[0]?.days).toHaveLength(7);
    expect(weeks[0]?.tokens).toBe(28);
    expect(weeks[1]?.days).toEqual(["2026-08-10", "2026-08-11"]);
    expect(weeks[1]?.tokens).toBe(8 + 9);
  });

  it("returns nothing for an empty window", () => {
    expect(aggregateWeeks([], new Map())).toEqual([]);
  });
});

describe("cumulativeTotals", () => {
  it("accumulates across days including inactive ones", () => {
    const totals = cumulativeTotals(
      DAYS.slice(0, 4),
      tokensByDay([
        ["2026-08-03", 10],
        ["2026-08-05", 5],
      ]),
    );

    expect(totals).toEqual([10, 10, 15, 15]);
  });
});

describe("activityLevel", () => {
  it("maps empty days and empty windows to level 0", () => {
    expect(activityLevel(0, 100)).toBe(0);
    expect(activityLevel(10, 0)).toBe(0);
  });

  it("bands nonzero days into four quartiles of the peak", () => {
    expect(activityLevel(1, 100)).toBe(1);
    expect(activityLevel(25, 100)).toBe(1);
    expect(activityLevel(26, 100)).toBe(2);
    expect(activityLevel(75, 100)).toBe(3);
    expect(activityLevel(76, 100)).toBe(4);
    expect(activityLevel(400, 100)).toBe(4);
  });
});

describe("rankModelsByTokens", () => {
  it("ranks heaviest first and drops silent models", () => {
    const models: ModelTotals[] = [
      { model: "cheap", provider: "codex", costUsd: 9, totalTokens: 0, records: 1, costShare: 0.9 },
      {
        model: "mid",
        provider: "claude",
        costUsd: 1,
        totalTokens: 200,
        records: 1,
        costShare: 0.1,
      },
      {
        model: "heavy",
        provider: "codex",
        costUsd: 0,
        totalTokens: 1000,
        records: 1,
        costShare: 0,
      },
    ];

    expect(rankModelsByTokens(models).map((entry) => entry.model)).toEqual(["heavy", "mid"]);
    expect(rankModelsByTokens(models)[0]?.key).toBe("codex heavy");
  });
});

describe("modelShareSlices", () => {
  const models: ModelTotals[] = ["a", "b", "c", "d", "e", "f", "g"].map((model, index) => ({
    model,
    provider: "claude",
    costUsd: 0,
    totalTokens: 100 - index,
    records: 1,
    costShare: 0,
  }));

  it("collapses the tail into a remainder beyond maxSlices", () => {
    const { slices, otherTokens, otherShare } = modelShareSlices(models, 5);

    expect(slices.map((slice) => slice.model)).toEqual(["a", "b", "c", "d", "e"]);
    expect(slices[0]?.share).toBeCloseTo(100 / 679);
    expect(otherTokens).toBe(95 + 94);
    expect(otherShare).toBeCloseTo(189 / 679);
  });

  it("keeps shares at zero when no model has tokens", () => {
    const { slices, otherTokens, otherShare } = modelShareSlices(
      models.map((model) => ({ ...model, totalTokens: 0 })),
      5,
    );

    expect(slices).toEqual([]);
    expect(otherTokens).toBe(0);
    expect(otherShare).toBe(0);
  });
});
