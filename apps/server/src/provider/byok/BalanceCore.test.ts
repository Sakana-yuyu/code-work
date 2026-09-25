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
  parseMoonshotBalance,
  parseNovitaAccount,
  parseNewAPIQuota,
  parseNumericDotPath,
  parseNumericField,
  parseOpenAIBilling,
  parseOpenRouterCredits,
  parseOpenRouterKeyLimit,
  parseStepFunAccount,
  parseZhipuBalance,
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

  it("按 Moonshot 区域解析余额并保留零值", () => {
    expect(
      parseMoonshotBalance({ code: 0, status: true, data: { available_balance: "0" } }, "CNY"),
    ).toMatchObject({ source: "moonshot", currency: "CNY", remaining: 0 });
    expect(
      parseMoonshotBalance({ code: 0, status: true, data: { available_balance: 12.5 } }, "USD"),
    ).toMatchObject({ currency: "USD", remaining: 12.5 });
    expect(
      parseMoonshotBalance({ code: 401, status: false, data: { available_balance: 7 } }, "CNY"),
    ).toBeUndefined();
    expect(parseMoonshotBalance({ data: { cash_balance: 7 } }, "CNY")).toBeUndefined();
  });

  it("StepFun 开放平台余额只读取账户 balance，不混入充值或赠额", () => {
    expect(
      parseStepFunAccount(
        { object: "account", type: "prepaid", balance: 0, total_cash_balance: 15 },
        "CNY",
      ),
    ).toMatchObject({ source: "stepfun_account", currency: "CNY", remaining: 0 });
    expect(
      parseStepFunAccount(
        { object: "account", type: "postpaid", balance: "4.25", total_voucher_balance: 12 },
        "USD",
      ),
    ).toMatchObject({ currency: "USD", remaining: 4.25 });
    expect(
      parseStepFunAccount({ object: "account", total_cash_balance: 10 }, "CNY"),
    ).toBeUndefined();
    expect(parseStepFunAccount({ object: "error", balance: 5 }, "CNY")).toBeUndefined();
  });

  it("Novita 积分按万分之一美元换算，缺失字段不当作零余额", () => {
    expect(parseNovitaAccount({ credit_balance: "125000" })).toMatchObject({
      source: "novita_account",
      currency: "USD",
      remaining: 12.5,
    });
    expect(parseNovitaAccount({ credit_balance: "0" })).toMatchObject({ remaining: 0 });
    expect(parseNovitaAccount({})).toBeUndefined();
    expect(parseNovitaAccount({ credit_balance: "invalid" })).toBeUndefined();
    expect(parseNovitaAccount({ credit_balance: -100 })).toBeUndefined();
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

  it("将 OpenRouter 账户额度与单 Key 限额分别归一化", () => {
    expect(
      parseOpenRouterCredits({ data: { total_credits: 100.5, total_usage: 25.75 } }),
    ).toMatchObject({
      source: "openrouter_credits",
      total: 100.5,
      used: 25.75,
      remaining: 74.75,
    });
    expect(parseOpenRouterCredits({ data: { total_credits: 0, total_usage: 0 } })).toMatchObject({
      remaining: 0,
    });
    expect(parseOpenRouterCredits({ data: { total_credits: 10 } })).toBeUndefined();
    expect(parseOpenRouterCredits({ data: { total_credits: -1, total_usage: 0 } })).toBeUndefined();

    expect(parseOpenRouterKeyLimit({ data: { limit: 100, limit_remaining: 74.5 } })).toMatchObject({
      source: "openrouter_key_limit",
      total: 100,
      remaining: 74.5,
    });
    const uncapped = parseOpenRouterKeyLimit({
      data: { limit: null, limit_remaining: null },
    });
    expect(uncapped).toMatchObject({ source: "openrouter_key_limit", unlimited: false });
    expect(uncapped).not.toHaveProperty("remaining");
    expect(parseOpenRouterKeyLimit({ data: { limit: 100 } })).toBeUndefined();
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

  it("parses the Zhipu quota windows sorted shortest-first with the wallet report", () => {
    const quota = {
      success: true,
      data: {
        level: "pro",
        limits: [
          {
            type: "TOKENS_LIMIT",
            unit: 6,
            number: 1,
            percentage: 8,
            nextResetTime: "2026-09-15T00:00:00+08:00",
          },
          {
            type: "TOKENS_LIMIT",
            unit: 3,
            number: 5,
            percentage: 37.5,
            nextResetTime: "2026-09-13T20:00:00+08:00",
          },
        ],
      },
    };
    const report = {
      success: true,
      data: { availableBalance: 42.5, totalSpendAmount: 7.5, currency: "CNY" },
    };

    const result = parseZhipuBalance(report, quota);

    expect(result).toMatchObject({
      supported: true,
      source: "zhipu",
      currency: "CNY",
      remaining: 42.5,
      used: 7.5,
      total: 50,
      planName: "PRO",
    });
    expect(result?.windows).toHaveLength(2);
    expect(result?.windows[0]).toMatchObject({ id: "session", usedFraction: 0.375, unit: "%" });
    expect(result?.windows[1]).toMatchObject({ id: "weekly", usedFraction: 0.08 });
  });

  it("builds count-based Zhipu windows from currentValue/usage when no percentage exists", () => {
    const quota = {
      success: true,
      data: {
        level: "lite",
        limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 1000, currentValue: 250 }],
      },
    };

    const result = parseZhipuBalance(undefined, quota);

    expect(result?.windows[0]).toMatchObject({
      id: "session",
      unit: "credits",
      usedFraction: 0.25,
      used: 250,
      limit: 1000,
    });
  });

  it("falls back to the v4 balance shape and drops an unrecognized envelope", () => {
    const v4 = { success: true, data: { available_balance: 12.34, currency: "CNY" } };
    expect(parseZhipuBalance(undefined, undefined, v4)).toMatchObject({
      source: "zhipu",
      remaining: 12.34,
      windows: [],
    });
    expect(parseZhipuBalance({ success: false, msg: "bad key" })).toBeUndefined();
    expect(parseZhipuBalance(undefined, { success: true, data: {} })).toBeUndefined();
  });
});
