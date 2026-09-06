// @effect-diagnostics preferSchemaOverJson:off - 测试只构造最小凭据 JSON。
// @effect-diagnostics schemaSyncInEffect:off - 断言持久化后的无类型配置快照。
// @effect-diagnostics unknownInErrorChannel:off - 测试辅助函数统一运行最小 service 错误。
// @effect-diagnostics anyUnknownInErrorContext:off - 测试故意把多个服务错误统一交给运行器。
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  DEFAULT_SERVER_SETTINGS,
  CliProxyError,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@codework/contracts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { layerTest, ServerSettingsService } from "../serverSettings.ts";
import { CliProxyRuntime } from "./CliProxyRuntime.ts";
import { makeCliProxyService, resolveLocalPoolProvider } from "./CliProxy.ts";
import { localPoolUsageStore } from "./LocalPoolUsage.ts";
import { gatewayAdapterRoutes, pickGatewayAdapter } from "./byok/modelGateway.ts";

const account = (
  id: string,
  provider: "codex" | "claude" | "xai" | "cursor",
  models: readonly string[],
) => ({
  id: id as never,
  provider,
  authKind: "api-key" as const,
  displayName: id,
  credentialRef: id,
  enabled: true,
  models,
});

const secretStore = (initial: Record<string, string> = {}): ServerSecretStore["Service"] => {
  const values = new Map<string, Uint8Array>(
    Object.entries(initial).map(([key, value]) => [
      key,
      Uint8Array.from(Buffer.from(value, "utf8")),
    ]),
  );
  return {
    get: (name) =>
      Effect.succeed(
        values.has(name) ? Option.some(Uint8Array.from(values.get(name)!)) : Option.none(),
      ),
    set: (name, value) => Effect.sync(() => values.set(name, Uint8Array.from(value))),
    create: (name, value) => Effect.sync(() => values.set(name, Uint8Array.from(value))),
    getOrCreateRandom: (name) =>
      Effect.sync(() => {
        const current = values.get(name);
        if (current !== undefined) return Uint8Array.from(current);
        const generated = Uint8Array.from(Buffer.alloc(32, 7));
        values.set(name, generated);
        return generated;
      }),
    remove: (name) =>
      Effect.sync(() => {
        values.delete(name);
      }),
  };
};

const runWithServices = <A>(
  settings: Partial<ServerSettings>,
  action: (
    service: ServerSettingsService["Service"],
    secrets: ServerSecretStore["Service"],
  ) => Effect.Effect<A, unknown>,
) => {
  const secrets = secretStore();
  return Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    return yield* action(serverSettings, secrets);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(layerTest(settings as never), Layer.succeed(ServerSecretStore, secrets)),
    ),
  );
};

