// @effect-diagnostics globalDate:off - 冷却截止是否仍有效按墙上时间判断。
import {
  ByokSettings,
  CliProxyError,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type CliProxyRequest,
  type CliProxyResult,
  type LocalAccountId,
  type LocalAccountProvider,
  type ProviderInstanceConfig,
  type ServerSettings,
} from "@codework/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ServerConfig } from "../config.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  importLocalAccount,
  localGatewayAdapters,
  removeLocalAccount,
  setLocalAccountsEnabled,
  setLocalAccountEnabled,
  setLocalAccountPoolStrategy,
  setLocalAccountWeight,
} from "./LocalAccountPool.ts";
import {
  localPoolUsageStore,
  parseLocalPoolUsageState,
  type LocalPoolUsageState,
} from "./LocalPoolUsage.ts";
import {
  createLocalGatewayKey,
  readLocalGatewayKeys,
  revokeLocalGatewayKey,
  rotateLocalGatewayKey,
  summarizeLocalGatewayKeys,
} from "./LocalGatewayKey.ts";
import { CliProxyRuntime, projectCliProxyAccount } from "./CliProxyRuntime.ts";
import {
  anthropicGatewayBase,
  ensureGatewayToken,
  gatewayOrigin,
  openaiGatewayBase,
} from "./byok/modelGateway.ts";

const decodeByokSettings = Schema.decodeUnknownSync(ByokSettings);
const isCliProxyError = Schema.is(CliProxyError);

const safeError = (error: unknown): CliProxyError =>
  isCliProxyError(error)
    ? error
    : new CliProxyError({
        code: "upstream_error",
        detail: "内置 CLIProxyAPI 操作失败，请检查账号凭据和服务配置。",
      });

export const resolveLocalPoolProvider = (
  driver: string,
  requested: LocalAccountProvider | undefined,
): LocalAccountProvider | undefined => {
  if (driver === "opencode")
    return requested === "codex" || requested === "xai" ? requested : undefined;
  if (driver === "byok") return requested;
  const expected =
    driver === "claudeAgent"
      ? "claude"
      : driver === "grok"
        ? "xai"
        : driver === "codex"
          ? "codex"
          : driver === "cursor"
            ? "cursor"
            : undefined;
  return expected !== undefined && (requested === undefined || requested === expected)
    ? expected
    : undefined;
};

export class CliProxy extends Context.Service<
  CliProxy,
  {
    readonly handle: (request: CliProxyRequest) => Effect.Effect<CliProxyResult, CliProxyError>;
  }
>()("codework/provider/CliProxy") {}

const inferProvider = (content: string, requested?: LocalAccountProvider): LocalAccountProvider => {
  if (requested !== undefined) return requested;
  try {
    const value: unknown = JSON.parse(content);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const raw = String(record.provider ?? record.type ?? "").toLowerCase();
      if (raw.includes("claude") || raw.includes("anthropic")) return "claude";
      if (raw.includes("grok") || raw.includes("xai")) return "xai";
      if (raw.includes("cursor")) return "cursor";
    }
  } catch {
    // importLocalAccount returns the user-facing JSON error below.
  }
  return "codex";
};

const accountIdFromName = (name: string): string => {
  const stem = name.replace(/\.json$/iu, "").trim();
  const normalized = stem
    .replace(/[^A-Za-z0-9_-]+/gu, "-")
    .replace(/^-+/u, "")
    .slice(0, 96);
  return /^[A-Za-z]/u.test(normalized) ? normalized : `account-${normalized || "import"}`;
};

/**
 * 将本地账号池一次性接到所有已有的兼容 CLI 实例。
 * 只接管当前已启用且有同平台账号的实例，保留用户对禁用实例的选择。
 */
