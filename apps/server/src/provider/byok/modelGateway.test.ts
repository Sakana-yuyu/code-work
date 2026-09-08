// @effect-diagnostics nodeBuiltinImport:off - 使用真实 TCP 上游验证网络转发。
import { describe, expect, it } from "@effect/vitest";
import * as NodeHttp from "node:http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpRouter } from "effect/unstable/http";

import {
  DEFAULT_SERVER_SETTINGS,
  ServerSettingsError,
  type ServerProvider,
  type ServerSettings,
} from "@codework/contracts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { layerTest } from "../../serverSettings.ts";

import {
  anthropicGatewayEnv,
  applyRoutedProviderAvailability,
  byokGatewayRouteLayer,
  extractGatewayUsageLine,
  gatewayAdapterRoutes,
  gatewayCodexConfigArgs,
  gatewayOrigin,
  grokGatewayConfigBlock,
  joinAnthropicTarget,
  joinOpenAITarget,
  isRetryableLocalGatewayStatus,
  mergeGrokManagedConfig,
  openCodeGatewayConfigContent,
  pickGatewayAdapter,
  prepareRoutedProviderSnapshot,
  routedServerProviderModels,
  rewriteGatewayModel,
  tapGatewayUsageStream,
  type GatewayUsageTotals,
} from "./modelGateway.ts";

const settingsWithInstances = (
  instances: Record<string, { driver: string; enabled: boolean; config: unknown }>,
): ServerSettings =>
  ({
    providerInstances: instances,
  }) as unknown as ServerSettings;

const byokConfig = (adapters: readonly Record<string, unknown>[]): unknown => ({
  enabled: true,
  adapters,
});

const adapter = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "adapter-1",
  displayName: "Adapter One",
  groupName: "",
  protocol: "anthropic",
  baseURL: "https://relay.example/anthropic",
  apiKey: "sk-relay",
  apiKeyRedacted: false,
  modelId: "relay-model",
  contextWindowTokens: 128000,
  supplierID: "custom",
  ...overrides,
});

