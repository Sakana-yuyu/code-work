// @effect-diagnostics globalDate:off - 冷却截止是否仍有效按墙上时间判断。
// @effect-diagnostics nodeBuiltinImport:off - 账号 ID 派生用 node:crypto。
import * as NodeCrypto from "node:crypto";

import {
  ByokSettings,
  CliProxyError,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type CliProxyAccountSubscription,
  type CliProxyRequest,
  type CliProxyResult,
  type ZCodeLoginRequest,
  type ZCodeLoginResult,
  type ZCodeLoginUser,
  type LocalAccountId,
  type LocalAccountProvider,
  type ProviderInstanceConfig,
  type ServerSettings,
} from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ServerConfig } from "../config.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  credentialAuthKind,
  importLocalAccount,
  localGatewayAdapters,
  readLocalAccountCredential,
  removeLocalAccount,
  setLocalAccountsEnabled,
  setLocalAccountEnabled,
  setLocalAccountPoolStrategy,
  setLocalAccountWeight,
} from "./LocalAccountPool.ts";
import {
  fetchLocalAccountSubscription,
  type AccountSubscriptionView,
} from "./localAccountUsage.ts";
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
  LOCAL_POOL_LOGIN_CREDENTIAL_FILE,
  isLocalPoolLoginProvider,
  localPoolLoginHome,
  nativeLoginCandidatePaths,
  nativeLoginLabel,
  type LocalPoolLoginProvider,
} from "./localPoolLogin.ts";
import { resolveZCodeDataDir } from "./zcode/zcodeByokConfig.ts";
import {
  ZCODE_LOGIN_TIMEOUT_MS,
  initZCodeOAuth,
  pollZCodeOAuthOnce,
  resolveCodingPlanApiKey,
  writeZCodeLoginCredentials,
  type ZCodeLoginInitResult,
  type ZCodeLoginReadyResult,
} from "./zcode/zcodeLoginFlow.ts";
import type { ZCodeFamily } from "./zcode/zcodeCredentials.ts";
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
  // zcode 账号是 Anthropic 协议端点；与 claude 账号一样可以供 Claude 系实例使用。
  if (driver === "claudeAgent")
    return requested === "zcode"
      ? "zcode"
      : requested === undefined || requested === "claude"
        ? "claude"
        : undefined;
  if (driver === "zcodeAgent")
    return requested === undefined || requested === "zcode" ? "zcode" : undefined;
  const expected =
    driver === "grok"
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
    /** ZCode 官方账号登录（服务端原生 OAuth 轮询流程，不依赖 zcode CLI）。 */
    readonly zcodeLogin: (
      request: ZCodeLoginRequest,
    ) => Effect.Effect<ZCodeLoginResult, CliProxyError>;
  }
>()("codework/provider/CliProxy") {}

interface CliProxyHostDeps {
  readonly stateDir: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly httpClient: HttpClient.HttpClient;
}

interface ZCodeLoginSessionState {
  readonly family: ZCodeFamily;
  readonly createdAtMs: number;
  status: "waiting" | "ready" | "failed" | "expired" | "cancelled";
  user?: ZCodeLoginUser;
  message?: string;
}

