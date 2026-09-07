import { assert, describe, it } from "@effect/vitest";

import { formatThreadGoalTokens, threadGoalProgressPercent } from "./threadGoalFormat.ts";

describe("formatThreadGoalTokens", () => {
  it("keeps small values plain", () => {
    assert.equal(formatThreadGoalTokens(0), "0");
    assert.equal(formatThreadGoalTokens(999), "999");
    assert.equal(formatThreadGoalTokens(9_999), "9999");
  });

  it("compacts thousands to one decimal", () => {
    assert.equal(formatThreadGoalTokens(10_000), "10k");
    assert.equal(formatThreadGoalTokens(12_500), "12.5k");
    assert.equal(formatThreadGoalTokens(123_456), "123k");
    assert.equal(formatThreadGoalTokens(999_999), "1000k");
  });

  it("compacts millions", () => {
    assert.equal(formatThreadGoalTokens(1_000_000), "1M");
    assert.equal(formatThreadGoalTokens(2_500_000), "2.5M");
    assert.equal(formatThreadGoalTokens(12_000_000), "12M");
  });

  it("is resilient to invalid input", () => {
    assert.equal(formatThreadGoalTokens(Number.NaN), "0");
    assert.equal(formatThreadGoalTokens(-5), "0");
  });
});

describe("threadGoalProgressPercent", () => {
  it("handles zero budgets without producing an invalid width", () => {
    assert.equal(threadGoalProgressPercent(0, 0), 100);
    assert.equal(threadGoalProgressPercent(50, 100), 50);
    assert.equal(threadGoalProgressPercent(150, 100), 100);
  });
});
