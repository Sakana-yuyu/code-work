// @effect-diagnostics preferSchemaOverJson:off - 测试构造 ZCode 平台响应 JSON。
// @effect-diagnostics globalDate:off - 夹具时间戳与 ISO 断言按墙上时间构造。
// 归一化函数按 ZCode 桌面端 3.14.4（host/index.js）的响应形状造数据。
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import {
  fetchZCodeClaimOffer,
  fetchZCodeStartPlanBalance,
  normalizeClaimOffers,
  normalizeClaimResult,
  normalizeClientConfigs,
  normalizeStartPlanBalance,
  resetZCodeClientConfigsCacheForTest,
  ZCODE_APP_VERSION,
} from "./zcodeStartPlan.ts";

// 夹具时间一律相对当前墙钟：集成路径用真实 Date.now() 判过期，写死的历史
// 时间戳会让 active 套餐被判成 expired。
const NOW_SEC = Math.floor(Date.now() / 1000);

const ZCODE_ORIGIN_TEST = "https://zcode.z.ai";

const BALANCE_ACTIVE = {
  code: 0,
  data: {
    server_time: NOW_SEC,
    plans: [
      {
        plan_id: "zcode-v3-start-plan",
        user_plan_id: "up-1",
        name: "Start Plan",
        status: "active",
        ends_at: NOW_SEC + 86_400,
      },
    ],
    balances: [
      {
        entitlement_id: "e-1",
        show_name: "GLM-5.3",
        plan_id: "zcode-v3-start-plan",
        user_plan_id: "up-1",
        meter: "model_usage",
        unit_type: "token",
        capabilities: ["model:GLM-5.3"],
        total_units: 3_000_000,
        used_units: 1_000_000,
        remaining_units: 2_000_000,
        expires_at: NOW_SEC + 3_600,
      },
      {
        entitlement_id: "e-2",
        show_name: "GLM-5.3-Flash",
        plan_id: "zcode-v3-start-plan",
        user_plan_id: "up-1",
        capabilities: ["model:GLM-5.3-Flash"],
        total_units: 5_000_000,
        used_units: 0,
        remaining_units: 5_000_000,
        expires_at: NOW_SEC + 3_600,
      },
    ],
  },
};

describe("ZCode 体验套餐余额归一化", () => {
  it("显式 expired 套餐余额不再显示，同商品其他有效实例不受影响", () => {
    const expired = { ...BALANCE_ACTIVE.data.plans[0]!, status: "expired" };
    const view = normalizeStartPlanBalance(
      {
        code: 0,
        data: {
          plans: [expired, { ...expired, user_plan_id: "up-2", status: "active" }],
          balances: [
            BALANCE_ACTIVE.data.balances[0],
            { ...BALANCE_ACTIVE.data.balances[1], user_plan_id: "up-2" },
          ],
        },
      },
      NOW_SEC,
    );
    expect(view?.models).toEqual(["GLM-5.3-Flash"]);
    expect(view?.windows).toHaveLength(1);
  });
  it("active 套餐：plan + 按模型窗口 + 模型清单", () => {
    const view = normalizeStartPlanBalance(BALANCE_ACTIVE, NOW_SEC);
    expect(view).not.toBeUndefined();
    expect(view!.plan).toEqual({
      name: "Start Plan",
      planId: "zcode-v3-start-plan",
      status: "active",
      endsAt: new Date((NOW_SEC + 86_400) * 1000).toISOString(),
    });
    expect(view!.models).toEqual(["GLM-5.3", "GLM-5.3-Flash"]);
    expect(view!.expired).toBe(false);
    expect(view!.windows).toHaveLength(2);
    expect(view!.windows[0]).toMatchObject({
      label: "GLM-5.3",
      percent: (1_000_000 / 3_000_000) * 100,
      remaining: "2.0M/3.0M tokens",
      resetsAt: new Date((NOW_SEC + 3_600) * 1000).toISOString(),
    });
  });

  it("active 但 ends_at 已过：按过期处理，余额桶不再展示", () => {
    const payload = {
      ...BALANCE_ACTIVE,
      data: {
        ...BALANCE_ACTIVE.data,
        plans: [{ ...BALANCE_ACTIVE.data.plans[0]!, ends_at: NOW_SEC - 1 }],
      },
    };
    const view = normalizeStartPlanBalance(payload, NOW_SEC);
    expect(view).not.toBeUndefined();
    expect(view!.plan).toBeUndefined();
    expect(view!.expired).toBe(true);
    expect(view!.windows).toHaveLength(0);
    expect(view!.models).toEqual([]);
  });

  it("无套餐无余额的信封返回 undefined", () => {
    expect(normalizeStartPlanBalance({ code: 0, data: {} }, NOW_SEC)).toBeUndefined();
    expect(normalizeStartPlanBalance({ code: 401 }, NOW_SEC)).toBeUndefined();
    expect(normalizeStartPlanBalance("not-json", NOW_SEC)).toBeUndefined();
  });
});