describe("gatewayAdapterRoutes", () => {
  it("旧版 BYOK 配置仍可路由，显式停用优先于旧配置", () => {
    const legacy = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: { ...DEFAULT_SERVER_SETTINGS.providers, byok: byokConfig([adapter()]) },
    } as ServerSettings;
    expect(gatewayAdapterRoutes(legacy, "byok").map((route) => route.id)).toEqual(["adapter-1"]);
    expect(
      gatewayAdapterRoutes({
        ...legacy,
        ...settingsWithInstances({
          byok: { driver: "byok", enabled: false, config: byokConfig([adapter()]) },
        }),
      }),
    ).toEqual([]);
  });
  it("用上游模型名替换内部渠道 ID，保留流式请求和其他字段", () => {
    const body = {
      model: "adapter-id[1m]",
      stream: true,
      input: [{ role: "user", content: "test" }],
    };
    expect(JSON.parse(rewriteGatewayModel(JSON.stringify(body), "actual-model"))).toEqual({
      ...body,
      model: "actual-model",
    });
    expect(rewriteGatewayModel('{"input":"test"}', "actual-model")).toBe('{"input":"test"}');
    expect(rewriteGatewayModel("invalid json", "actual-model")).toBe("invalid json");
  });
  it("collects routable adapters from enabled byok instances", () => {
    const routes = gatewayAdapterRoutes(
      settingsWithInstances({
        byok: {
          driver: "byok",
          enabled: true,
          config: byokConfig([
            adapter(),
            adapter({ id: "adapter-2", protocol: "openai", baseURL: "https://api.example/v1" }),
          ]),
        },
        disabled: { driver: "byok", enabled: false, config: byokConfig([adapter({ id: "x" })]) },
        other: { driver: "codex", enabled: true, config: byokConfig([adapter({ id: "y" })]) },
      }),
    );

    expect(routes.map((route) => route.id)).toEqual(["adapter-1", "adapter-2"]);
    expect(routes[0]?.apiKey).toBe("sk-relay");
  });

  it("drops adapters without credentials or a gateway protocol", () => {
    const routes = gatewayAdapterRoutes(
      settingsWithInstances({
        byok: {
          driver: "byok",
          enabled: true,
          config: byokConfig([
            adapter({ apiKey: "" }),
            adapter({ baseURL: "  " }),
            adapter({ id: "gem", protocol: "gemini" }),
          ]),
        },
      }),
    );

    expect(routes).toEqual([]);
  });

  it("skips disabled byok instances and undecodable configs", () => {
    const routes = gatewayAdapterRoutes(
      settingsWithInstances({
        broken: { driver: "byok", enabled: true, config: { adapters: "nope" } },
        off: {
          driver: "byok",
          enabled: false,
          config: byokConfig([adapter()]),
        },
      }),
    );

    expect(routes).toEqual([]);
  });

  it("publishes a local official-account route without an external relay", () => {
    const settings = {
      ...settingsWithInstances({
        codex: { driver: "codex", enabled: true, config: {} },
      }),
      localAccountPool: {
        accounts: {
          personal: {
            id: "personal",
            provider: "codex",
            displayName: "Personal",
            credentialRef: "secret",
            enabled: true,
            models: ["gpt-5.4"],
          },
        },
        strategy: "round-robin",
        providerInstances: { codex: ["personal"] },
      },
    } as ServerSettings;
    const route = gatewayAdapterRoutes(settings, "codex")[0];
    expect(route?.supplierID).toBe("codework-local-account");
    expect(route?.localProvider).toBe("codex");
    expect(route?.id).toBe("local:codex:codex:gpt-5.4");
    expect(
      pickGatewayAdapter(
        gatewayAdapterRoutes(settings, "codex"),
        "openai",
        "local:codex:codex:gpt-5.4",
      )?.localProvider,
    ).toBe("codex");
    expect(
      pickGatewayAdapter(gatewayAdapterRoutes(settings, "codex"), "openai", "gpt-5.4"),
    ).toBeUndefined();
  });
  it("旧版 providers.codex 只有默认实例时也能发布本地账号路由", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {},
      providers: { ...DEFAULT_SERVER_SETTINGS.providers, codex: { enabled: true } },
      localAccountPool: {
        accounts: {
          personal: {
            id: "personal",
            provider: "codex",
            displayName: "Personal",
            credentialRef: "secret",
            enabled: true,
            models: ["gpt-5.4"],
          },
        },
        strategy: "round-robin",
        providerInstances: { codex: ["personal"] },
      },
    } as unknown as ServerSettings;
    expect(gatewayAdapterRoutes(settings, "codex").map((route) => route.id)).toEqual([
      "local:codex:codex:gpt-5.4",
    ]);
  });

  it("没有声明模型的官方 OAuth 账号会按请求模型生成本地路由", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        codex: { driver: "codex", enabled: true, config: {} },
      },
      localAccountPool: {
        accounts: {
          oauth: {
            id: "oauth",
            provider: "codex",
            authKind: "oauth",
            displayName: "OAuth",
            credentialRef: "oauth-secret",
            enabled: true,
            models: [],
          },
        },
        strategy: "round-robin",
        providerInstances: { codex: ["oauth"] },
      },
    } as unknown as ServerSettings;

    const routes = gatewayAdapterRoutes(settings, "codex", "gpt-5.4");
    expect(routes.map((route) => route.id)).toEqual(["local:codex:codex:gpt-5.4"]);
    expect(pickGatewayAdapter(routes, "openai", "local:codex:codex:gpt-5.4")?.localProvider).toBe(
      "codex",
    );
  });
  it("不为 OpenCode 发布无法使用 Codex OAuth 的 Chat Completions 路由", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: { opencode: { driver: "opencode", enabled: true, config: {} } },
      localAccountPool: {
        accounts: {
          oauth: {
            id: "oauth",
            provider: "codex",
            authKind: "oauth",
            displayName: "OAuth",
            credentialRef: "oauth-secret",
            enabled: true,
            models: ["oauth-model"],
          },
          api: {
            id: "api",
            provider: "codex",
            authKind: "api-key",
            displayName: "API",
            credentialRef: "api-secret",
            enabled: true,
            models: ["api-model"],
          },
        },
        strategy: "round-robin",
        providerInstances: { opencode: ["oauth", "api"] },
      },
    } as unknown as ServerSettings;
    expect(gatewayAdapterRoutes(settings, "opencode").map((route) => route.modelId)).toEqual([
      "api-model",
    ]);
  });
});

