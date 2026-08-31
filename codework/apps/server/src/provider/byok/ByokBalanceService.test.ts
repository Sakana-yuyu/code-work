import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, ProviderDriverKind } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";

import * as ServerSettings from "../../serverSettings.ts";
import { make } from "./ByokBalanceService.ts";

const asFetch = (
  implementation: (input: string | URL, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch => implementation as unknown as typeof globalThis.fetch;

type Adapter = {
  readonly id: string;
  readonly displayName: string;
  readonly protocol: "openai" | "anthropic" | "gemini";
  readonly baseURL: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly contextWindowTokens: number;
  readonly supplierID?: string;
  readonly balanceProfile?: "auto" | "general" | "newapi" | "none";
  readonly balanceAccessToken?: string;
  readonly balanceUserID?: string;
};

const makeSettings = (instanceId: string, adapters: ReadonlyArray<Adapter>) =>
  ({
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [instanceId]: {
        driver: ProviderDriverKind.make("byok"),
        enabled: true,
        config: { enabled: true, adapters },
      },
    },
  }) as typeof DEFAULT_SERVER_SETTINGS;

const testLayers = (
  settings: typeof DEFAULT_SERVER_SETTINGS,
  fetchImplementation: typeof globalThis.fetch,
) =>
  Layer.merge(
    Layer.succeed(ServerSettings.ServerSettingsService, {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Effect.succeed(settings),
      updateSettings: () => Effect.succeed(settings),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.succeed(Stream.empty),
    }),
    FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchImplementation)),
    ),
  );

const runBalance = async (
  settings: typeof DEFAULT_SERVER_SETTINGS,
  fetchImplementation: typeof globalThis.fetch,
  input: { instanceId: string; adapterId: string; forceRefresh?: boolean },
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* make;
      return yield* service.balance(input);
    }).pipe(Effect.provide(testLayers(settings, fetchImplementation))),
  );

const runDashboard = async (
  settings: typeof DEFAULT_SERVER_SETTINGS,
  fetchImplementation: typeof globalThis.fetch,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* make;
      return yield* service.dashboard({ forceRefresh: true });
    }).pipe(Effect.provide(testLayers(settings, fetchImplementation))),
  );

