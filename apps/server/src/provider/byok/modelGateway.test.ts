import { describe, expect, it } from "vite-plus/test";

import type { ServerSettings } from "@codework/contracts";

import {
  anthropicGatewayEnv,
  gatewayAdapterRoutes,
  gatewayCodexConfigArgs,
  gatewayOrigin,
  grokGatewayConfigBlock,
  joinAnthropicTarget,
  joinOpenAITarget,
  mergeGrokManagedConfig,
  openCodeGatewayConfigContent,
  pickGatewayAdapter,
  routedServerProviderModels,
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

describe("injection builders", () => {
  it("builds claude env vars from the loopback origin", () => {
    expect(anthropicGatewayEnv(gatewayOrigin(3773), "tok")).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:3773/byok-gw/anthropic",
      ANTHROPIC_AUTH_TOKEN: "tok",
    });
  });

  it("builds codex -c overrides with quoted TOML values", () => {
    const args = gatewayCodexConfigArgs("http://127.0.0.1:3773");
    expect(args).toContain('model_provider="byok_gateway"');
    expect(args).toContain(
      'model_providers.byok_gateway.base_url="http://127.0.0.1:3773/byok-gw/openai/v1"',
    );
    expect(args).toContain('model_providers.byok_gateway.wire_api="chat"');
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