describe("pickGatewayAdapter", () => {
  const routes = [
    ...gatewayAdapterRoutes(
      settingsWithInstances({
        byok: { driver: "byok", enabled: true, config: byokConfig([adapter()]) },
      }),
    ),
  ];

  it("matches by adapter id within the protocol", () => {
    expect(pickGatewayAdapter(routes, "anthropic", "adapter-1")?.baseURL).toBe(
      "https://relay.example/anthropic",
    );
    expect(pickGatewayAdapter(routes, "openai", "adapter-1")).toBeUndefined();
    expect(pickGatewayAdapter(routes, "anthropic", "relay-model")).toBeUndefined();
  });

  it("accepts Claude's trailing context-window qualifier on the slug", () => {
    expect(pickGatewayAdapter(routes, "anthropic", "adapter-1[1m]")?.id).toBe("adapter-1");
    // Only one trailing bracket group is stripped; ids never contain brackets,
    // so anything else stays a strict mismatch.
    expect(pickGatewayAdapter(routes, "anthropic", "adapter-[1]1")).toBeUndefined();
    expect(pickGatewayAdapter(routes, "anthropic", "adapter-1[m")).toBeUndefined();
  });
});

describe("target joins", () => {
  it("passes anthropic paths through verbatim", () => {
    expect(joinAnthropicTarget("https://relay.example/anthropic", "/v1/messages?beta=true")).toBe(
      "https://relay.example/anthropic/v1/messages?beta=true",
    );
    expect(
      joinAnthropicTarget("https://relay.example/anthropic", "/v1/messages/count_tokens"),
    ).toBe("https://relay.example/anthropic/v1/messages/count_tokens");
  });

  it("strips the leading v1 for openai targets so it is not doubled", () => {
    expect(joinOpenAITarget("https://api.example/v1", "/v1/chat/completions")).toBe(
      "https://api.example/v1/chat/completions",
    );
    expect(joinOpenAITarget("https://api.example", "/chat/completions")).toBe(
      "https://api.example/chat/completions",
    );
    // Only a path-leading v1 is stripped, never a v1 elsewhere.
    expect(joinOpenAITarget("https://api.example/v1", "/v1/models/v1")).toBe(
      "https://api.example/v1/models/v1",
    );
  });
});

describe("local gateway failover", () => {
  it("只对鉴权、限流和服务端失败换号", () => {
    expect([401, 403, 429, 500, 503].every(isRetryableLocalGatewayStatus)).toBe(true);
    expect([200, 400, 404].some(isRetryableLocalGatewayStatus)).toBe(false);
  });
});