const adapter = (overrides: Partial<Adapter> = {}): Adapter => ({
  id: "adapter-balance",
  displayName: "Example model",
  protocol: "openai",
  baseURL: "https://balance.test/v1",
  apiKey: "sk-test-key",
  modelId: "example-model",
  contextWindowTokens: 128000,
  ...overrides,
});

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("ByokBalanceService", () => {
  it("normalizes an OpenAI-style billing subscription", async () => {
    const result = await runBalance(
      makeSettings("instance-1", [adapter()]),
      asFetch(async (input) => {
        const url = String(input);
        if (url.endsWith("/v1/dashboard/billing/subscription")) {
          return jsonResponse({ hard_limit_usd: 100 });
        }
        if (url.endsWith("/dashboard/billing/usage") || url.includes("billing/usage")) {
          return jsonResponse({ total_usage: 2500 });
        }
        return jsonResponse({ error: "not found" }, 404);
      }),
      { instanceId: "instance-1", adapterId: "adapter-balance" },
    );

    expect(result.supported).toBe(true);
    expect(result.source).toBe("openai_billing");
    expect(result.total).toBe(100);
    expect(result.remaining).toBe(75);
    // The normalized result never echoes the API key.
    expect(JSON.stringify(result)).not.toContain("sk-test-key");
  });

  it("normalizes a NewAPI quota payload", async () => {
    let seenAuthorization = "";
    let seenUserID = "";
    const result = await runBalance(
      makeSettings("instance-2", [
        adapter({
          balanceProfile: "newapi",
          baseURL: "https://newapi.test",
          balanceAccessToken: "napi-token",
          balanceUserID: "42",
        }),
      ]),
      asFetch(async (input, init) => {
        const headers = new Headers(init?.headers);
        seenAuthorization = headers.get("authorization") ?? "";
        seenUserID = headers.get("new-api-user") ?? "";
        return jsonResponse({
          success: true,
          data: { quota: 25_000_000, used_quota: 12_500_000, group: "default" },
        });
      }),
      { instanceId: "instance-2", adapterId: "adapter-balance" },
    );

    expect(result.supported).toBe(true);
    expect(result.source).toBe("newapi");
    expect(result.remaining).toBeCloseTo(50, 5);
    expect(result.planName).toBe("default");
    // The balance query prefers the dedicated balance token over the API key.
    expect(seenAuthorization).toBe("Bearer napi-token");
    expect(seenUserID).toBe("42");
  });

  it("queries DeepSeek's official balance endpoint for an official DeepSeek base URL", async () => {
    let seenURL = "";
    let seenAuthorization = "";
    const result = await runBalance(
      makeSettings("instance-deepseek", [
        adapter({
          baseURL: "https://api.deepseek.com/v1",
          modelId: "deepseek-chat",
          apiKey: "deepseek-test-key",
        }),
      ]),
      asFetch(async (input, init) => {
        seenURL = String(input);
        seenAuthorization = new Headers(init?.headers).get("authorization") ?? "";
        return jsonResponse({
          is_available: true,
          balance_infos: [{ currency: "CNY", total_balance: "18.25" }],
        });
      }),
      { instanceId: "instance-deepseek", adapterId: "adapter-balance" },
    );

    expect(seenURL).toBe("https://api.deepseek.com/user/balance");
    expect(seenAuthorization).toBe("Bearer deepseek-test-key");
    expect(result).toMatchObject({
      supported: true,
      source: "deepseek",
      currency: "CNY",
      remaining: 18.25,
    });
    expect(JSON.stringify(result)).not.toContain("deepseek-test-key");
  });

  it("does not route a lookalike host to DeepSeek's official balance endpoint", async () => {
    const requestedURLs: string[] = [];
    await runBalance(
      makeSettings("instance-lookalike", [
        adapter({ baseURL: "https://api.deepseek.com.example.test/v1" }),
      ]),
      asFetch(async (input) => {
        requestedURLs.push(String(input));
        if (String(input).endsWith("/v1/dashboard/billing/subscription")) {
          return jsonResponse({ hard_limit_usd: 10 });
        }
        if (String(input).includes("billing/usage")) return jsonResponse({ total_usage: 0 });
        return jsonResponse({ error: "not found" }, 404);
      }),
      { instanceId: "instance-lookalike", adapterId: "adapter-balance" },
    );

    expect(requestedURLs).not.toContain("https://api.deepseek.com/user/balance");
  });

  it("reports native gemini adapters as unsupported without any request", async () => {
    const result = await runBalance(
      makeSettings("instance-3", [
        adapter({
          protocol: "gemini",
          baseURL: "https://generativelanguage.googleapis.com/v1beta",
        }),
      ]),
      asFetch(async () => {
        throw new Error("gemini balance must not issue requests");
      }),
      { instanceId: "instance-3", adapterId: "adapter-balance" },
    );

    expect(result.supported).toBe(false);
    expect(result.error?.code).toBe("unsupported_profile");
  });

  it("reports missing credentials without leaking anything", async () => {
    const result = await runBalance(
      makeSettings("instance-3", [adapter({ apiKey: "" })]),
      asFetch(async () => {
        throw new Error("should not fetch");
      }),
      { instanceId: "instance-3", adapterId: "adapter-balance" },
    );

    expect(result.supported).toBe(false);
    expect(result.error?.code).toBe("missing_credentials");
  });

  it("returns a deterministic failure for the none profile", async () => {
    const result = await runBalance(
      makeSettings("instance-4", [adapter({ balanceProfile: "none" })]),
      asFetch(async () => {
        throw new Error("should not fetch");
      }),
      { instanceId: "instance-4", adapterId: "adapter-balance" },
    );

    expect(result.supported).toBe(false);
    expect(result.error?.code).toBe("unsupported_profile");
  });

  it("dashboard 聚合全部 BYOK 实例并区分 ok/unsupported/error，不泄漏密钥", async () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        "byok-main": {
          driver: ProviderDriverKind.make("byok"),
          displayName: "主账号",
          enabled: true,
          config: {
            enabled: true,
            adapters: [
              adapter({ id: "adapter-ok", displayName: "OK 模型" }),
              adapter({
                id: "adapter-gemini",
                displayName: "Gemini",
                protocol: "gemini",
                baseURL: "https://generativelanguage.googleapis.com/v1beta",
              }),
              adapter({
                id: "adapter-broken",
                displayName: "坏端点",
                baseURL: "https://broken.test/v1",
              }),
            ],
          },
        },
        codex: { driver: ProviderDriverKind.make("codex"), enabled: true, config: {} },
      },
    } as typeof DEFAULT_SERVER_SETTINGS;

    const result = await runDashboard(
      settings,
      asFetch(async (input) => {
        const url = String(input);
        if (url.startsWith("https://broken.test")) {
          return jsonResponse({ error: "boom" }, 500);
        }
        if (url.endsWith("/v1/dashboard/billing/subscription")) {
          return jsonResponse({ hard_limit_usd: 100 });
        }
        if (url.includes("billing/usage")) {
          return jsonResponse({ total_usage: 2500 });
        }
        return jsonResponse({ error: "boom" }, 500);
      }),
    );

    // 非 byok 实例不参与看板。
    expect(result.totals.instanceCount).toBe(1);
    expect(result.totals.adapterCount).toBe(3);
    const instance = result.instances[0];
    expect(instance?.instanceId).toBe("byok-main");
    expect(instance?.displayName).toBe("主账号");
    expect(instance?.enabled).toBe(true);
    const byId = new Map(instance?.adapters.map((entry) => [entry.adapterId, entry]));
    expect(byId.get("adapter-ok")?.health).toBe("ok");
    expect(byId.get("adapter-gemini")?.health).toBe("unsupported");
    // 三个 attempt 全部 500：查询失败保留结构化错误，不伪装成余额为空。
    expect(byId.get("adapter-broken")?.health).toBe("error");
    expect(byId.get("adapter-broken")?.balance.error?.code).toBe("upstream_http");
    expect(instance?.health).toBe("degraded");
    expect(JSON.stringify(result)).not.toContain("sk-test-key");
  });

  it("maps upstream HTTP failures to structured errors", async () => {
    const result = await runBalance(
      makeSettings("instance-5", [adapter()]),
      asFetch(async () => jsonResponse({ error: "unauthorized" }, 401)),
      { instanceId: "instance-5", adapterId: "adapter-balance" },
    );

    expect(result.supported).toBe(false);
    expect(result.error?.code).toBe("upstream_http");
  });
});

describe("ByokBalanceService dashboard", () => {
  it("仅有不支持余额查询的适配器时实例聚合为 unsupported", async () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        "dash-gemini": {
          driver: ProviderDriverKind.make("byok"),
          enabled: false,
          config: {
            enabled: false,
            adapters: [
              adapter({
                id: "gemini-adapter",
                protocol: "gemini",
                baseURL: "https://generativelanguage.googleapis.com/v1beta",
              }),
            ],
          },
        },
      },
    } as typeof DEFAULT_SERVER_SETTINGS;

    const result = await runDashboard(
      settings,
      asFetch(async () => {
        throw new Error("unsupported adapters must not issue requests");
      }),
    );

    const instance = result.instances[0];
    expect(instance?.health).toBe("unsupported");
    expect(instance?.enabled).toBe(false);
    expect(instance?.adapters[0]?.health).toBe("unsupported");
    expect(instance?.adapters[0]?.balance.error?.code).toBe("unsupported_profile");
  });
});