describe("ZCode 可领取活动归一化", () => {
  it("preview plans → offers，grant_units 换算可读额度", () => {
    const offers = normalizeClaimOffers({
      code: 0,
      data: {
        plans: [
          {
            plan_id: "zcode-v3-trial-0929",
            name: "国庆体验包",
            description: "限时领取",
            entitlements: [
              {
                entitlement_id: "t1",
                show_name: "GLM-5.3",
                meter: "model_usage",
                unit_type: "token",
                capabilities: ["model:GLM-5.3"],
                grant_units: 3_000_000,
                period: "daily",
              },
              { entitlement_id: "t2", show_name: "无额度项" },
            ],
          },
        ],
      },
    });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toEqual({
      planId: "zcode-v3-trial-0929",
      name: "国庆体验包",
      description: "限时领取",
      entitlements: [{ model: "GLM-5.3", amount: "3.0M", unit: "token", period: "daily" }],
    });
  });

  it("空活动返回空数组", () => {
    expect(normalizeClaimOffers({ code: 0, data: { plans: [] } })).toEqual([]);
    expect(normalizeClaimOffers({ code: 3001 })).toEqual([]);
  });
});

describe("ZCode 平台配置归一化", () => {
  it("活动文案 zh 优先，验证码配置透出", () => {
    const configs = normalizeClientConfigs({
      code: 0,
      data: {
        configs: {
          codingPlanBillingDiscount: {
            "en-US": { badgeBody: "150% Quota", cardTitle: "Limited-time 150% Quota Campaign" },
            "zh-CN": {
              badgeBody: "150% 配额",
              cardTitle: "限时 150% 配额活动",
              infoBody: "额度消耗全周期按 0.67 系数折算。",
            },
          },
          captcha: { enabled: true, prefix: "no8xfe", sceneId: "11xygtvd", region: "cn" },
        },
      },
    });
    expect(configs.campaign).toEqual({
      badge: "150% 配额",
      title: "限时 150% 配额活动",
      info: "额度消耗全周期按 0.67 系数折算。",
    });
    expect(configs.captcha).toEqual({
      enabled: true,
      prefix: "no8xfe",
      sceneId: "11xygtvd",
      region: "cn",
    });
  });

  it("没有活动/验证码时为空对象", () => {
    expect(normalizeClientConfigs({ code: 0, data: { configs: {} } })).toEqual({});
    expect(normalizeClientConfigs({})).toEqual({});
  });
});

describe("领取活动结果归一化", () => {
  it("code=0 且带 plan 视为成功，透出套餐名与到期时间", () => {
    const result = normalizeClaimResult({
      code: 0,
      msg: "ok",
      data: {
        server_time: 1_759_000_000,
        plan: { plan_id: "zcode-v3-trial", name: "国庆体验包", ends_at: 1_759_100_000 },
      },
    });
    expect(result.success).toBe(true);
    expect(result.planName).toBe("国庆体验包");
    expect(result.endsAt).toBe(new Date(1_759_100_000 * 1000).toISOString());
    expect(result.code).toBeUndefined();
    expect(result.message).toBeUndefined();
  });

  it("失败透传上游 code 与 message；字符串数字 code 也归一化", () => {
    expect(normalizeClaimResult({ code: 1003, msg: "活动名额已用完", data: {} })).toMatchObject({
      success: false,
      code: 1003,
      message: "活动名额已用完",
    });
    expect(
      normalizeClaimResult({ code: "1002", data: { message: "验证码校验未通过" } }),
    ).toMatchObject({ success: false, code: 1002, message: "验证码校验未通过" });
    expect(normalizeClaimResult({})).toEqual({ success: false });
  });
});

const asFetch = (
  implementation: (input: string | URL, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch => implementation as unknown as typeof globalThis.fetch;

const runBalance = async (
  fetchImplementation: typeof globalThis.fetch,
  jwt: string,
): Promise<
  { ok: true; view: ReturnType<typeof normalizeStartPlanBalance> } | { ok: false; error: string }
> => {
  resetZCodeClientConfigsCacheForTest();
  // eslint-disable-next-line codework/no-manual-effect-runtime-in-tests
  return (await Effect.runPromise(
    Effect.gen(function* () {
      const view = yield* fetchZCodeStartPlanBalance(jwt);
      return { ok: true as const, view };
    }).pipe(
      Effect.catch((detail) => Effect.succeed({ ok: false as const, error: detail })),
      Effect.provide(
        FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchImplementation)),
        ),
      ),
    ),
  )) as Awaited<ReturnType<typeof runBalance>>;
};

