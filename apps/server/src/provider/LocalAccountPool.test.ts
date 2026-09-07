// @effect-diagnostics globalDate:off - 冷却断言对照墙上时间。
import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerSettings } from "@codework/contracts";
import {
  createLocalPoolUsageStore,
  localPoolUsageStore,
  parseLocalPoolUsageState,
} from "./LocalPoolUsage.ts";
import {
  credentialAuthKind,
  credentialToken,
  cursorCredentialEnvironment,
  localGatewayAdapters,
  markLocalAccountFailure,
  parseLocalCredential,
  pickLocalAccount,
  refreshLocalPoolInstanceAdapters,
} from "./LocalAccountPool.ts";

const id = (value: string) => value as never;
const settings = (strategy: "round-robin" | "fill-first"): ServerSettings =>
  ({
    localAccountPool: {
      strategy,
      accounts: {
        a: {
          id: id("a"),
          provider: "codex",
          displayName: "A",
          credentialRef: "a",
          enabled: true,
          models: [],
        },
        b: {
          id: id("b"),
          provider: "codex",
          displayName: "B",
          credentialRef: "b",
          enabled: true,
          models: [],
        },
      },
      providerInstances: {},
    },
    providerInstances: { codex: { driver: ProviderDriverKind.make("codex") } },
  }) as unknown as ServerSettings;