const ZCODE_LOGIN_SESSION_RETAIN_MS = 10 * 60 * 1000;

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
        ? ["claude", "zcode"]
        : driver === "grok"
          ? ["xai"]
          : driver === "opencode"
            ? ["codex", "xai"]
            : driver === "zcodeAgent"
              ? ["codex", "claude", "xai", "zcode"]
              : [];

  for (const [instanceId, instance] of Object.entries(instances)) {
    if (!new Set(["codex", "claudeAgent", "grok", "opencode", "zcodeAgent"]).has(instance.driver))
      continue;
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
        // ZCode 恒走网关，没有 routeThroughByok 开关，只需要指定来源实例。
        ...(instance.driver === "zcodeAgent" ? {} : { routeThroughByok: true }),
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

/** 号池登录的凭据读取/清理；由 layer 注入，测试可省略。 */
export interface CliProxyLoginStore {
  readonly readCredential: (
    provider: LocalPoolLoginProvider,
    terminalId: string,
  ) => Effect.Effect<string | undefined>;
  readonly cleanup: (terminalId: string) => Effect.Effect<void>;
}

const LOGIN_PROVIDER_LABEL: Record<LocalPoolLoginProvider, string> = {
  codex: "Codex",
  claude: "Claude",
  xai: "Grok",
  zcode: "ZCode",
};

/** 原生落点 → 稳定的号池账号 ID：扫描标记与导入共用，保证"已导入"判定一致。 */
const nativeAccountId = (provider: string, path: string): string =>
  `native-${provider}-${NodeCrypto.createHash("sha256").update(path).digest("hex").slice(0, 10)}`;

/** 把可选 models 列表合并进凭据 JSON；解析失败时原样返回（交给 importLocalAccount 归一化）。 */
const mergeModelsIntoCredential = (
  raw: string,
  models: ReadonlyArray<string> | undefined,
): string => {
  const trimmed = (models ?? []).map((model) => model.trim()).filter(Boolean);
  if (trimmed.length === 0) return raw;
  try {
    const record = JSON.parse(raw) as Record<string, unknown>;
    if (record !== null && typeof record === "object" && !Array.isArray(record)) {
      return JSON.stringify({ ...record, models: trimmed });
    }
  } catch {
    // fallthrough
  }
  return raw;
};

export const makeCliProxyService = (
  runtime: CliProxyRuntime,
  settings: ServerSettingsService["Service"],
  secretStore: ServerSecretStore["Service"],
  serverOrigin: string,
  loginStore?: CliProxyLoginStore,
  hostDeps?: CliProxyHostDeps,
) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const zcodeLoginSessions = new Map<string, ZCodeLoginSessionState>();

    const pruneZCodeLoginSessions = (nowMs: number): void => {
      const cutoff = nowMs - ZCODE_LOGIN_SESSION_RETAIN_MS;
      for (const [id, session] of zcodeLoginSessions) {
        if (session.status !== "waiting" && session.createdAtMs < cutoff) {
          zcodeLoginSessions.delete(id);
        }
      }
    };

    const runZCodeLoginSession = (
      init: ZCodeLoginInitResult,
      family: ZCodeFamily,
      home: string,
      session: ZCodeLoginSessionState,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const deps = hostDeps!;
        const startedMs = yield* Clock.currentTimeMillis;
        const deadlineMs = Math.min(startedMs + ZCODE_LOGIN_TIMEOUT_MS, init.expiresAtSec * 1000);
        let ready: ZCodeLoginReadyResult | undefined;
        while ((yield* Clock.currentTimeMillis) < deadlineMs && session.status === "waiting") {
          const step = yield* pollZCodeOAuthOnce(init, family).pipe(
            Effect.provideService(HttpClient.HttpClient, deps.httpClient),
          );
          if (step === "pending") {
            yield* Effect.sleep(Duration.seconds(init.pollIntervalSec));
          } else {
            // ready 后必须退出循环：继续轮询会把限流端点打满（429），
            // session 停在 waiting，前端永远等不到终态。
            ready = step;
            break;
          }
        }
        if (session.status !== "waiting") return;
        if (ready === undefined) {
          session.status = "expired";
          session.message = "授权超时，请重新发起登录。";
          return;
        }
        const apiKey = yield* resolveCodingPlanApiKey(family, ready.accessToken).pipe(
          Effect.provideService(HttpClient.HttpClient, deps.httpClient),
        );
        yield* writeZCodeLoginCredentials({
          dataBaseDir: home,
          family,
          ready,
          apiKey,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, deps.fileSystem),
          Effect.provideService(Path.Path, deps.path),
        );
        session.user = {
          userId: ready.userId,
          ...(ready.email === undefined ? {} : { email: ready.email }),
          ...(ready.name === undefined ? {} : { name: ready.name }),
          ...(ready.avatar === undefined ? {} : { avatar: ready.avatar }),
        };
        session.status = "ready";
      }).pipe(
        Effect.catchTag("ZCodeLoginError", (error) =>
          Effect.sync(() => {
            if (session.status === "waiting") {
              session.status = "failed";
              session.message = error.detail;
            }
          }),
        ),
        Effect.catchDefect((error) =>
          Effect.sync(() => {
            if (session.status === "waiting") {
              session.status = "failed";
              session.message = `ZCode 登录异常：${
                error instanceof Error ? error.message : String(error)
              }`;
            }
          }),
        ),
      );

    const zcodeLogin = Effect.fn("CliProxy.zcodeLogin")(function* (
      request: ZCodeLoginRequest,
    ): Effect.fn.Return<ZCodeLoginResult, CliProxyError> {
      if (hostDeps === undefined) {
        return yield* new CliProxyError({
          code: "invalid_config",
          detail: "ZCode 登录未初始化。",
        });
      }
      switch (request.action) {
        case "start": {
          const init = yield* initZCodeOAuth(request.family).pipe(
            Effect.provideService(HttpClient.HttpClient, hostDeps.httpClient),
            Effect.mapError(
              (error) => new CliProxyError({ code: "upstream_error", detail: error.detail }),
            ),
          );
          const home =
            request.poolLogin === true
              ? localPoolLoginHome(hostDeps.stateDir, init.sessionId)
              : resolveZCodeDataDir({
                  stateDir: hostDeps.stateDir,
                  instanceId: request.instanceId ?? ProviderInstanceId.make("zcodeAgent"),
                });
          const session: ZCodeLoginSessionState = {
            family: request.family,
            createdAtMs: yield* Clock.currentTimeMillis,
            status: "waiting",
          };
          zcodeLoginSessions.set(init.sessionId, session);
          yield* Effect.forkDetach(runZCodeLoginSession(init, request.family, home, session));
          return {
            action: "start",
            sessionId: init.sessionId,
            authorizeUrl: init.authorizeUrl,
            expiresAtSec: init.expiresAtSec,
          };
        }
        case "status": {
          pruneZCodeLoginSessions(yield* Clock.currentTimeMillis);
          const session = zcodeLoginSessions.get(request.sessionId);
          if (session === undefined) {
            return {
              action: "status",
              status: "failed",
              message: "登录会话不存在或已过期，请重新开始。",
            };
          }
          return {
            action: "status",
            status: session.status,
            ...(session.user === undefined ? {} : { user: session.user }),
            ...(session.message === undefined ? {} : { message: session.message }),
          };
        }
        case "cancel": {
          const session = zcodeLoginSessions.get(request.sessionId);
          if (session !== undefined && session.status === "waiting") {
            session.status = "cancelled";
          }
          return {
            action: "status",
            status: session?.status ?? "cancelled",
          };
        }
      }
    });
    const handle = Effect.fn("CliProxy.handle")(function* (request: CliProxyRequest) {
      let issuedExternalKey: string | undefined;
      let nativeLogins:
        | ReadonlyArray<{
            provider: LocalPoolLoginProvider;
            path: string;
            label?: string;
            imported: boolean;
          }>
        | undefined;
      let accountSubscriptions: ReadonlyArray<CliProxyAccountSubscription> | undefined;
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
        case "scanNativeAccounts": {
          if (hostDeps === undefined) break;
          const current = yield* settings.getSettings.pipe(Effect.mapError(safeError));
          const candidates = nativeLoginCandidatePaths({
            stateDir: hostDeps.stateDir,
            settings: current,
          });
          const poolIds = new Set(Object.keys(current.localAccountPool.accounts));
          const logins: Array<{
            provider: LocalPoolLoginProvider;
            path: string;
            label?: string;
            imported: boolean;
          }> = [];
          for (const candidate of candidates) {
            const exists = yield* hostDeps.fileSystem
              .exists(candidate.path)
              .pipe(Effect.orElseSucceed(() => false));
            if (!exists) continue;
            const content = yield* hostDeps.fileSystem
              .readFileString(candidate.path)
              .pipe(Effect.option);
            const label =
              Option.isSome(content) && content.value.length <= 1_048_576
                ? nativeLoginLabel(candidate.provider, content.value)
                : undefined;
            logins.push({
              provider: candidate.provider,
              path: candidate.path,
              ...(label === undefined ? {} : { label }),
              imported: poolIds.has(nativeAccountId(candidate.provider, candidate.path)),
            });
          }
          nativeLogins = logins;
          break;
        }
        case "importNativeAccount": {
          if (hostDeps === undefined) {
            return yield* new CliProxyError({
              code: "invalid_config",
              detail: "当前环境不支持从本机导入账号。",
            });
          }
          if (!isLocalPoolLoginProvider(request.provider)) {
            return yield* new CliProxyError({
              code: "invalid_config",
              detail: "该平台暂不支持导入官方账号。",
            });
          }
          const current = yield* settings.getSettings.pipe(Effect.mapError(safeError));
          const resolvedPath = hostDeps.path.resolve(request.path);
          const target = nativeLoginCandidatePaths({
            stateDir: hostDeps.stateDir,
            settings: current,
          }).find(
            (candidate) =>
              candidate.provider === request.provider && candidate.path === resolvedPath,
          );
          // 只接受扫描白名单内的路径，避免把任意文件写进号池。
          if (target === undefined) {
            return yield* new CliProxyError({
              code: "invalid_config",
              detail: "该凭据路径不在可导入列表中，请先重新扫描。",
            });
          }
          const rawContent = yield* hostDeps.fileSystem.readFileString(target.path).pipe(
            Effect.mapError(
              () =>
                new CliProxyError({
                  code: "invalid_config",
                  detail: "凭据文件不存在或不可读。",
                }),
            ),
          );
          const content = mergeModelsIntoCredential(rawContent, request.models);
          const label = nativeLoginLabel(request.provider, rawContent);
          // ID 由路径派生：同一路径再次导入覆盖同一个号池账号，不会越导越多。
          const id = nativeAccountId(request.provider, resolvedPath);
          yield* importLocalAccount(settings, secretStore, {
            id,
            provider: request.provider,
            displayName: request.displayName?.trim() || label || id,
            content,
          }).pipe(
            Effect.mapError(
              (error) => new CliProxyError({ code: "invalid_config", detail: error.message }),
            ),
          );
          break;
        }
        case "importLocalLogin": {
          if (!isLocalPoolLoginProvider(request.provider) || loginStore === undefined) {
            return yield* new CliProxyError({
              code: "invalid_config",
              detail: "该平台暂不支持登录添加账号，请改用导入文件。",
            });
          }
          const content = yield* loginStore.readCredential(request.provider, request.terminalId);
          if (content === undefined) {
            return yield* new CliProxyError({
              code: "invalid_config",
              detail:
                "没有找到登录凭据：请先在终端里完成登录；macOS 钥匙串里的登录态无法导入，请改用导入文件。",
            });
          }
          const id = `${request.provider}-${request.terminalId.replaceAll("-", "").slice(0, 8)}`;
          const models = request.models ?? [];
          const withModels = (() => {
            if (models.length === 0) return content;
            try {
              const value: unknown = JSON.parse(content);
              return value !== null && typeof value === "object" && !Array.isArray(value)
                ? JSON.stringify({ ...(value as Record<string, unknown>), models })
                : content;
            } catch {
              return content;
            }
          })();
          yield* importLocalAccount(settings, secretStore, {
            id,
            provider: request.provider,
            // ZCode 凭据自带账号名（user_info），留空让导入逻辑取真实账号名。
            displayName:
              request.displayName?.trim() ||
              (request.provider === "zcode"
                ? ""
                : `${LOGIN_PROVIDER_LABEL[request.provider]} ${id}`),
            content: withModels,
          }).pipe(
            Effect.mapError(
              (error) => new CliProxyError({ code: "invalid_config", detail: error.message }),
            ),
          );
          yield* loginStore.cleanup(request.terminalId);
          break;
        }
        case "localAccountUsage": {
          if (hostDeps === undefined) break;
          const current = yield* settings.getSettings.pipe(Effect.mapError(safeError));
          const poolAccounts = Object.values(current.localAccountPool.accounts);
          accountSubscriptions = yield* Effect.all(
            poolAccounts.map((account) =>
              readLocalAccountCredential(account, secretStore).pipe(
                Effect.flatMap((credential) =>
                  fetchLocalAccountSubscription({
                    account,
                    credential,
                    authKind: account.authKind ?? credentialAuthKind(credential),
                  }),
                ),
                Effect.orElseSucceed(
                  (): AccountSubscriptionView => ({ windows: [], error: "凭据读取失败" }),
                ),
                Effect.map((view) => ({
                  id: account.id,
                  ...(view.plan === undefined ? {} : { plan: view.plan }),
                  ...(view.status === undefined ? {} : { status: view.status }),
                  ...(view.expiresAt === undefined ? {} : { expiresAt: view.expiresAt }),
                  windows: view.windows,
                  ...(view.metrics === undefined ? {} : { metrics: view.metrics }),
                  ...(view.detail === undefined ? {} : { detail: view.detail }),
                  ...(view.error === undefined ? {} : { error: view.error }),
                })),
              ),
            ),
            { concurrency: "unbounded" },
          ).pipe(Effect.provideService(HttpClient.HttpClient, hostDeps.httpClient));
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
        ...(nativeLogins === undefined ? {} : { nativeLogins }),
        ...(accountSubscriptions === undefined ? {} : { accountSubscriptions }),
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
      zcodeLogin: (request) => zcodeLogin(request),
    });
  });

export const layer = Layer.effect(
  CliProxy,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const secrets = yield* ServerSecretStore;
    const settings = yield* ServerSettingsService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;
    // 用量持久化：启动水合，定时落盘脏快照，关闭时补一次。
    yield* fs.readFile(config.localPoolUsagePath).pipe(
      Effect.orElseSucceed(() => undefined),
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
    const loginStore: CliProxyLoginStore = {
      readCredential: (provider, terminalId) =>
        fs
          .readFileString(
            `${localPoolLoginHome(config.stateDir, terminalId)}/${LOCAL_POOL_LOGIN_CREDENTIAL_FILE[provider]}`,
          )
          .pipe(Effect.orElseSucceed(() => undefined)),
      cleanup: (terminalId) =>
        fs
          .remove(localPoolLoginHome(config.stateDir, terminalId), { recursive: true, force: true })
          .pipe(Effect.ignore),
    };
    return yield* makeCliProxyService(runtime, settings, secrets, origin, loginStore, {
      stateDir: config.stateDir,
      fileSystem: fs,
      path,
      httpClient,
    });
  }),
);
