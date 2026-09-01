import { describe, expect, it } from "vite-plus/test";

import {
  BALANCE_UNLIMITED_THRESHOLD,
  NEGATIVE_BALANCE_CACHE_TTL_MS,
  POSITIVE_BALANCE_CACHE_TTL_MS,
  balanceCacheDelete,
  balanceCacheGet,
  balanceCacheSet,
  classifyBalanceFailure,
  lookupDotPath,
  normalizeBalanceWindow,
  parseDeepSeekBalance,
  parseNewAPIQuota,
  parseNumericDotPath,
  parseNumericField,
  parseOpenAIBilling,
  resolveBalanceProfile,
  shouldCacheBalanceResult,
  type NormalizedBalanceResult,
} from "./BalanceCore.ts";

describe("BalanceCore", () => {
  it("parses generic numeric fields and numeric strings", () => {
    expect(parseNumericField({ balance: " 12.50 " }, ["remaining", "balance"])).toEqual({
      value: 12.5,
      field: "balance",
    });
    expect(parseNumericField({ balance: true }, ["balance"])).toBeUndefined();
    expect(parseNumericField({ balance: "Infinity" }, ["balance"])).toBeUndefined();
  });

  it("looks up custom dot paths through objects and arrays", () => {
    const payload = { data: { infos: [{ total_balance: "8.75" }] } };
    expect(lookupDotPath(payload, "data.infos.0.total_balance")).toBe("8.75");
    expect(parseNumericDotPath(payload, "data.infos.0.total_balance")).toBe(8.75);
    expect(lookupDotPath(payload, "data.infos.one.total_balance")).toBeUndefined();
    expect(lookupDotPath(payload, "data.infos.2.total_balance")).toBeUndefined();
  });

  it("resolves profiles in declared capability, explicit, and inferred order", () => {
    expect(resolveBalanceProfile({ usageStatus: "none", requestedProfile: "newapi" })).toBe("none");
    expect(resolveBalanceProfile({ usageStatus: "general", requestedProfile: "custom" })).toBe(
      "general",
    );
    expect(resolveBalanceProfile({ usageStatus: "newapi", requestedProfile: "general" })).toBe(
      "newapi",
    );
    expect(resolveBalanceProfile({ usageStatus: "token_plan", requestedProfile: "general" })).toBe(
      "token_plan",
    );
    expect(resolveBalanceProfile({ usageStatus: "custom_only", requestedProfile: "general" })).toBe(
      "custom",
    );
    expect(
      resolveBalanceProfile({ requestedProfile: "official", accessToken: "x", userID: "1" }),
    ).toBe("official");
    expect(resolveBalanceProfile({ baseURL: "https://api.kimi.com/coding" })).toBe("token_plan");
    expect(resolveBalanceProfile({ accessToken: " token ", userID: " 4 " })).toBe("newapi");
    expect(
      resolveBalanceProfile({ queryURL: "https://example.com", queryField: "data.balance" }),
    ).toBe("custom");
    expect(resolveBalanceProfile({ requestedProfile: "unknown" })).toBe("auto");
  });

  it("converts NewAPI quota units and recognizes unlimited quota", () => {
    expect(
      parseNewAPIQuota({
        success: true,
        data: { group: "pro", quota: 1_000_000, used_quota: 250_000 },
      }),
    ).toMatchObject({
      source: "newapi",
      currency: "USD",
      total: 2.5,
      used: 0.5,
      remaining: 2,
      planName: "pro",
      unlimited: false,
    });

    const unlimited = parseNewAPIQuota({
      data: { quota: BALANCE_UNLIMITED_THRESHOLD * 500_000 },
    });
    expect(unlimited).toMatchObject({ unlimited: true, planName: "默认套餐" });
    expect(unlimited).not.toHaveProperty("remaining");
    expect(parseNewAPIQuota({ success: false, data: { quota: 1 } })).toBeUndefined();
  });

  it("parses DeepSeek balances and prefers CNY when multiple currencies are present", () => {
    expect(
      parseDeepSeekBalance({
        is_available: true,
        balance_infos: [
          { currency: "USD", total_balance: "1.25" },
          { currency: "CNY", total_balance: "20" },
          { currency: "CNY", total_balance: "0.5" },
        ],
      }),
    ).toMatchObject({
      source: "deepseek",
      currency: "CNY",
      remaining: 20.5,
      unlimited: false,
    });
    expect(parseDeepSeekBalance({ balance_infos: [] })).toBeUndefined();
  });

  it("converts OpenAI total_usage cents and recognizes unlimited totals", () => {
    expect(
      parseOpenAIBilling({ system_hard_limit_usd: "20" }, { total_usage: "1250" }),
    ).toMatchObject({ total: 20, used: 12.5, remaining: 7.5, unlimited: false });
    const unlimited = parseOpenAIBilling({ hard_limit_usd: BALANCE_UNLIMITED_THRESHOLD });
    expect(unlimited).toMatchObject({ unlimited: true });
    expect(unlimited).not.toHaveProperty("total");
    expect(parseOpenAIBilling({})).toBeUndefined();
  });

  it("normalizes window fractions and statuses", () => {
    const window = normalizeBalanceWindow({
      id: "5h",
      label: "5 hours",
      unit: "%",
      used: 85,
      limit: 100,
    });
    expect(window).toMatchObject({ usedFraction: 0.85, status: "warning" });
    expect(window.remainingFraction).toBeCloseTo(0.15);
    expect(
      normalizeBalanceWindow({ id: "7d", label: "weekly", unit: "%", remainingFraction: 0 }),
    ).toMatchObject({
      status: "exhausted",
    });
  });

  it("classifies only transport, timeout, and body-read failures as transient", () => {
    expect(classifyBalanceFailure({ kind: "transport" })).toBe("transient");
    expect(classifyBalanceFailure({ kind: "timeout" })).toBe("transient");
    expect(classifyBalanceFailure({ kind: "body_read" })).toBe("transient");
    expect(classifyBalanceFailure({ kind: "http", status: 503 })).toBe("deterministic");
    expect(classifyBalanceFailure({ kind: "invalid_json" })).toBe("deterministic");
  });

  it("provides immutable positive and negative TTL cache operations", () => {
    const now = 10_000;
    const positive = balanceCacheSet({}, "ok", "value", "positive", now);
    const negative = balanceCacheSet(positive, "no", "failure", "negative", now);

    expect(balanceCacheGet(positive, "ok", now + POSITIVE_BALANCE_CACHE_TTL_MS - 1)).toBe("value");
    expect(balanceCacheGet(positive, "ok", now + POSITIVE_BALANCE_CACHE_TTL_MS)).toBeUndefined();
    expect(balanceCacheGet(negative, "no", now + NEGATIVE_BALANCE_CACHE_TTL_MS - 1)).toBe(
      "failure",
    );
    expect(balanceCacheGet(negative, "no", now + NEGATIVE_BALANCE_CACHE_TTL_MS)).toBeUndefined();
    expect(balanceCacheDelete(negative, "ok")).not.toHaveProperty("ok");
    expect(negative).toHaveProperty("ok");
  });

  it("caches successes and deterministic failures but not transient failures", () => {
    const base: NormalizedBalanceResult = {
      supported: false,
      source: "general",
      currency: "",
      unlimited: false,
      windows: [],
      message: "failed",
      transient: false,
    };
    expect(shouldCacheBalanceResult({ ...base, supported: true })).toBe("positive");
    expect(shouldCacheBalanceResult(base)).toBe("negative");
    expect(shouldCacheBalanceResult({ ...base, transient: true })).toBeUndefined();
  });
});