describe("LocalAccountPool", () => {
  it("accepts official token-shaped credential JSON without exposing its value", () => {
    expect(parseLocalCredential('{"access_token":"secret","account_id":"acct"}').account_id).toBe(
      "acct",
    );
  });
  it("normalizes Codex and Claude CLI credential envelopes", () => {
    expect(
      parseLocalCredential('{"tokens":{"access_token":"codex","account_id":"acct"}}').account_id,
    ).toBe("acct");
    expect(
      parseLocalCredential('{"claudeAiOauth":{"accessToken":"claude","refreshToken":"refresh"}}')
        .refresh_token,
    ).toBe("refresh");
  });
  it("accepts Grok's official nested auth.json and API key aliases", () => {
    expect(parseLocalCredential('{"https://accounts.x.ai/sign-in":{"key":"grok"}}').key).toBe(
      "grok",
    );
    expect(
      credentialAuthKind(
        parseLocalCredential('{"https://accounts.x.ai/sign-in":{"key":"grok"}}', "xai"),
      ),
    ).toBe("oauth");
    expect(
      credentialAuthKind(
        parseLocalCredential(
          '{"https://auth.x.ai::client":{"key":"grok","refresh_token":"refresh"}}',
          "xai",
        ),
      ),
    ).toBe("oauth");
    expect(
      credentialAuthKind(
        parseLocalCredential('{"xai::api_key":{"key":"xai-key","auth_mode":"api_key"}}', "xai"),
      ),
    ).toBe("api-key");
    expect(parseLocalCredential('{"ANTHROPIC_API_KEY":"anthropic"}').api_key).toBe("anthropic");
  });
  it("识别 Cursor 官方 API key 与 auth token 字段", () => {
    expect(
      cursorCredentialEnvironment(parseLocalCredential('{"api_key":"cursor-key"}', "cursor")),
    ).toEqual({ CURSOR_API_KEY: "cursor-key" });
    expect(
      cursorCredentialEnvironment(parseLocalCredential('{"auth_token":"cursor-token"}', "cursor")),
    ).toEqual({ CURSOR_AUTH_TOKEN: "cursor-token" });
  });
  it("keeps provider API key aliases scoped and classifies OAuth envelopes", () => {
    expect(() => parseLocalCredential('{"ANTHROPIC_API_KEY":"anthropic"}', "codex")).toThrow();
    expect(() =>
      parseLocalCredential('{"https://accounts.x.ai/sign-in":{"key":"grok"}}', "claude"),
    ).toThrow();
    expect(parseLocalCredential('{"OPENAI_API_KEY":"openai"}', "codex").api_key).toBe("openai");
    expect(
      credentialAuthKind(
        parseLocalCredential(
          '{"tokens":{"access_token":"oauth","refresh_token":"refresh"}}',
          "codex",
        ),
      ),
    ).toBe("oauth");
    expect(credentialAuthKind(parseLocalCredential('{"api_key":"key"}', "claude"))).toBe("api-key");
  });
  it("按认证类型选择令牌，绝不把 refresh_token 当作推理令牌", () => {
    const credential = {
      access_token: "oauth-access",
      api_key: "api-key",
      refresh_token: "refresh-only",
    };
    expect(credentialToken(credential, "oauth")).toBe("oauth-access");
    expect(credentialToken(credential, "api-key")).toBe("api-key");
    expect(credentialToken({ refresh_token: "refresh-only" }, "oauth")).toBeUndefined();
  });
  it("converts expires_in and honors expired=true", () => {
    expect(parseLocalCredential('{"access_token":"token","expires_in":3600}').expires_in).toBe(
      3600,
    );
  });
  it("round-robins accounts", () => {
    const value = settings("round-robin");
    expect(pickLocalAccount(value, "codex")?.id).toBe("a");
    expect(pickLocalAccount(value, "codex")?.id).toBe("b");
  });
  it("weighted-round-robin 按权重比例分配调用", () => {
    const base = settings("round-robin");
    const poolAccounts = (
      base.localAccountPool as { accounts: Record<string, Record<string, unknown>> }
    ).accounts;
    const weighted = {
      ...base,
      localAccountPool: {
        ...(base.localAccountPool as Record<string, unknown>),
        strategy: "weighted-round-robin",
        accounts: { ...poolAccounts, a: { ...poolAccounts.a, weight: 3 } },
      },
    } as unknown as ServerSettings;
    const picks = Array.from({ length: 4 }, () => pickLocalAccount(weighted, "codex")?.id);
    expect(picks.filter((picked) => picked === "a")).toHaveLength(3);
    expect(picks.filter((picked) => picked === "b")).toHaveLength(1);
  });
  it("钳制损坏配置中的超大权重", () => {
    const base = settings("round-robin");
    const poolAccounts = (
      base.localAccountPool as { accounts: Record<string, Record<string, unknown>> }
    ).accounts;
    const weighted = {
      ...base,
      localAccountPool: {
        ...(base.localAccountPool as Record<string, unknown>),
        strategy: "weighted-round-robin",
        accounts: { ...poolAccounts, a: { ...poolAccounts.a, weight: Number.MAX_SAFE_INTEGER } },
      },
    } as unknown as ServerSettings;
    expect(pickLocalAccount(weighted, "codex")?.id).toBe("a");
  });
  it("supports scoped account ids", () => {
    expect(pickLocalAccount(settings("fill-first"), "codex", ["b"])?.id).toBe("b");
  });
  it("filters accounts by the published model when credentials declare models", () => {
    const base = settings("fill-first");
    const accounts = base.localAccountPool.accounts as unknown as Record<
      string,
      {
        id: never;
        provider: "codex";
        displayName: string;
        credentialRef: string;
        enabled: boolean;
        models: readonly string[];
      }
    >;
    const value = {
      ...base,
      localAccountPool: {
        ...base.localAccountPool,
        accounts: {
          ...accounts,
          a: { ...accounts.a, models: ["gpt-a"] },
          b: { ...accounts.b, models: ["gpt-b"] },
        },
      },
    } as ServerSettings;
    expect(pickLocalAccount(value, "codex", undefined, "gpt-b")?.id).toBe("b");
    expect(pickLocalAccount(value, "codex", undefined, "gpt-c")).toBeUndefined();
  });
  it("refreshLocalPoolInstanceAdapters 对最新目录返回 undefined", () => {
    const base = {
      ...settings("round-robin"),
      providerInstances: {
        pool: {
          driver: ProviderDriverKind.make("byok"),
          enabled: true,
          config: { enabled: true, adapters: [] as unknown[] },
        },
      },
    } as unknown as ServerSettings;
    const origin = "http://127.0.0.1:3000";
    const current = localGatewayAdapters(base, origin, "gw-token", "pool");
    const withCatalog = {
      ...base,
      providerInstances: {
        pool: {
          ...(base.providerInstances as Record<string, { config: unknown }>).pool,
          config: { enabled: true, adapters: current },
        },
      },
    } as unknown as ServerSettings;
    expect(refreshLocalPoolInstanceAdapters(withCatalog)).toBeUndefined();
  });
  it("refreshLocalPoolInstanceAdapters 只替换池适配器块并保持端点稳定", () => {
    const origin = "http://127.0.0.1:3000";
    const accounts = {
      a: {
        id: id("a"),
        provider: "codex",
        displayName: "A",
        credentialRef: "a",
        enabled: true,
        models: ["gpt-a"],
      },
      b: {
        id: id("b"),
        provider: "claude",
        displayName: "B",
        credentialRef: "b",
        enabled: true,
        models: ["claude-a"],
      },
    };
    const base = {
      localAccountPool: { strategy: "round-robin", accounts, providerInstances: {} },
      providerInstances: {
        pool: {
          driver: ProviderDriverKind.make("byok"),
          enabled: true,
          config: {
            enabled: true,
            adapters: [
              {
                id: "own-adapter",
                displayName: "Own",
                protocol: "openai",
                baseURL: "https://relay.example/v1",
                apiKey: "own-key",
                modelId: "own-model",
              },
              {
                id: "local:pool:codex:gpt-a",
                displayName: "gpt-a",
                groupName: "CLIProxyAPI · codex",
                protocol: "openai",
                baseURL: `${origin}/v1`,
                apiKey: "gw-token",
                modelId: "gpt-a",
                supplierID: "codework-local-account",
              },
            ],
          },
        },
      },
    } as unknown as ServerSettings;
    const patch = refreshLocalPoolInstanceAdapters(base);
    expect(patch).toBeDefined();
    const adapters = (
      (patch!.providerInstances as Record<string, { config: unknown }>).pool!.config as {
        adapters: Array<{ id: string; baseURL: string; apiKey: string }>;
      }
    ).adapters;
    expect(adapters.map((adapter) => adapter.id)).toEqual([
      "own-adapter",
      "local:pool:codex:gpt-a",
      "local:pool:claude:claude-a",
    ]);
    expect(adapters[1]?.baseURL).toBe(`${origin}/v1`);
    expect(adapters[2]?.baseURL).toBe(origin);
    expect(adapters[1]?.apiKey).toBe("gw-token");
    const stable = {
      ...base,
      providerInstances: {
        pool: (patch!.providerInstances as Record<string, unknown>).pool,
      },
    } as unknown as ServerSettings;
    expect(refreshLocalPoolInstanceAdapters(stable)).toBeUndefined();
  });
  it("refreshLocalPoolInstanceAdapters 忽略没有池适配器的实例", () => {
    const value = {
      ...settings("round-robin"),
      providerInstances: {
        byok: {
          driver: ProviderDriverKind.make("byok"),
          enabled: true,
          config: {
            enabled: true,
            adapters: [
              { id: "own", protocol: "openai", baseURL: "https://x/v1", apiKey: "k", modelId: "m" },
            ],
          },
        },
      },
    } as unknown as ServerSettings;
    expect(refreshLocalPoolInstanceAdapters(value)).toBeUndefined();
  });
  it("markLocalAccountFailure 冷却被选账号，冷却随快照跨重启保留", () => {
    const value = settings("round-robin");
    try {
      markLocalAccountFailure("a", 429);
      expect(localPoolUsageStore.cooldownUntilUnixMs("a")).toBeGreaterThan(Date.now());
      expect(pickLocalAccount(value, "codex")?.id).toBe("b");
      expect(pickLocalAccount(value, "codex")?.id).toBe("b");
      // 模拟重启：脏快照落盘 → 新存储水合 → 冷却仍然有效。
      const snapshot = localPoolUsageStore.takeDirtySnapshot();
      const restored = createLocalPoolUsageStore();
      restored.hydrate(parseLocalPoolUsageState(JSON.stringify(snapshot))!);
      expect(restored.cooldownUntilUnixMs("a")).toBeGreaterThan(Date.now());
    } finally {
      localPoolUsageStore.setCooldown("a", null);
    }
    expect(localPoolUsageStore.cooldownUntilUnixMs("a") ?? 0).toBeLessThanOrEqual(Date.now());
    expect(pickLocalAccount(value, "codex")?.id).toBe("a");
  });
});
