// @effect-diagnostics globalDate:off - 冷却断言对照墙上时间。
import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ServerSettings } from "@codework/contracts";
import {
  createLocalPoolUsageStore,
  localPoolUsageStore,
  parseLocalPoolUsageState,
} from "./LocalPoolUsage.ts";
import {
  rememberLocalAccountQuota,
  resetLocalAccountQuotaCacheForTest,
} from "./LocalAccountQuota.ts";
import {
  credentialAuthKind,
  credentialToken,
  cursorCredentialEnvironment,
  localGatewayAdapters,
  markLocalAccountFailure,
  LOCAL_POOL_SESSION_AFFINITY_CAPACITY,
  parseLocalCredential,
  peekLocalAccountSessionBinding,
  pickLocalAccount,
  refreshLocalPoolInstanceAdapters,
  soonestLocalPoolCooldownMs,
} from "./LocalAccountPool.ts";

const id = (value: string) => value as never;
const settings = (
  strategy: "round-robin" | "fill-first" | "weighted-round-robin" | "usage" | "smart",
): ServerSettings =>
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
  it("keeps a session on the bound account while new sessions still round-robin", () => {
    const value = settings("round-robin");
    const first = pickLocalAccount(value, "codex", undefined, undefined, "sess-sticky-1");
    expect(first).toBeDefined();
    for (let i = 0; i < 6; i += 1) {
      expect(pickLocalAccount(value, "codex", undefined, undefined, "sess-sticky-1")?.id).toBe(
        first!.id,
      );
    }
    // 新会话仍按轮询分配，粘滞不冻结无键请求。
    expect(pickLocalAccount(value, "codex", undefined, undefined, "sess-sticky-2")?.id).not.toBe(
      undefined,
    );
    expect(pickLocalAccount(value, "codex")?.id).not.toBe(undefined);
    expect(peekLocalAccountSessionBinding("codex", "sess-sticky-1")).toBe(String(first!.id));
  });
  it("rebinds a session when the bound account cools down or leaves the candidates", () => {
    const value = settings("round-robin");
    const bound = pickLocalAccount(value, "codex", undefined, undefined, "sess-rebind")!;
    markLocalAccountFailure(String(bound.id), 429);
    const next = pickLocalAccount(value, "codex", undefined, undefined, "sess-rebind");
    expect(next).toBeDefined();
    expect(String(next!.id)).not.toBe(String(bound.id));
    expect(peekLocalAccountSessionBinding("codex", "sess-rebind")).toBe(String(next!.id));
    // 绑定账号被移出候选集（另一实例的池）时同样换绑或落空，而非固守失效账号。
    const candidateFree = pickLocalAccount(
      value,
      "codex",
      [String(next!.id) === "a" ? "b" : "a"],
      undefined,
      "sess-rebind",
    );
    expect(candidateFree).toBeUndefined();
    localPoolUsageStore.setCooldown(String(bound.id), null);
  });
  it("evicts the oldest session binding beyond the affinity capacity", () => {
    const value = settings("fill-first");
    const key = (index: number) => `sess-cap-${index}`;
    for (let i = 0; i < LOCAL_POOL_SESSION_AFFINITY_CAPACITY; i += 1) {
      pickLocalAccount(value, "codex", undefined, undefined, key(i));
    }
    expect(peekLocalAccountSessionBinding("codex", key(0))).toBe("a");
    // 超出容量的绑定让最旧一条失效；2000 之后的会话仍有绑定。
    pickLocalAccount(value, "codex", undefined, undefined, "sess-cap-overflow");
    expect(peekLocalAccountSessionBinding("codex", key(0))).toBeUndefined();
    expect(peekLocalAccountSessionBinding("codex", "sess-cap-overflow")).toBe("a");
    expect(
      peekLocalAccountSessionBinding("codex", key(LOCAL_POOL_SESSION_AFFINITY_CAPACITY - 1)),
    ).toBe("a");
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
  it.each(["codex", "claude", "xai", "zcode"] as const)(
    "%s 空模型账号不贡献默认目录或体验套餐通道，已同步账号仍可选",
    (provider) => {
      const base = settings("fill-first");
      const pending = {
        ...base,
        localAccountPool: {
          ...base.localAccountPool,
          accounts: {
            [id("a")]: { ...base.localAccountPool.accounts[id("a")]!, provider },
          },
        },
      };
      expect(localGatewayAdapters(pending, "http://localhost", "token", "pool")).toEqual([]);
      const mixed = {
        ...pending,
        localAccountPool: {
          ...pending.localAccountPool,
          accounts: {
            ...pending.localAccountPool.accounts,
            [id("b")]: { ...base.localAccountPool.accounts[id("b")]!, models: ["gpt-ready"] },
          },
        },
      };
      expect(
        localGatewayAdapters(mixed, "http://localhost", "token", "pool").map(
          (adapter) => adapter.id,
        ),
      ).toEqual(["local:pool:codex:gpt-ready"]);
    },
  );
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
  it("429 按上游等待时间冷却，后续短故障不会缩短已有冷却", () => {
    try {
      const startedAt = Date.now();
      markLocalAccountFailure("a", 429, 90_000);
      const firstCooldown = localPoolUsageStore.cooldownUntilUnixMs("a") ?? 0;
      expect(firstCooldown).toBeGreaterThanOrEqual(startedAt + 90_000);
      expect(firstCooldown).toBeLessThanOrEqual(Date.now() + 90_000);

      markLocalAccountFailure("a", 503);
      expect(localPoolUsageStore.cooldownUntilUnixMs("a")).toBe(firstCooldown);
    } finally {
      localPoolUsageStore.setCooldown("a", null);
    }
  });

  it("usage 策略把调用分给累计用量最少的账号", () => {
    localPoolUsageStore.resetForTest();
    try {
      const value = settings("usage");
      expect(pickLocalAccount(value, "codex")?.id).toBe("a");
      localPoolUsageStore.recordTokens("a", 5_000, 1_000);
      localPoolUsageStore.recordRequest("a", "codex", true);
      expect(pickLocalAccount(value, "codex")?.id).toBe("b");
      // b 用量反超后回到 token 更少的账号。
      localPoolUsageStore.recordTokens("b", 7_000, 0);
      expect(pickLocalAccount(value, "codex")?.id).toBe("a");
    } finally {
      localPoolUsageStore.resetForTest();
    }
  });

  it("smart 策略在仍有配额的账号里选最快重置的，触顶账号排最后", () => {
    localPoolUsageStore.resetForTest();
    resetLocalAccountQuotaCacheForTest();
    try {
      const value = settings("smart");
      const now = Date.now();
      const soon = new Date(now + 10 * 60 * 1_000).toISOString();
      const later = new Date(now + 60 * 60 * 1_000).toISOString();
      rememberLocalAccountQuota("a", {
        windows: [{ label: "5 小时", percent: 90, resetsAt: later }],
      });
      rememberLocalAccountQuota("b", {
        windows: [{ label: "5 小时", percent: 95, resetsAt: soon }],
      });
      // b 已用更多但重置更早：smart 按"减少重置浪费"选 b，而非剩余更多的 a。
      expect(pickLocalAccount(value, "codex")?.id).toBe("b");
      // a 触顶后即使重置更早也排到最后。
      rememberLocalAccountQuota("a", {
        windows: [{ label: "5 小时", percent: 100, resetsAt: soon }],
      });
      expect(pickLocalAccount(value, "codex")?.id).toBe("b");
    } finally {
      resetLocalAccountQuotaCacheForTest();
      localPoolUsageStore.resetForTest();
    }
  });

  it("smart 策略在没有任何配额快照时退化为轮询，会话亲和不受策略影响", () => {
    localPoolUsageStore.resetForTest();
    resetLocalAccountQuotaCacheForTest();
    try {
      const value = settings("smart");
      // 轮询游标是跨用例共享的模块状态，这里只断言两个账号都被轮到。
      const picks = [pickLocalAccount(value, "codex")?.id, pickLocalAccount(value, "codex")?.id];
      expect(new Set(picks).size).toBe(2);
      const bound = pickLocalAccount(value, "codex", undefined, undefined, "sess-smart")!;
      expect(pickLocalAccount(value, "codex", undefined, undefined, "sess-smart")?.id).toBe(
        String(bound.id),
      );
    } finally {
      resetLocalAccountQuotaCacheForTest();
      localPoolUsageStore.resetForTest();
    }
  });

  it("soonestLocalPoolCooldownMs 返回最近冷却倒计时；无冷却返回 0，无候选返回 undefined", () => {
    localPoolUsageStore.resetForTest();
    try {
      const value = settings("round-robin");
      expect(soonestLocalPoolCooldownMs(value, "codex")).toBe(0);
      markLocalAccountFailure("a", 429, 45_000);
      markLocalAccountFailure("b", 429, 90_000);
      const waitMs = soonestLocalPoolCooldownMs(value, "codex");
      expect(waitMs).toBeGreaterThan(40_000);
      expect(waitMs!).toBeLessThanOrEqual(45_000);
      // 候选限定到 b 时只看 b 的冷却。
      const waitB = soonestLocalPoolCooldownMs(value, "codex", ["b"]);
      expect(waitB).toBeGreaterThan(85_000);
      // 没有任何 enabled 且模型匹配的候选：等待也无济于事。空模型列表
      // 语义是"不限模型"，所以这里要用显式声明模型的账号来构造无候选。
      expect(soonestLocalPoolCooldownMs(value, "codex", ["missing"])).toBeUndefined();
      const scoped = {
        ...value,
        localAccountPool: {
          ...value.localAccountPool,
          accounts: Object.fromEntries(
            Object.entries(value.localAccountPool.accounts).map(([key, account]) => [
              key,
              { ...account, models: ["gpt-a"] },
            ]),
          ),
        },
      } as ServerSettings;
      expect(
        soonestLocalPoolCooldownMs(scoped, "codex", undefined, "no-such-model"),
      ).toBeUndefined();
      expect(soonestLocalPoolCooldownMs(scoped, "codex", undefined, "gpt-a")).toBeGreaterThan(0);
    } finally {
      localPoolUsageStore.setCooldown("a", null);
      localPoolUsageStore.setCooldown("b", null);
      localPoolUsageStore.resetForTest();
    }
  });
});