describe("injection builders", () => {
  it("builds claude env vars from the loopback origin", () => {
    expect(anthropicGatewayEnv(gatewayOrigin(3773), "tok")).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:3773/byok-gw/anthropic",
      ANTHROPIC_AUTH_TOKEN: "tok",
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
    });
  });

  it("builds codex -c overrides with quoted TOML values", () => {
    const args = gatewayCodexConfigArgs("http://127.0.0.1:3773");
    expect(args).toContain('model_provider="byok_gateway"');
    expect(args).toContain(
      'model_providers.byok_gateway.base_url="http://127.0.0.1:3773/byok-gw/openai/v1"',
    );
    expect(args).toContain('model_providers.byok_gateway.wire_api="responses"');
    expect(args).toContain("model_providers.byok_gateway.requires_openai_auth=false");
  });

  it("merges the gateway provider into opencode config content", () => {
    const content = openCodeGatewayConfigContent({
      existingContent: '{"theme":"dark"}',
      origin: "http://127.0.0.1:3773",
      token: "tok",
      routes: [
        {
          id: "adapter-2",
          protocol: "openai",
          baseURL: "https://api.example/v1",
          apiKey: "sk",
          displayName: "Relay Model",
          modelId: "relay-model",
          groupName: "",
        },
        {
          id: "adapter-1",
          protocol: "anthropic",
          baseURL: "https://relay.example/anthropic",
          apiKey: "sk",
          displayName: "A",
          modelId: "m",
          groupName: "",
        },
      ],
    });
    const parsed = JSON.parse(content) as {
      theme?: string;
      provider: Record<
        string,
        {
          options: { baseURL: string; apiKey: string };
          models: Record<string, { name: string }>;
        }
      >;
    };

    expect(parsed.theme).toBe("dark");
    const gateway = parsed.provider.byok_gateway;
    if (gateway === undefined) throw new Error("gateway provider missing");
    expect(gateway.options.baseURL).toBe("http://127.0.0.1:3773/byok-gw/openai/v1");
    expect(gateway.options.apiKey).toBe("tok");
    // Only openai-protocol adapters are exposed to opencode.
    expect(Object.keys(gateway.models)).toEqual(["adapter-2"]);
    expect(gateway.models["adapter-2"]?.name).toBe("Relay Model");
  });
});

describe("gatewayAdapterRoutes groupName", () => {
  it("carries the trimmed group label and defaults to empty", () => {
    const routes = gatewayAdapterRoutes(
      settingsWithInstances({
        byok: {
          driver: "byok",
          enabled: true,
          config: byokConfig([
            adapter({ groupName: "  DeepSeek官方 " }),
            adapter({ id: "adapter-2", protocol: "openai", baseURL: "https://api.example/v1" }),
          ]),
        },
      }),
    );

    expect(routes[0]?.groupName).toBe("DeepSeek官方");
    expect(routes[1]?.groupName).toBe("");
  });
});

describe("routedServerProviderModels", () => {
  it("prefers the group label and falls back to the raw model id", () => {
    const models = routedServerProviderModels(
      settingsWithInstances({
        byok: {
          driver: "byok",
          enabled: true,
          config: byokConfig([
            adapter({ groupName: "DeepSeek官方" }),
            adapter({
              id: "adapter-2",
              protocol: "openai",
              baseURL: "https://api.example/v1",
              modelId: "deepseek-v4-flash",
            }),
          ]),
        },
      }),
      "anthropic",
    );

    expect(models.find((model) => model.slug === "adapter-1")?.subProvider).toBe("DeepSeek官方");
    expect(models.find((model) => model.slug === "adapter-2")?.subProvider).toBeUndefined();
  });
});

