import { describe, expect, it } from "@effect/vitest";

import {
  createAccountQuotaStore,
  normalizeAccountRateLimits,
  parseAccountQuotaPersistence,
} from "./AccountQuota.ts";

describe("normalizeAccountRateLimits", () => {
  it("parses the Codex app-server nested window shape", () => {
    const { windows, planName } = normalizeAccountRateLimits({
      planType: "pro",
      rateLimits: undefined,
      primary: { usedPercent: 42, resetsAt: 1_767_225_600, windowDurationMins: 300 },
      secondary: { usedPercent: 7, resetsAt: 1_767_840_000, windowDurationMins: 10_080 },
    });

    expect(planName).toBe("pro");
    expect(windows).toHaveLength(2);
    expect(windows[0]).toEqual({
      id: "primary",
      label: "5 hours",
      usedFraction: 0.42,
      resetsAt: "2026-01-01T00:00:00.000Z",
      status: "ok",
    });
    expect(windows[1]).toMatchObject({
      id: "secondary",
      label: "7 days",
      usedFraction: 0.07,
      status: "ok",
    });
  });

  it("parses the Claude stream-json single window shape", () => {
    const { windows } = normalizeAccountRateLimits({
      type: "rate_limit_event",
      rate_limit_type: "five_hour",
      utilization: 85,
      resets_at: 1_767_225_600,
    });

    expect(windows).toHaveLength(1);
    expect(windows[0]).toEqual({
      id: "five_hour",
      label: "5 hours",
      usedFraction: 0.85,
      resetsAt: "2026-01-01T00:00:00.000Z",
      status: "warning",
    });
  });

  it("treats values at or below 1 as fractions", () => {
    const { windows } = normalizeAccountRateLimits({
      primary: { usedPercent: 0.42, windowDurationMins: 300 },
    });
    expect(windows[0]?.usedFraction).toBe(0.42);
  });

  it("maps exhaustion, warning, and missing usage to statuses", () => {
    const exhausted = normalizeAccountRateLimits({ primary: { usedPercent: 100 } });
    const unknown = normalizeAccountRateLimits({ primary: { windowDurationMins: 300 } });

    expect(exhausted.windows[0]?.status).toBe("exhausted");
    expect(unknown.windows).toHaveLength(0);
  });

  it("returns no windows for unrecognized payloads", () => {
    expect(normalizeAccountRateLimits(undefined).windows).toHaveLength(0);
    expect(normalizeAccountRateLimits({ something: "else" }).windows).toHaveLength(0);
    expect(normalizeAccountRateLimits("junk").windows).toHaveLength(0);
  });
});

describe("accountQuotaStore", () => {
  it("merges Claude's one-window-per-event updates by window id", () => {
    const store = createAccountQuotaStore();
    store.update("claudeAgent", { rate_limit_type: "five_hour", utilization: 30 }, 1_000);
    store.update("claudeAgent", { rate_limit_type: "seven_day", utilization: 60 }, 2_000);
    store.update("claudeAgent", { rate_limit_type: "five_hour", utilization: 40 }, 3_000);

    const { providers } = store.snapshot(3_000);
    expect(providers).toHaveLength(1);
    expect(providers[0]?.windows.map((window) => window.id).sort()).toEqual([
      "five_hour",
      "seven_day",
    ]);
    expect(providers[0]?.windows.find((window) => window.id === "five_hour")?.usedFraction).toBe(
      0.4,
    );
    expect(providers[0]?.windows.find((window) => window.id === "seven_day")?.usedFraction).toBe(
      0.6,
    );
  });

  it("drops windows that have not refreshed within the 7-day TTL", () => {
    const store = createAccountQuotaStore();
    const week = 7 * 24 * 60 * 60 * 1000;
    store.update("codex", { primary: { usedPercent: 10 } }, 1_000);
    store.update("codex", { secondary: { usedPercent: 20 } }, 1_000 + week + 1);

    const { providers } = store.snapshot(1_000 + week + 1);
    expect(providers[0]?.windows.map((window) => window.id)).toEqual(["secondary"]);
  });

  it("skips updates that carry no recognizable window or plan", () => {
    const store = createAccountQuotaStore();
    store.update("codex", { unrelated: true }, 1_000);
    expect(store.snapshot(1_000).providers).toHaveLength(0);
  });

  it("round-trips through serialize/hydrate without clobbering live windows", () => {
    const source = createAccountQuotaStore();
    source.update("codex", { primary: { usedPercent: 10 }, planType: "plus" }, 1_000);
    const persisted = source.takeDirtySnapshot();
    expect(persisted).toBeDefined();
    expect(source.takeDirtySnapshot()).toBeUndefined();

    // 进程在最后一次落盘之后又收到了更新。
    source.update("codex", { primary: { usedPercent: 50 } }, 2_000);

    const restored = createAccountQuotaStore();
    restored.hydrate(persisted!);
    expect(restored.takeDirtySnapshot()).toBeUndefined();
    expect(restored.snapshot(2_000).providers[0]?.windows).toHaveLength(1);
    // 水合只补缺，不覆盖：恢复出来的旧值不该出现在进程内新值旁边。
    restored.update("codex", { primary: { usedPercent: 99 } }, 3_000);
    expect(restored.snapshot(3_000).providers[0]?.windows[0]?.usedFraction).toBe(0.99);
  });
});

describe("parseAccountQuotaPersistence", () => {
  it("accepts well-formed state and rejects junk", () => {
    expect(
      parseAccountQuotaPersistence(JSON.stringify({ version: 1, providers: [] })),
    ).toMatchObject({ version: 1 });
    expect(parseAccountQuotaPersistence("not json")).toBeUndefined();
    expect(parseAccountQuotaPersistence(JSON.stringify({ version: 1 }))).toBeUndefined();
    expect(
      parseAccountQuotaPersistence(JSON.stringify({ version: 1, providers: "nope" })),
    ).toBeUndefined();
    expect(
      parseAccountQuotaPersistence(
        JSON.stringify({ version: 1, providers: [{ provider: "unknown", windows: [] }] }),
      ),
    ).toBeUndefined();
  });
});