describe("内置 CLIProxyAPI 核心", () => {
  it("不再接受外部进程配置，并正确约束 CLI 账号池平台", () => {
    const runtime = new CliProxyRuntime("http://127.0.0.1:3000");
    expect(runtime.running).toBe(true);
    expect(runtime.version).toBe("embedded");
    expect(runtime.baseUrl).toBe("http://127.0.0.1:3000/v1");
    expect(resolveLocalPoolProvider("opencode", "claude")).toBeUndefined();
    expect(resolveLocalPoolProvider("opencode", "codex")).toBe("codex");
    expect(resolveLocalPoolProvider("byok", "claude")).toBe("claude");
    expect(resolveLocalPoolProvider("cursor", "cursor")).toBe("cursor");
    expect(resolveLocalPoolProvider("codex", "xai")).toBeUndefined();
  });

  it("导入凭据只返回脱敏摘要，并将本地账号绑定到内置 BYOK 实例", async () =>
    Effect.runPromise(
      runWithServices(
        {
          localAccountPool: {
            accounts: {},
            strategy: "round-robin",
            providerInstances: {},
          },
        },
        (settings, secrets) =>
          Effect.gen(function* () {
            const runtime = new CliProxyRuntime("http://127.0.0.1:3000");
            const service = yield* makeCliProxyService(
              runtime,
              settings,
              secrets,
              "http://127.0.0.1:3000",
            );
            const imported = yield* service.handle({
              action: "importLocalAccount",
              id: "codex-a",
              provider: "codex",
              displayName: "Codex A",
              content: JSON.stringify({ api_key: "never-return-this", models: ["gpt-5.4"] }),
            });
            expect(JSON.stringify(imported)).not.toContain("never-return-this");
            const connected = yield* service.handle({
              action: "connectByok",
              instanceId: ProviderInstanceId.make("embedded-cpa"),
              displayName: "内置账号池",
            });
            expect(connected.version).toBe("embedded");
            expect(connected.baseUrl).toBe("http://127.0.0.1:3000/v1");
            expect(connected.connectedInstanceId).toBe("embedded-cpa");
            const restarted = yield* makeCliProxyService(
              new CliProxyRuntime("http://127.0.0.1:3000"),
              settings,
              secrets,
              "http://127.0.0.1:3000",
            );
            expect((yield* restarted.handle({ action: "status" })).connectedInstanceId).toBe(
              "embedded-cpa",
            );
            const current = yield* settings.getSettings;
            expect(
              current.localAccountPool.providerInstances[ProviderInstanceId.make("embedded-cpa")],
            ).toEqual(["codex-a"]);
            const config = Schema.decodeUnknownSync(Schema.Unknown)(
              current.providerInstances[ProviderInstanceId.make("embedded-cpa")]?.config,
            ) as { adapters?: readonly Record<string, unknown>[] };
            expect(config.adapters?.[0]).toMatchObject({
              id: "local:embedded-cpa:codex:gpt-5.4",
              supplierID: "codework-local-account",
            });
            expect(config.adapters?.[0]?.apiKey).not.toBe("never-return-this");
          }),
      ),
    ));

  it("连接本地账号池会自动接管有匹配账号的 CLI 实例", async () =>
    Effect.runPromise(
      runWithServices(
        {
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              config: {},
            },
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              config: {},
            },
            [ProviderInstanceId.make("grok")]: {
              driver: ProviderDriverKind.make("grok"),
              enabled: true,
              config: {},
            },
          },
          localAccountPool: {
            accounts: {},
            strategy: "round-robin",
            providerInstances: {},
          },
        },
        (settings, secrets) =>
          Effect.gen(function* () {
            const service = yield* makeCliProxyService(
              new CliProxyRuntime("http://127.0.0.1:3000"),
              settings,
              secrets,
              "http://127.0.0.1:3000",
            );
            for (const input of [
              ["codex-a", "codex", "gpt-5.4"],
              ["claude-a", "claude", "claude-sonnet-5"],
              ["grok-a", "xai", "grok-3"],
            ] as const) {
              yield* service.handle({
                action: "importLocalAccount",
                id: input[0],
                provider: input[1],
                displayName: input[0],
                content: JSON.stringify({ api_key: `${input[0]}-key`, models: [input[2]] }),
              });
            }
            yield* service.handle({
              action: "connectByok",
              instanceId: ProviderInstanceId.make("cli-proxy"),
              displayName: "CLI 账号池",
            });
            yield* service.handle({
              action: "importLocalAccount",
              id: "codex-b",
              provider: "codex",
              displayName: "codex-b",
              content: JSON.stringify({ api_key: "codex-b-key", models: ["gpt-5.4-mini"] }),
            });
            const current = yield* settings.getSettings;
            for (const instanceId of ["codex", "claudeAgent", "grok"] as const) {
              expect(
                current.providerInstances[ProviderInstanceId.make(instanceId)]?.config,
              ).toMatchObject({
                routeThroughByok: true,
                byokSourceInstanceId: "cli-proxy",
              });
            }
            expect(
              current.localAccountPool.providerInstances[ProviderInstanceId.make("cli-proxy")],
            ).toEqual(["codex-a", "claude-a", "grok-a", "codex-b"]);
            expect(
              gatewayAdapterRoutes(current, "cli-proxy").map((route) => route.modelId),
            ).toEqual(["gpt-5.4", "gpt-5.4-mini", "claude-sonnet-5", "grok-3"]);
          }),
      ),
    ));

  it("Cursor 账号池绑定走 ACP 会话，不伪造 BYOK 网关配置", async () =>
    Effect.runPromise(
      runWithServices(
        {
          providerInstances: {
            [ProviderInstanceId.make("cursor")]: {
              driver: ProviderDriverKind.make("cursor"),
              enabled: true,
              config: {},
            },
          },
          localAccountPool: {
            accounts: { ["cursor-a" as never]: account("cursor-a", "cursor", []) },
            strategy: "round-robin",
            providerInstances: {},
          },
        },
        (settings, secrets) =>
          Effect.gen(function* () {
            const service = yield* makeCliProxyService(
              new CliProxyRuntime("http://127.0.0.1:3000"),
              settings,
              secrets,
              "http://127.0.0.1:3000",
            );
            yield* service.handle({
              action: "publishLocalAccountPool",
              instanceId: ProviderInstanceId.make("cursor"),
              provider: "cursor",
            });
            const current = yield* settings.getSettings;
            expect(
              current.localAccountPool.providerInstances[ProviderInstanceId.make("cursor")],
            ).toEqual(["cursor-a"]);
            expect(
              current.providerInstances[ProviderInstanceId.make("cursor")]?.config,
            ).not.toMatchObject({ routeThroughByok: true });
          }),
      ),
    ));

  it("允许没有模型声明的官方 auth 文件进入本地账号池", async () =>
    Effect.runPromise(
      runWithServices(
        {
          localAccountPool: {
            accounts: {},
            strategy: "round-robin",
            providerInstances: {},
          },
        },
        (settings, secrets) =>
          Effect.gen(function* () {
            const service = yield* makeCliProxyService(
              new CliProxyRuntime("http://127.0.0.1:3000"),
              settings,
              secrets,
              "http://127.0.0.1:3000",
            );
            const result = yield* service.handle({
              action: "importLocalAccount",
              id: "codex-oauth",
              provider: "codex",
              displayName: "Codex OAuth",
              content: JSON.stringify({ tokens: { access_token: "oauth-token" } }),
            });
            expect(result.localAccounts?.[0]).toMatchObject({
              id: "codex-oauth",
              provider: "codex",
              models: [],
            });
          }),
      ),
    ));

  it("绑定账号池后导入同平台账号会自动加入现有绑定", async () =>
    Effect.runPromise(
      runWithServices(
        {
          providerInstances: {
            ["embedded-cpa" as never]: {
              driver: ProviderDriverKind.make("byok"),
              enabled: true,
              config: { enabled: true, adapters: [] },
            },
          },
          localAccountPool: {
            accounts: {
              ["codex-a" as never]: account("codex-a", "codex", ["gpt-5.4"]),
            },
            strategy: "round-robin",
            providerInstances: { ["embedded-cpa" as never]: ["codex-a"] },
          },
        },
        (settings, secrets) =>
          Effect.gen(function* () {
            const service = yield* makeCliProxyService(
              new CliProxyRuntime("http://127.0.0.1:3000"),
              settings,
              secrets,
              "http://127.0.0.1:3000",
            );
            yield* service.handle({
              action: "importLocalAccount",
              id: "codex-b",
              provider: "codex",
              displayName: "Codex B",
              content: JSON.stringify({ api_key: "second-key", models: ["gpt-5.4"] }),
            });
            const current = yield* settings.getSettings;
            expect(
              current.localAccountPool.providerInstances[ProviderInstanceId.make("embedded-cpa")],
            ).toEqual(["codex-a", "codex-b"]);
          }),
      ),
    ));

  it("账号池变化后自动刷新 BYOK 池实例的适配器目录", async () =>
    Effect.runPromise(
      runWithServices(
        {
          localAccountPool: {
            accounts: {
              ["codex-a" as never]: account("codex-a", "codex", ["gpt-5.4"]),
            },
            strategy: "round-robin",
            providerInstances: {},
          },
        },
        (settings, secrets) =>
          Effect.gen(function* () {
            const service = yield* makeCliProxyService(
              new CliProxyRuntime("http://127.0.0.1:3000"),
              settings,
              secrets,
              "http://127.0.0.1:3000",
            );
            yield* service.handle({
              action: "connectByok",
              instanceId: ProviderInstanceId.make("embedded-cpa"),
              displayName: "内置账号池",
            });
            const poolAdapters = () =>
              Effect.gen(function* () {
                const current = yield* settings.getSettings;
                const config = current.providerInstances[ProviderInstanceId.make("embedded-cpa")]
                  ?.config as { adapters?: readonly Record<string, unknown>[] } | undefined;
                return (config?.adapters ?? []) as ReadonlyArray<{
                  id: string;
                  baseURL: string;
                  apiKey: string;
                }>;
              });
            const before = yield* poolAdapters();
            expect(before.map((adapter) => adapter.id)).toEqual([
              "local:embedded-cpa:codex:gpt-5.4",
            ]);
            yield* service.handle({
              action: "importLocalAccount",
              id: "codex-b",
              provider: "codex",
              displayName: "Codex B",
              content: JSON.stringify({ api_key: "second-key", models: ["gpt-5.5"] }),
            });
            const after = yield* poolAdapters();
            expect(after.map((adapter) => adapter.id)).toEqual([
              "local:embedded-cpa:codex:gpt-5.4",
              "local:embedded-cpa:codex:gpt-5.5",
            ]);
            expect(after[0]?.apiKey).toBe(before[0]?.apiKey);
            expect(after[0]?.baseURL).toBe(before[0]?.baseURL);
            yield* service.handle({
              action: "setLocalAccountEnabled",
              id: "codex-a",
              enabled: false,
            });
            expect((yield* poolAdapters()).map((adapter) => adapter.id)).toEqual([
              "local:embedded-cpa:codex:gpt-5.5",
            ]);
          }),
      ),
    ));

  it("status 返回仍在册账号的用量统计，过滤已删除账号", async () =>
    Effect.runPromise(
      runWithServices(
        {
          localAccountPool: {
            accounts: {
              ["codex-a" as never]: account("codex-a", "codex", ["gpt-5.4"]),
            },
            strategy: "round-robin",
            providerInstances: {},
          },
        },
        (settings, secrets) =>
          Effect.gen(function* () {
            const service = yield* makeCliProxyService(
              new CliProxyRuntime("http://127.0.0.1:3000"),
              settings,
              secrets,
              "http://127.0.0.1:3000",
            );
            localPoolUsageStore.recordRequest("codex-a", "codex", true);
            localPoolUsageStore.recordRequest("deleted-account", "codex", false);
            const status = yield* service.handle({ action: "status" });
            expect(status.accountUsage?.map((entry) => entry.id)).toEqual(["codex-a"]);
            expect(status.accountUsage?.[0]).toMatchObject({ requests: 1, failed: 0 });
          }),
      ),
    ));

  it("重新导入同一账号 ID 换平台时清理旧平台绑定", async () =>
    Effect.runPromise(
      runWithServices(
        {
          localAccountPool: {
            accounts: {
              ["shared-account" as never]: account("shared-account", "codex", ["gpt-5.4"]),
              ["claude-a" as never]: account("claude-a", "claude", ["claude-sonnet-5"]),
            },
            strategy: "round-robin",
            providerInstances: {
              ["codex-instance" as never]: ["shared-account"],
              ["claude-instance" as never]: ["claude-a"],
            },
          },
        },
        (settings, secrets) =>
          Effect.gen(function* () {
            const service = yield* makeCliProxyService(
              new CliProxyRuntime("http://127.0.0.1:3000"),
              settings,
              secrets,
              "http://127.0.0.1:3000",
            );
            yield* service.handle({
              action: "importLocalAccount",
              id: "shared-account",
              provider: "claude",
              displayName: "Shared Claude",
              content: JSON.stringify({ api_key: "claude-key", models: ["claude-sonnet-5"] }),
            });
            const current = yield* settings.getSettings;
            expect(
              current.localAccountPool.providerInstances[ProviderInstanceId.make("codex-instance")],
            ).toEqual([]);
            expect(
              current.localAccountPool.providerInstances[
                ProviderInstanceId.make("claude-instance")
              ],
            ).toEqual(["claude-a", "shared-account"]);
          }),
      ),
    ));

  it("凭据文件缺失时仍可删除本地账号元数据", async () =>
    Effect.runPromise(
      runWithServices(
        {
          localAccountPool: {
            accounts: { ["orphaned" as never]: account("orphaned", "codex", []) },
            strategy: "round-robin",
            providerInstances: { ["codex-instance" as never]: ["orphaned"] },
          },
        },
        (settings, secrets) =>
          Effect.gen(function* () {
            const service = yield* makeCliProxyService(
              new CliProxyRuntime("http://127.0.0.1:3000"),
              settings,
              secrets,
              "http://127.0.0.1:3000",
            );
            yield* service.handle({ action: "deleteLocalAccount", id: "orphaned" });
            const current = yield* settings.getSettings;
            expect(Object.hasOwn(current.localAccountPool.accounts, "orphaned")).toBe(false);
            expect(
              current.localAccountPool.providerInstances[ProviderInstanceId.make("codex-instance")],
            ).toEqual([]);
          }),
      ),
    ));

  it("配置策略和账号启停通过同一服务持久化", async () =>
    Effect.runPromise(
      runWithServices(
        {
          localAccountPool: {
            accounts: { ["codex-a" as never]: account("codex-a", "codex", ["gpt-5.4"]) },
            strategy: "round-robin",
            providerInstances: {},
          },
        },
        (settings, secrets) =>
          Effect.gen(function* () {
            const service = yield* makeCliProxyService(
              new CliProxyRuntime("http://127.0.0.1:3000"),
              settings,
              secrets,
              "http://127.0.0.1:3000",
            );
            yield* service.handle({
              action: "setLocalAccountPoolStrategy",
              strategy: "fill-first",
            });
            yield* service.handle({
              action: "setLocalAccountEnabled",
              id: "codex-a",
              enabled: false,
            });
            const result = yield* service.handle({ action: "status" });
            expect(result.localStrategy).toBe("fill-first");
            expect(result.localAccounts?.[0]).toMatchObject({ id: "codex-a", enabled: false });
          }),
      ),
    ));

  it("策略持久化失败时不提前改变运行时配置", async () =>
    Effect.runPromise(
      runWithServices(
        {
          localAccountPool: {
            accounts: {},
            strategy: "round-robin",
            providerInstances: {},
          },
        },
        (settings, secrets) =>
          Effect.gen(function* () {
            const runtime = new CliProxyRuntime("http://127.0.0.1:3000");
            const failingSettings = {
              ...settings,
              updateSettings: () =>
                Effect.fail(
                  new CliProxyError({ code: "invalid_config", detail: "disk unavailable" }),
                ),
            } as unknown as ServerSettingsService["Service"];
            const service = yield* makeCliProxyService(
              runtime,
              failingSettings,
              secrets,
              "http://127.0.0.1:3000",
            );
            const result = yield* Effect.exit(
              service.handle({ action: "configure", config: { strategy: "fill-first" } }),
            );
            expect(result._tag).toBe("Failure");
            expect(runtime.config.strategy).toBe("round-robin");
          }),
      ),
    ));

  it("批量启停账号只写入一次账号池状态", async () =>
    Effect.runPromise(
      runWithServices(
        {
          localAccountPool: {
            accounts: {
              ["codex-a" as never]: account("codex-a", "codex", ["gpt-5.4"]),
              ["codex-b" as never]: account("codex-b", "codex", ["gpt-5.4"]),
            },
            strategy: "round-robin",
            providerInstances: {},
          },
        },
        (settings, secrets) =>
          Effect.gen(function* () {
            const service = yield* makeCliProxyService(
              new CliProxyRuntime("http://127.0.0.1:3000"),
              settings,
              secrets,
              "http://127.0.0.1:3000",
            );
            yield* service.handle({
              action: "setLocalAccountsEnabled",
              ids: ["codex-a", "codex-b"],
              enabled: false,
            });
            const result = yield* service.handle({ action: "status" });
            expect(result.localAccounts?.map((entry) => entry.enabled)).toEqual([false, false]);
          }),
      ),
    ));

  it("本地路由使用稳定 local slug，不会把内置网关当成自己的上游", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        "embedded-cpa": {
          driver: ProviderDriverKind.make("byok"),
          enabled: true,
          config: { enabled: true, adapters: [] },
        },
      },
      localAccountPool: {
        accounts: { "codex-a": account("codex-a", "codex", ["gpt-5.4"]) },
        strategy: "round-robin" as const,
        providerInstances: { "embedded-cpa": ["codex-a"] },
      },
    } as unknown as ServerSettings;
    const routes = gatewayAdapterRoutes(settings, "embedded-cpa");
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      id: "local:embedded-cpa:codex:gpt-5.4",
      localProvider: "codex",
      supplierID: "codework-local-account",
    });
    expect(pickGatewayAdapter(routes, "openai", "local:embedded-cpa:codex:gpt-5.4")?.baseURL).toBe(
      "local://codex",
    );
  });
});