export const autoRouteLocalAccountPool = (
  settings: ServerSettings,
  sourceInstanceId: ProviderInstanceId,
): Pick<ServerSettings, "providerInstances" | "localAccountPool"> => {
  const accounts = Object.values(settings.localAccountPool.accounts).filter(
    (account) => account.enabled && account.provider !== "cursor" && account.models.length > 0,
  );
  const accountIdsByProvider = new Map<LocalAccountProvider, string[]>();
  for (const account of accounts) {
    const ids = accountIdsByProvider.get(account.provider) ?? [];
    ids.push(String(account.id));
    accountIdsByProvider.set(account.provider, ids);
  }

  const instances: Record<string, ProviderInstanceConfig> = {
    ...(settings.providerInstances as Record<string, ProviderInstanceConfig>),
  };
  const legacyConfigs: ReadonlyArray<readonly [string, ProviderDriverKind, unknown]> = [
    ["codex", ProviderDriverKind.make("codex"), settings.providers.codex],
    ["claudeAgent", ProviderDriverKind.make("claudeAgent"), settings.providers.claudeAgent],
    ["grok", ProviderDriverKind.make("grok"), settings.providers.grok],
    ["opencode", ProviderDriverKind.make("opencode"), settings.providers.opencode],
  ];
  for (const [id, driver, config] of legacyConfigs) {
    if (!(id in instances)) instances[id] = { driver, config };
  }

  const providersForDriver = (driver: string): readonly LocalAccountProvider[] =>
    driver === "codex"
      ? ["codex"]
      : driver === "claudeAgent"
        ? ["claude"]
        : driver === "grok"
          ? ["xai"]
          : driver === "opencode"
            ? ["codex", "xai"]
            : [];

  for (const [instanceId, instance] of Object.entries(instances)) {
    if (!new Set(["codex", "claudeAgent", "grok", "opencode"]).has(instance.driver)) continue;
    if (!resolveProviderInstanceEnabled(instance)) continue;
    const accountIds = [
      ...new Set(
        providersForDriver(instance.driver).flatMap(
          (provider) => accountIdsByProvider.get(provider) ?? [],
        ),
      ),
    ];
    if (accountIds.length === 0) continue;
    const currentConfig =
      instance.config !== null &&
      typeof instance.config === "object" &&
      !Array.isArray(instance.config)
        ? (instance.config as Record<string, unknown>)
        : {};
    instances[instanceId] = {
      ...instance,
      config: {
        ...currentConfig,
        routeThroughByok: true,
        byokSourceInstanceId: sourceInstanceId,
      },
    };
  }

  return {
    providerInstances: instances,
    localAccountPool: {
      ...settings.localAccountPool,
      providerInstances: {
        ...settings.localAccountPool.providerInstances,
        [sourceInstanceId]: accounts.map((account) => account.id),
      },
    },
  };
};