describe("prepareRoutedProviderSnapshot", () => {
  const native = {
    driver: "codex",
    installed: true,
    status: "ready",
    models: [{ slug: "gpt-6-astra", name: "GPT-6-Astra", isCustom: false, capabilities: null }],
  } as unknown as ServerProvider;
  const settings = settingsWithInstances({
    selected: {
      driver: "byok",
      enabled: true,
      config: byokConfig([
        adapter({ id: "openai-route", protocol: "openai", modelId: "gemini-3.8-flash" }),
        adapter({ id: "anthropic-route", protocol: "anthropic" }),
      ]),
    },
    unrelated: {
      driver: "byok",
      enabled: true,
      config: byokConfig([adapter({ id: "other-route", protocol: "openai" })]),
    },
  });
  it.effect.each([
    ["codex", "openai-route"],
    ["claudeAgent", "anthropic-route"],
    ["grok", "openai-route"],
    ["opencode", "byok_gateway/openai-route"],
  ])("%s 仅保留所选共享渠道与协议的模型", ([driver, slug]) =>
    Effect.gen(function* () {
      const result = yield* prepareRoutedProviderSnapshot(
        { ...native, driver: driver as ServerProvider["driver"] },
        { routeThroughByok: true, byokSourceInstanceId: "selected" },
        Effect.succeed(settings),
      );
      expect(result.models.map((model) => model.slug)).toEqual([slug]);
      expect(result.auth.type).toBe("byok");
    }),
  );
  it.effect("原生连接保留目录，渠道缺失或读取失败时不回退原生模型", () =>
    Effect.gen(function* () {
      expect(
        yield* prepareRoutedProviderSnapshot(
          native,
          { routeThroughByok: false },
          Effect.succeed(settings),
        ),
      ).toBe(native);
      for (const getSettings of [
        Effect.succeed(settings),
        Effect.fail(
          new ServerSettingsError({
            settingsPath: "/test/settings.json",
            operation: "read-file",
            cause: "test unavailable",
          }),
        ),
      ]) {
        const result = yield* prepareRoutedProviderSnapshot(
          native,
          { routeThroughByok: true, byokSourceInstanceId: "missing" },
          getSettings,
        );
        expect(result.models).toEqual([]);
      }
    }),
  );
});

describe("applyRoutedProviderAvailability", () => {
  const base = {
    displayName: "Codex",
    enabled: true,
    installed: true,
    status: "error" as const,
    checkedAt: "2026-09-06T00:00:00.000Z",
    models: [],
  };
  it("网关接管时原生登录探测不再把实例标记为不可用", () => {
    const snapshot = applyRoutedProviderAvailability({
      ...base,
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
      auth: { status: "unauthenticated" as const },
    } as unknown as ServerProvider);
    expect(snapshot.status).toBe("ready");
    expect(snapshot.message).toBeUndefined();
    expect(snapshot.auth).toEqual({ status: "unauthenticated" });
  });
  it("未安装或已停用的实例保持探测结果", () => {
    const notInstalled = applyRoutedProviderAvailability({
      ...base,
      installed: false,
    } as unknown as ServerProvider);
    expect(notInstalled.status).toBe("error");
    const disabled = applyRoutedProviderAvailability({
      ...base,
      status: "disabled",
    } as unknown as ServerProvider);
    expect(disabled.status).toBe("disabled");
  });
});

describe("grokGatewayConfigBlock", () => {
  it("emits one quoted model table per openai adapter with the gateway endpoint", () => {
    const routes = gatewayAdapterRoutes(
      settingsWithInstances({
        byok: {
          driver: "byok",
          enabled: true,
          config: byokConfig([
            adapter({
              groupName: "DeepSeek官方",
              protocol: "openai",
              baseURL: "https://api.example/v1",
            }),
            adapter({ id: "adapter-2", protocol: "anthropic" }),
          ]),
        },
      }),
    );

    const block = grokGatewayConfigBlock("http://127.0.0.1:3773", routes);

    expect(block).toContain("# >>> codework-byok >>>");
    expect(block).toContain('[model."adapter-1"]');
    expect(block).toContain('base_url = "http://127.0.0.1:3773/byok-gw/openai/v1"');
    expect(block).toContain(`env_key = "CODEWORK_BYOK_GATEWAY_TOKEN"`);
    expect(block).not.toContain("adapter-2");
    expect(block).toContain("# <<< codework-byok <<<");
  });
});