describe("ZCode 体验套餐余额请求", () => {
  it("Bearer JWT 鉴权并携带 app_version，响应归一化", async () => {
    const requests: Array<{ url: string; auth?: string }> = [];
    const result = await runBalance(
      asFetch((input, init) => {
        const auth = new Headers(init?.headers).get("authorization");
        requests.push({
          url: String(input),
          ...(typeof auth === "string" ? { auth } : {}),
        });
        return Promise.resolve(new Response(JSON.stringify(BALANCE_ACTIVE), { status: 200 }));
      }),
      "jwt-token",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.view?.models).toEqual(["GLM-5.3", "GLM-5.3-Flash"]);
    }
    expect(requests[0]!.url).toBe(
      `https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=${ZCODE_APP_VERSION}`,
    );
    expect(requests[0]!.auth).toBe("Bearer jwt-token");
  });

  it("401 归一化为重新登录提示", async () => {
    const result = await runBalance(
      asFetch(() => Promise.resolve(new Response("unauthorized", { status: 401 }))),
      "expired-jwt",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("重新登录");
  });
});

describe("领取活动请求", () => {
  it.effect("POST claim 带 Bearer JWT 与验证码头，成功结果归一化", () =>
    Effect.gen(function* () {
      const requests: Array<{
        url: string;
        method?: string;
        auth?: string;
        captcha?: string;
        region?: string;
        body?: string;
      }> = [];
      const outcome = yield* fetchZCodeClaimOffer({
        jwt: "jwt-token",
        planId: "zcode-v3-trial-0929",
        captchaVerifyParam: "captcha-param-1",
        captchaRegion: "cn",
      }).pipe(
        Effect.provide(
          FetchHttpClient.layer.pipe(
            Layer.provide(
              Layer.succeed(
                FetchHttpClient.Fetch,
                asFetch((input, init) => {
                  const headers = new Headers(init?.headers);
                  const rawBody = init?.body;
                  const bodyText =
                    typeof rawBody === "string"
                      ? rawBody
                      : rawBody instanceof Uint8Array
                        ? new TextDecoder().decode(rawBody)
                        : undefined;
                  requests.push({
                    url: String(input),
                    ...(typeof init?.method === "string" ? { method: init.method } : {}),
                    ...(headers.has("authorization")
                      ? { auth: headers.get("authorization")! }
                      : {}),
                    ...(headers.has("x-aliyun-captcha-verify-param")
                      ? { captcha: headers.get("x-aliyun-captcha-verify-param")! }
                      : {}),
                    ...(headers.has("x-aliyun-captcha-verify-region")
                      ? { region: headers.get("x-aliyun-captcha-verify-region")! }
                      : {}),
                    ...(bodyText === undefined ? {} : { body: bodyText }),
                  });
                  return Promise.resolve(
                    new Response(
                      JSON.stringify({
                        code: 0,
                        msg: "ok",
                        data: {
                          plan: { plan_id: "zcode-v3-trial-0929", name: "国庆体验包" },
                        },
                      }),
                      { status: 200 },
                    ),
                  );
                }),
              ),
            ),
          ),
        ),
      );
      expect(outcome).toMatchObject({ success: true, planName: "国庆体验包" });
      expect(requests[0]?.url).toBe(`${ZCODE_ORIGIN_TEST}/api/v1/zcode-plan/billing/claim`);
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.auth).toBe("Bearer jwt-token");
      expect(requests[0]?.captcha).toBe("captcha-param-1");
      expect(requests[0]?.region).toBe("cn");
      expect(requests[0]?.body).toBe(JSON.stringify({ plan_id: "zcode-v3-trial-0929" }));
    }),
  );

  it.effect("上游失败码原样回传，不抛错", () =>
    Effect.gen(function* () {
      const outcome = yield* fetchZCodeClaimOffer({
        jwt: "jwt-token",
        planId: "p",
        captchaVerifyParam: "captcha-param-1",
      }).pipe(
        Effect.provide(
          FetchHttpClient.layer.pipe(
            Layer.provide(
              Layer.succeed(
                FetchHttpClient.Fetch,
                asFetch(() =>
                  Promise.resolve(
                    new Response(JSON.stringify({ code: 1002, msg: "验证码校验未通过" }), {
                      status: 200,
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      expect(outcome).toMatchObject({ success: false, code: 1002, message: "验证码校验未通过" });
    }),
  );
});