export const makeCliProxyService = (
  runtime: CliProxyRuntime,
  settings: ServerSettingsService["Service"],
  secretStore: ServerSecretStore["Service"],
  serverOrigin: string,
) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const handle = Effect.fn("CliProxy.handle")(function* (request: CliProxyRequest) {
      let issuedExternalKey: string | undefined;
      switch (request.action) {
        case "configure":
          yield* setLocalAccountPoolStrategy(settings, request.config.strategy).pipe(
            Effect.mapError(safeError),
          );
          runtime.configure(request.config);
          break;
        case "importAccount": {
          const provider = inferProvider(request.content, request.provider);
          const id = accountIdFromName(request.name);
          yield* importLocalAccount(settings, secretStore, {
            id,
            provider,
            displayName: id,
            content: request.content,
          }).pipe(
            Effect.mapError(
              (error) => new CliProxyError({ code: "invalid_config", detail: error.message }),
            ),
          );
          break;
        }
        case "deleteAccount": {
          yield* removeLocalAccount(settings, secretStore, accountIdFromName(request.name)).pipe(
            Effect.mapError(
              (error) => new CliProxyError({ code: "invalid_config", detail: error.message }),
            ),
          );
          break;
        }
        case "setAccountEnabled": {
          yield* setLocalAccountEnabled(
            settings,
            accountIdFromName(request.name),
            request.enabled,
          ).pipe(
            Effect.mapError(
              (error) => new CliProxyError({ code: "invalid_config", detail: error.message }),
            ),
          );
          break;
        }
        case "localAccounts":
        case "accounts":
        case "status":
          break;
        case "setLocalAccountPoolStrategy":
          yield* setLocalAccountPoolStrategy(settings, request.strategy).pipe(
            Effect.mapError(safeError),
          );
          break;
        case "setLocalAccountWeight":
          yield* setLocalAccountWeight(settings, request.id as LocalAccountId, request.weight).pipe(
            Effect.mapError(safeError),
          );
          break;
        case "importLocalAccount":
          yield* importLocalAccount(settings, secretStore, request).pipe(
            Effect.mapError(
              (error) => new CliProxyError({ code: "invalid_config", detail: error.message }),
            ),
          );
          break;
        case "deleteLocalAccount":
          yield* removeLocalAccount(settings, secretStore, request.id).pipe(
            Effect.mapError(
              (error) => new CliProxyError({ code: "invalid_config", detail: error.message }),
            ),
          );
          break;
        case "setLocalAccountEnabled":
          yield* setLocalAccountEnabled(settings, request.id, request.enabled).pipe(
            Effect.mapError(
              (error) => new CliProxyError({ code: "invalid_config", detail: error.message }),
            ),
          );
          break;
        case "setLocalAccountsEnabled":
          yield* setLocalAccountsEnabled(settings, request.ids, request.enabled).pipe(
            Effect.mapError(
              (error) => new CliProxyError({ code: "invalid_config", detail: error.message }),
            ),
          );
          break;
        case "publishLocalAccountPool": {
          yield* settings
            .updateSettings((current) => {
              const instance = current.providerInstances[request.instanceId];
              if (
                instance === undefined ||
                !["byok", "codex", "claudeAgent", "cursor", "grok", "opencode"].includes(
                  instance.driver,
                )
              ) {
                throw new CliProxyError({
                  code: "invalid_config",
                  detail: "请选择一个官方 CLI 实例作为本地账号池入口。",
                });
              }
              const provider = resolveLocalPoolProvider(instance.driver, request.provider);
              if (provider === undefined)
                throw new CliProxyError({
                  code: "invalid_config",
                  detail: "本地账号平台与 CLI 实例不匹配。",
                });
              const accountIds = Object.values(current.localAccountPool.accounts)
                .filter((account) => account.provider === provider)
                .map((account) => account.id);
              if (accountIds.length === 0)
                throw new CliProxyError({
                  code: "invalid_config",
                  detail: "请先导入至少一个同平台账号。",
                });
              const currentConfig =
                instance.config !== null &&
                typeof instance.config === "object" &&
                !Array.isArray(instance.config)
                  ? (instance.config as Record<string, unknown>)
                  : {};
              const nextConfig =
                instance.driver === "byok" || instance.driver === "cursor"
                  ? currentConfig
                  : {
                      ...currentConfig,
                      routeThroughByok: true,
                      byokSourceInstanceId: request.instanceId,
                    };
              return {
                providerInstances: {
                  ...current.providerInstances,
                  [request.instanceId]: { ...instance, config: nextConfig },
                },
                localAccountPool: {
                  ...current.localAccountPool,
                  providerInstances: {
                    ...current.localAccountPool.providerInstances,
                    [request.instanceId]: accountIds,
                  },
                },
              };
            })
            .pipe(Effect.mapError(safeError));
          break;
        }
        case "externalGatewayKeys":
          break;
        case "createExternalGatewayKey":
        case "rotateExternalGatewayKey":
        case "revokeExternalGatewayKey":
          if (request.action === "createExternalGatewayKey") {
            const created = yield* createLocalGatewayKey(secretStore, request.name).pipe(
              Effect.mapError(safeError),
            );
            // issued key is returned below from the transient variable.
            issuedExternalKey = created.record.key;
          } else if (request.action === "rotateExternalGatewayKey") {
            const rotated = yield* rotateLocalGatewayKey(secretStore, request.id).pipe(
              Effect.mapError(safeError),
            );
            if (rotated === undefined)
              return yield* new CliProxyError({
                code: "invalid_config",
                detail: "外部访问 key 不存在。",
              });
            issuedExternalKey = rotated.record.key;
          } else {
            const revoked = yield* revokeLocalGatewayKey(secretStore, request.id).pipe(
              Effect.mapError(safeError),
            );
            if (!revoked)
              return yield* new CliProxyError({
                code: "invalid_config",
                detail: "外部访问 key 不存在。",
              });
          }
          break;
        case "connectByok": {
          const current = yield* settings.getSettings.pipe(Effect.mapError(safeError));
          const token = yield* ensureGatewayToken(secretStore);
          const adapters = localGatewayAdapters(current, serverOrigin, token, request.instanceId);
          if (adapters.length === 0)
            return yield* new CliProxyError({
              code: "invalid_config",
              detail: "请先导入并启用至少一个带模型声明的官方账号。",
            });
          const existing = current.providerInstances[request.instanceId];
          if (existing !== undefined && existing.driver !== "byok")
            return yield* new CliProxyError({
              code: "invalid_config",
              detail: "该实例名称已被其他配置使用，请选择新的实例名称。",
            });
          const accountIds = Object.values(current.localAccountPool.accounts)
            .filter(
              (account) =>
                account.enabled && account.provider !== "cursor" && account.models.length > 0,
            )
            .map((account) => account.id);
          const nextSource = {
            ...existing,
            driver: ProviderDriverKind.make("byok"),
            displayName: request.displayName,
            enabled: true,
            config: {
              ...decodeByokSettings(existing?.config ?? {}),
              enabled: true,
              adapters,
            },
          } satisfies ProviderInstanceConfig;
          const wired = autoRouteLocalAccountPool(
            {
              ...current,
              providerInstances: { ...current.providerInstances, [request.instanceId]: nextSource },
              localAccountPool: {
                ...current.localAccountPool,
                providerInstances: {
                  ...current.localAccountPool.providerInstances,
                  [request.instanceId]: accountIds,
                },
              },
            },
            request.instanceId,
          );
          yield* settings.updateSettings(wired).pipe(Effect.mapError(safeError));
          runtime.saveConnection(request.instanceId);
          break;
        }
      }

      const latest = yield* settings.getSettings.pipe(Effect.mapError(safeError));
      const localAccounts = Object.values(latest.localAccountPool.accounts);
      const gatewayKeys = yield* readLocalGatewayKeys(secretStore);
      const connectedInstanceId =
        runtime.connectedInstanceId ??
        (Object.entries(latest.localAccountPool.providerInstances).find(
          ([instanceId, accountIds]) => {
            const providerInstanceId = ProviderInstanceId.make(instanceId);
            if (
              accountIds.length === 0 ||
              latest.providerInstances[providerInstanceId]?.driver !== "byok"
            )
              return false;
            const config = latest.providerInstances[providerInstanceId]?.config;
            const adapters =
              config !== null && typeof config === "object" && !Array.isArray(config)
                ? (config as Record<string, unknown>).adapters
                : undefined;
            return (
              Array.isArray(adapters) &&
              adapters.some(
                (adapter: unknown) =>
                  adapter !== null &&
                  typeof adapter === "object" &&
                  !Array.isArray(adapter) &&
                  (adapter as Record<string, unknown>).supplierID === "codework-local-account",
              )
            );
          },
        )?.[0] as ProviderInstanceId | undefined);
      return {
        config: { strategy: latest.localAccountPool.strategy },
        running: true,
        version: "embedded",
        baseUrl: runtime.baseUrl,
        accounts: localAccounts.map((account) => projectCliProxyAccount(account)),
        localAccounts: localAccounts.map(
          ({ credentialRef: _credentialRef, ...summary }) => summary,
        ),
        localStrategy: latest.localAccountPool.strategy,
        externalGateway: {
          openaiBaseUrl: openaiGatewayBase(serverOrigin),
          anthropicBaseUrl: anthropicGatewayBase(serverOrigin),
          keys: summarizeLocalGatewayKeys(gatewayKeys),
          ...(issuedExternalKey === undefined ? {} : { issuedKey: issuedExternalKey }),
        },
        ...(connectedInstanceId === undefined ? {} : { connectedInstanceId }),
        // 已删除账号的历史计数继续留在存储里，但状态里只展示仍存在的账号。
        // 冷却只在仍有效时透出，过期时间戳对客户端是噪音。
        accountUsage: localPoolUsageStore
          .list()
          .filter((entry) => localAccounts.some((account) => String(account.id) === entry.id))
          .map(({ cooldownUntilUnixMs, ...usage }) =>
            cooldownUntilUnixMs !== undefined && cooldownUntilUnixMs > Date.now()
              ? { ...usage, cooldownUntilUnixMs }
              : usage,
          ),
      } satisfies CliProxyResult;
    });

    return CliProxy.of({
      handle: (request) =>
        handle(request).pipe(
          Effect.catchDefect((error) => Effect.fail(safeError(error))),
          lock.withPermit,
          Effect.uninterruptible,
        ),
    });
  });