describe("mergeGrokManagedConfig", () => {
  it("appends the managed block to user content and replaces a previous block", () => {
    const block = grokGatewayConfigBlock("http://127.0.0.1:3773", []);

    const appended = mergeGrokManagedConfig('[models]\ndefault = "mine"\n', block);
    expect(appended).toContain('[models]\ndefault = "mine"');
    expect(appended).toContain("# >>> codework-byok >>>");

    const replaced = mergeGrokManagedConfig(
      appended,
      "# >>> codework-byok >>> (managed by Code Work)\nreplacement\n# <<< codework-byok <<<",
    );
    expect(replaced).toContain("replacement");
    expect(replaced.match(/# >>> codework-byok >>>/g)).toHaveLength(1);
    expect(replaced).toContain('[models]\ndefault = "mine"');
  });

  it("strips only the managed region when the block is null and preserves user content", () => {
    const withBlock = mergeGrokManagedConfig(
      "user-stuff",
      ["# >>> codework-byok >>> (managed by Code Work)", "MANAGED", "# <<< codework-byok <<<"].join(
        "\n",
      ),
    );
    const stripped = mergeGrokManagedConfig(withBlock, null);

    expect(stripped).toContain("user-stuff");
    expect(stripped).not.toContain("MANAGED");

    expect(mergeGrokManagedConfig(undefined, null)).toBe("");
  });
});

it("共享线路严格隔离，真实 HTTP 转发保留模型映射、流和限流错误", async () => {
  const calls: {
    url: string;
    authorization: string | undefined;
    apiKey: string | string[] | undefined;
    body: unknown;
  }[] = [];
  const upstream = NodeHttp.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    calls.push({
      url: request.url ?? "",
      authorization: request.headers.authorization,
      apiKey: request.headers["x-api-key"],
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    if (request.url?.includes("limited")) {
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "7",
        "x-request-id": "fixture-request",
      });
      response.end('{"error":{"message":"rate limited"}}');
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"delta":"hello"}\n\n');
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (address === null || typeof address === "string") throw new Error("测试端口未绑定");
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  const settings = settingsWithInstances({
    team: {
      driver: "byok",
      enabled: true,
      config: byokConfig([
        adapter({
          id: "same-id",
          protocol: "openai",
          baseURL,
          modelId: "team-model",
          apiKey: "team-key",
        }),
        adapter({
          id: "claude-id",
          baseURL: baseURL.replace(/\/v1$/, ""),
          modelId: "claude-model",
          apiKey: "claude-key",
        }),
      ]),
    },
    personal: {
      driver: "byok",
      enabled: true,
      config: byokConfig([
        adapter({
          id: "same-id",
          protocol: "openai",
          baseURL,
          modelId: "personal-model",
          apiKey: "personal-key",
        }),
        adapter({ id: "private-id", protocol: "openai", baseURL }),
      ]),
    },
  });
  const unused = () => Effect.die("不应调用此密钥操作");
  const token = Buffer.alloc(32, 1).toString("hex");
  const { handler, dispose } = HttpRouter.toWebHandler(
    byokGatewayRouteLayer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          FetchHttpClient.layer,
          layerTest({ ...DEFAULT_SERVER_SETTINGS, ...settings }),
          Layer.succeed(ServerSecretStore, {
            get: unused,
            set: unused,
            create: unused,
            remove: unused,
            getOrCreateRandom: () => Effect.succeed(Buffer.alloc(32, 1)),
          }),
        ),
      ),
    ),
    { disableLogger: true },
  );
  const request = (path: string, model?: string, authorized = true) =>
    handler(
      new Request(`http://localhost/byok-gw/${path}`, {
        method: model === undefined ? "GET" : "POST",
        headers: {
          ...(authorized ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
        },
        ...(model === undefined
          ? {}
          : { body: JSON.stringify({ model, stream: true, input: "test" }) }),
      }),
    );
  try {
    expect((await request("openai/source/team/v1/models", undefined, false)).status).toBe(401);
    expect(await (await request("openai/source/team/v1/models")).json()).toMatchObject({
      data: [{ id: "same-id" }],
    });
    expect((await request("openai/source/team/v1/responses", "private-id")).status).toBe(404);
    expect((await request("openai/source/missing/v1/responses", "same-id")).status).toBe(404);
    expect(calls).toHaveLength(0);
    const response = await request("openai/source/personal/v1/responses?beta=1", "same-id");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toBe('data: {"delta":"hello"}\n\ndata: [DONE]\n\n');
    expect(calls[0]).toEqual({
      url: "/v1/responses?beta=1",
      authorization: "Bearer personal-key",
      apiKey: undefined,
      body: { model: "personal-model", stream: true, input: "test" },
    });
    const limited = await request("openai/source/team/v1/limited", "same-id");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("7");
    expect(limited.headers.get("x-request-id")).toBe("fixture-request");
    expect(await limited.json()).toEqual({ error: { message: "rate limited" } });
    await (await request("anthropic/source/team/v1/messages", "claude-id[1m]")).text();
    expect(calls[2]).toMatchObject({
      url: "/v1/messages",
      authorization: undefined,
      apiKey: "claude-key",
      body: { model: "claude-model" },
    });
    expect(anthropicGatewayEnv("http://localhost", "key", "team").ANTHROPIC_BASE_URL).toBe(
      "http://localhost/byok-gw/anthropic/source/team",
    );
    expect(gatewayCodexConfigArgs("http://localhost", "team")).toContain(
      'model_providers.byok_gateway.base_url="http://localhost/byok-gw/openai/source/team/v1"',
    );
  } finally {
    await dispose();
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

describe("extractGatewayUsageLine", () => {
  it("解析 Anthropic message_start/message_delta，忽略其余事件", () => {
    expect(
      extractGatewayUsageLine(
        "anthropic",
        JSON.stringify({
          type: "message_start",
          message: {
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 5,
              cache_creation_input_tokens: 2,
              output_tokens: 0,
            },
          },
        }),
      ),
    ).toEqual({ inputTokens: 17, outputTokens: 0 });
    expect(
      extractGatewayUsageLine(
        "anthropic",
        JSON.stringify({ type: "message_delta", usage: { output_tokens: 42 } }),
      ),
    ).toEqual({ inputTokens: 0, outputTokens: 42 });
    expect(extractGatewayUsageLine("anthropic", JSON.stringify({ type: "ping" }))).toBeUndefined();
  });
  it("解析 OpenAI chat usage 与 Responses API response.usage", () => {
    expect(
      extractGatewayUsageLine(
        "openai",
        JSON.stringify({ usage: { prompt_tokens: 8, completion_tokens: 4 } }),
      ),
    ).toEqual({ inputTokens: 8, outputTokens: 4 });
    expect(
      extractGatewayUsageLine(
        "openai",
        JSON.stringify({ response: { usage: { input_tokens: 9, output_tokens: 3 } } }),
      ),
    ).toEqual({ inputTokens: 9, outputTokens: 3 });
    expect(extractGatewayUsageLine("openai", '"partial json"')).toBeUndefined();
  });
  it("tapGatewayUsageStream 原样透传字节并统计跨块的 SSE 行", async () => {
    const seen: GatewayUsageTotals[] = [];
    const chunks = [
      new TextEncoder().encode('data: {"type":"message_start","message":{"usage":{"inp'),
      new TextEncoder().encode(
        'ut_tokens":12}}}\n\ndata: {"type":"message_delta","usage":{"output_tok',
      ),
      new TextEncoder().encode('ens":7}}\n\ndata: [DONE]\n\n'),
    ];
    // eslint-disable-next-line codework/no-manual-effect-runtime-in-tests
    const passthrough = await Effect.runPromise(
      Stream.runCollect(
        tapGatewayUsageStream(Stream.fromIterable(chunks), "anthropic", (totals) =>
          seen.push(totals),
        ),
      ),
    );
    expect(Array.from(passthrough)).toEqual(chunks);
    expect(seen).toEqual([{ inputTokens: 12, outputTokens: 7 }]);
  });
});
