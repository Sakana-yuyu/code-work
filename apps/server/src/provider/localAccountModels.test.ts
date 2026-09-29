// @effect-diagnostics preferSchemaOverJson:off - 测试构造各家官方接口的响应 JSON。
// @effect-diagnostics globalDate:off - 体验套餐余额夹具用真实墙上时间当基准。
// 拉取端点按 CLIProxyAPI fetch_codex_models 与各家 /v1/models 的响应形状造数据。
import { describe, expect, it } from "vite-plus/test";
import { LocalAccountId } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import {
  codexModelsFromPayload,
  fetchLocalAccountModels,
  openAiModelsFromPayload,
  zcodeModelsFromCatalog,
} from "./localAccountModels.ts";
import { resetZCodeClientConfigsCacheForTest } from "./zcode/zcodeStartPlan.ts";

const NOW_SEC = Math.floor(Date.now() / 1000);

const asFetch = (
  implementation: (input: string | URL, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch => implementation as unknown as typeof globalThis.fetch;

const runFetch = async (
  fetchImplementation: typeof globalThis.fetch,
  input: {
    readonly provider: "codex" | "claude" | "xai" | "cursor" | "zcode";
    readonly authKind?: "oauth" | "api-key";
    readonly credential?: Record<string, unknown>;
  },
) => {
  resetZCodeClientConfigsCacheForTest();
  // eslint-disable-next-line codework/no-manual-effect-runtime-in-tests
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* fetchLocalAccountModels({
        account: {
          id: LocalAccountId.make("a-1"),
          provider: input.provider,
          displayName: "测试账号",
          credentialRef: "secret-ref",
          enabled: true,
          models: [],
        },
        credential: input.credential ?? {},
        authKind: input.authKind ?? "oauth",
      });
    }).pipe(
      Effect.provide(
        FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchImplementation)),
        ),
      ),
    ),
  );
};

describe("模型目录解析", () => {
  it("codex：models[].slug 去重", () => {
    expect(
      codexModelsFromPayload({
        models: [{ slug: "gpt-5.6-sol" }, { slug: "gpt-5.5" }, { slug: "gpt-5.6-sol" }, {}],
      }),
    ).toEqual(["gpt-5.6-sol", "gpt-5.5"]);
    expect(codexModelsFromPayload({})).toEqual([]);
  });

  it("openai 风格：data[].id 去重", () => {
    expect(
      openAiModelsFromPayload({ data: [{ id: "claude-opus-5" }, { id: "claude-opus-5" }] }),
    ).toEqual(["claude-opus-5"]);
    expect(openAiModelsFromPayload({ error: { message: "nope" } })).toEqual([]);
  });

  it("zcode：官方目录在前，体验套餐 capabilities 补充去重", () => {
    expect(zcodeModelsFromCatalog(["GLM-5.3"], ["GLM-5.3", "GLM-5.3-Flash"])).toEqual([
      "GLM-5.3",
      "GLM-5.3-Flash",
    ]);
  });
});

describe("按账号拉取模型目录", () => {
  it("codex OAuth：打 backend-api/codex/models，带头 Originator 与账号 ID", async () => {
    const requests: Array<{ url: string; originator?: string; account?: string }> = [];
    const result = await runFetch(
      asFetch((input, init) => {
        const headers = new Headers(init?.headers);
        requests.push({
          url: String(input),
          ...(headers.has("originator") ? { originator: headers.get("originator")! } : {}),
          ...(headers.has("chatgpt-account-id")
            ? { account: headers.get("chatgpt-account-id")! }
            : {}),
        });
        return Promise.resolve(
          new Response(JSON.stringify({ models: [{ slug: "gpt-5.6-sol" }, { slug: "gpt-5.5" }] }), {
            status: 200,
          }),
        );
      }),
      {
        provider: "codex",
        authKind: "oauth",
        credential: { access_token: "tok", account_id: "acc-1" },
      },
    );
    expect(result).toEqual({ source: "provider", models: ["gpt-5.6-sol", "gpt-5.5"] });
    expect(requests[0]!.url).toContain("backend-api/codex/models?client_version=");
    expect(requests[0]!.originator).toBe("codex_cli_rs");
    expect(requests[0]!.account).toBe("acc-1");
  });

  it("codex OAuth：平台失败落静态目录", async () => {
    const result = await runFetch(
      asFetch(() => Promise.resolve(new Response("nope", { status: 500 }))),
      { provider: "codex", authKind: "oauth", credential: { access_token: "tok" } },
    );
    expect(result.source).toBe("catalog");
    expect(result.models.length).toBeGreaterThan(0);
  });

  it("claude API-Key：/v1/models 用 x-api-key 头", async () => {
    let apiKey: string | undefined;
    const result = await runFetch(
      asFetch((input, init) => {
        apiKey = new Headers(init?.headers).get("x-api-key") ?? undefined;
        return Promise.resolve(
          new Response(JSON.stringify({ data: [{ id: "claude-opus-5" }] }), { status: 200 }),
        );
      }),
      { provider: "claude", authKind: "api-key", credential: { api_key: "sk-ant" } },
    );
    expect(result).toEqual({ source: "provider", models: ["claude-opus-5"] });
    expect(apiKey).toBe("sk-ant");
  });

  it("xai API-Key：/v1/models 用 Bearer；OAuth 账号直接静态目录", async () => {
    const fetched = await runFetch(
      asFetch(() =>
        Promise.resolve(
          new Response(JSON.stringify({ data: [{ id: "grok-4.6" }] }), { status: 200 }),
        ),
      ),
      { provider: "xai", authKind: "api-key", credential: { api_key: "xai-key" } },
    );
    expect(fetched).toEqual({ source: "provider", models: ["grok-4.6"] });

    const oauth = await runFetch(
      asFetch(() => {
        throw new Error("OAuth 账号不应发起请求");
      }),
      { provider: "xai", authKind: "oauth", credential: { access_token: "tok" } },
    );
    expect(oauth.source).toBe("catalog");
  });

  it("zcode：官方目录 + 体验套餐余额 capabilities 合并", async () => {
    let balanceUrl = "";
    const result = await runFetch(
      asFetch((input) => {
        balanceUrl = String(input);
        return Promise.resolve(
          new Response(
            JSON.stringify({
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
                    total_units: 1,
                    used_units: 0,
                    remaining_units: 1,
                    expires_at: NOW_SEC + 3_600,
                  },
                ],
              },
            }),
            { status: 200 },
          ),
        );
      }),
      { provider: "zcode", credential: { zcode_jwt: "jwt-token" } },
    );
    expect(result.source).toBe("provider");
    expect(result.models).toContain("GLM-5.3");
    expect(result.models).toContain("GLM-5.2");
    expect(balanceUrl).toContain("zcode-plan/billing/balance");
  });

  it("zcode：余额接口失败仍回官方目录", async () => {
    const result = await runFetch(
      asFetch(() => Promise.resolve(new Response("", { status: 401 }))),
      {
        provider: "zcode",
        credential: { zcode_jwt: "expired" },
      },
    );
    expect(result.source).toBe("catalog");
    expect(result.models).toContain("GLM-5.3");
  });

  it("cursor：无接口，静态目录（空 = 不限模型）", async () => {
    const result = await runFetch(
      asFetch(() => {
        throw new Error("cursor 不应发起请求");
      }),
      { provider: "cursor" },
    );
    expect(result).toEqual({ source: "catalog", models: [] });
  });
});