export const layer = Layer.effect(
  CliProxy,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const secrets = yield* ServerSecretStore;
    const settings = yield* ServerSettingsService;
    const fs = yield* FileSystem.FileSystem;
    // 用量持久化：启动水合，定时落盘脏快照，关闭时补一次。
    yield* fs.readFile(config.localPoolUsagePath).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
      Effect.flatMap((bytes) => {
        const state =
          bytes === undefined
            ? undefined
            : parseLocalPoolUsageState(Buffer.from(bytes).toString("utf8"));
        if (state !== undefined) localPoolUsageStore.hydrate(state);
        return Effect.void;
      }),
    );
    const persistUsage = (snapshot: LocalPoolUsageState) =>
      fs
        .writeFile(config.localPoolUsagePath, Buffer.from(JSON.stringify(snapshot), "utf8"))
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to persist local pool usage", { cause }),
          ),
        );
    const flushFiber = yield* Effect.forkScoped(
      Effect.forever(
        Effect.flatMap(Effect.sleep("10 seconds"), () => {
          const snapshot = localPoolUsageStore.takeDirtySnapshot();
          return snapshot === undefined ? Effect.void : persistUsage(snapshot);
        }),
      ),
    );
    yield* Effect.addFinalizer(() =>
      Effect.flatMap(Fiber.interrupt(flushFiber), () => {
        const snapshot = localPoolUsageStore.takeDirtySnapshot();
        return snapshot === undefined ? Effect.void : persistUsage(snapshot);
      }),
    );
    const origin =
      config.host === undefined || ["0.0.0.0", "::"].includes(config.host)
        ? gatewayOrigin(config.port)
        : `http://${config.host}:${config.port}`;
    const runtime = new CliProxyRuntime(origin);
    runtime.config = { strategy: (yield* settings.getSettings).localAccountPool.strategy };
    return yield* makeCliProxyService(runtime, settings, secrets, origin);
  }),
);
