// @effect-diagnostics preferSchemaOverJson:off - 测试构造各家官方接口的响应 JSON。
// 归一化函数按 CPA Management Center（4530da2）的解析语义造数据。
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { LocalAccountId } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import { resetZCodeClientConfigsCacheForTest } from "./zcode/zcodeStartPlan.ts";

import {
  claudeFableWindow,
  claudePlanFromProfile,
  codexPlanFromCredential,
  xaiBillingWindow,
  fetchLocalAccountSubscription,
} from "./localAccountUsage.ts";

const base64url = (value: object): string =>
  Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");

const makeJwt = (payload: object): string => `aa.${base64url(payload)}.bb`;

describe("Codex plan_type 兜底", () => {
  it.effect("积分余额保留上游十进制字符串，不擅自添加美元符号", () =>
    Effect.gen(function* () {
      const fetchMock = (async () =>
        Response.json({
          credits: { balance: "12.34567890" },
        })) as unknown as typeof globalThis.fetch;
      const view = yield* fetchLocalAccountSubscription({
        account: {
          id: LocalAccountId.make("codex-credit"),
          provider: "codex",
          displayName: "测试",
          credentialRef: "test",
          enabled: true,
          models: [],
        },
        credential: { access_token: "test" },
        authKind: "oauth",
      }).pipe(
        Effect.provide(
          FetchHttpClient.layer.pipe(
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchMock)),
          ),
        ),
      );
      expect(view.metrics).toEqual([{ label: "积分余额", value: "12.34567890" }]);
    }),
  );
  it("从 id_token 的 chatgpt_plan_type 取值", () => {
    expect(
      codexPlanFromCredential({
        id_token: makeJwt({ "https://api.openai.com/auth": { chatgpt_plan_type: "team" } }),
      }),
    ).toBe("team");
    expect(codexPlanFromCredential({ id_token: makeJwt({ chatgpt_plan_type: "pro" }) })).toBe(
      "pro",
    );
    expect(codexPlanFromCredential({ id_token: makeJwt({ sub: "x" }) })).toBeUndefined();
    expect(codexPlanFromCredential({})).toBeUndefined();
  });
});

describe("ZCode 额度接口隔离", () => {
  const run = (credential: Record<string, unknown>, quotaStatus: number) =>
    Effect.gen(function* () {
      resetZCodeClientConfigsCacheForTest();
      const urls: string[] = [];
      const fetchMock = (async (input: string | URL) => {
        const url = String(input);
        urls.push(url);
        const payload = url.includes("quota/limit")
          ? {
              code: 200,
              data: { limits: [{ type: "TOKEN_LIMIT", percentage: 0.5, nextResetTime: 1e100 }] },
            }
          : url.includes("billing/balance")
            ? {
                code: 0,
                data: {
                  balances: [
                    {
                      capabilities: ["model:GLM-5.2"],
                      total_units: 1000,
                      used_units: 100,
                      remaining_units: 900,
                    },
                  ],
                },
              }
            : { code: 0, data: {} };
        return Response.json(payload, { status: url.includes("quota/limit") ? quotaStatus : 200 });
      }) as typeof globalThis.fetch;
      const view = yield* fetchLocalAccountSubscription({
        account: {
          id: LocalAccountId.make("zcode-test"),
          provider: "zcode",
          displayName: "测试",
          enabled: true,
          models: [],
          credentialRef: "test",
        },
        authKind: "api-key",
        credential,
      }).pipe(
        Effect.provide(
          FetchHttpClient.layer.pipe(
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchMock)),
          ),
        ),
      );
      return { view, urls };
    });
  it.effect("小于 1 的百分比保持原值，非法时间戳不导致整次查询失败", () =>
    Effect.gen(function* () {
      const { view } = yield* run({ api_key: "test-key" }, 200);
      expect(view.windows).toContainEqual({ label: "Token", percent: 0.5 });
      expect(view.error).toBeUndefined();
    }),
  );
  it.effect("Coding Plan 失败仍返回体验套餐余额并保留错误说明", () =>
    Effect.gen(function* () {
      const { view } = yield* run({ api_key: "test-key", zcode_jwt: "test-jwt" }, 401);
      expect(view.windows).toContainEqual({
        label: "GLM-5.2",
        percent: 10,
        remaining: "900/1.0k tokens",
      });
      expect(view.detail).toContain("凭据已失效");
    }),
  );
  it.effect("JWT-only 不向 Coding Plan 端点发送体验套餐令牌", () =>
    Effect.gen(function* () {
      const { view, urls } = yield* run({ zcode_jwt: "test-jwt" }, 200);
      expect(view.windows).toHaveLength(1);
      expect(urls.every((url) => url.startsWith("https://zcode.z.ai/"))).toBe(true);
    }),
  );
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
  it.effect("401 明确报告凭据失效，不伪装成平台无额度数据", () =>
    Effect.gen(function* () {
      const fetchMock = (async () =>
        Response.json({}, { status: 401 })) as unknown as typeof globalThis.fetch;
      const result = yield* fetchLocalAccountSubscription({
        account: {
          id: LocalAccountId.make("grok-test"),
          provider: "xai",
          displayName: "测试",
          credentialRef: "test",
          enabled: true,
          models: [],
        },
        credential: { access_token: "test-token" },
        authKind: "oauth",
      }).pipe(
        Effect.provide(
          FetchHttpClient.layer.pipe(
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchMock)),
          ),
        ),
      );
      expect(result.error).toContain("凭据已失效");
      expect(result.detail).toBeUndefined();
    }),
  );
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
