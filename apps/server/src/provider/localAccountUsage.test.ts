// @effect-diagnostics preferSchemaOverJson:off - 测试构造各家官方接口的响应 JSON。
// 归一化函数按 CPA Management Center（4530da2）的解析语义造数据。
import { describe, expect, it } from "vite-plus/test";

import {
  claudeFableWindow,
  claudePlanFromProfile,
  codexPlanFromCredential,
  xaiBillingWindow,
} from "./localAccountUsage.ts";

const base64url = (value: object): string =>
  Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");

const makeJwt = (payload: object): string => `aa.${base64url(payload)}.bb`;

describe("Codex plan_type 兜底", () => {
  it("从 id_token 的 chatgpt_plan_type 取值", () => {
    expect(codexPlanFromCredential({ id_token: makeJwt({ chatgpt_plan_type: "pro" }) })).toBe(
      "pro",
    );
    expect(codexPlanFromCredential({ id_token: makeJwt({ sub: "x" }) })).toBeUndefined();
    expect(codexPlanFromCredential({})).toBeUndefined();
  });
});

describe("Claude 套餐档位", () => {
  it("Team/Max/Pro/Free 按 profile 旗标判定", () => {
    expect(
      claudePlanFromProfile({
        organization: { organization_type: "claude_team", subscription_status: "active" },
        account: { has_claude_max: true },
      }),
    ).toBe("Team");
    expect(claudePlanFromProfile({ account: { has_claude_max: true } })).toBe("Max");
    expect(
      claudePlanFromProfile({ account: { has_claude_max: false, has_claude_pro: true } }),
    ).toBe("Pro");
    expect(
      claudePlanFromProfile({ account: { has_claude_max: false, has_claude_pro: false } }),
    ).toBe("Free");
    expect(claudePlanFromProfile({})).toBeUndefined();
  });
});

describe("Claude Fable 周窗", () => {
  it("从 usage.limits[] 的 weekly_scoped 条目取 Fable 窗口", () => {
    const view = claudeFableWindow({
      limits: [
        {
          kind: "weekly_scoped",
          is_active: true,
          percent: 40,
          resets_at: "2026-10-05T00:00:00Z",
          scope: { model: { display_name: "Fable" } },
        },
      ],
    });
    expect(view).toMatchObject({ label: "Fable 7 天", percent: 40 });
  });

  it("非 Fable / 非 weekly_scoped 条目忽略", () => {
    expect(
      claudeFableWindow({
        limits: [
          { kind: "weekly_scoped", percent: 10, scope: { model: { display_name: "Opus" } } },
        ],
      }),
    ).toBeUndefined();
    expect(claudeFableWindow({})).toBeUndefined();
  });
});

describe("Grok billing 窗口", () => {
  it("weekly：creditUsagePercent 直读", () => {
    expect(xaiBillingWindow("周额度", { config: { creditUsagePercent: 42 } })).toEqual({
      label: "周额度",
      percent: 42,
    });
  });

  it("monthly：used/monthlyLimit 折算百分比与美元余量", () => {
    expect(xaiBillingWindow("月额度", { config: { monthlyLimit: 10_000, used: 2_500 } })).toEqual({
      label: "月额度",
      percent: 25,
      remaining: "$75.00/$100.00",
    });
  });

  it("无 config 或无数值字段返回 undefined", () => {
    expect(xaiBillingWindow("月额度", {})).toBeUndefined();
    expect(xaiBillingWindow("月额度", { config: {} })).toBeUndefined();
  });
});
