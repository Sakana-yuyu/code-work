// @effect-diagnostics globalDate:off - 调度冷却和 OAuth 过期判断使用墙上时间。
// @effect-diagnostics globalDateInEffect:off - 调度冷却和 OAuth 过期判断使用墙上时间。
// @effect-diagnostics preferSchemaOverJson:off - 官方凭据格式是跨 CLI 的未知 JSON。
// @effect-diagnostics instanceOfSchema:off - 只在错误归一化边界识别本地错误。
import * as NodeCrypto from "node:crypto";
import {
  ByokModelAdapter,
  LocalAccountProvider,
  type LocalAccount,
  type LocalAccountAuthKind,
  type LocalAccountId,
  type LocalAccountPoolStrategy,
  type ProviderInstanceConfig,
  type ServerSettings,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import type { ServerSettingsService } from "../serverSettings.ts";
import { localPoolUsageStore } from "./LocalPoolUsage.ts";

const decodeProvider = (value: string): LocalAccountProvider | undefined =>
  value === "codex" || value === "claude" || value === "xai" || value === "cursor"
    ? value
    : undefined;

const decodeByokAdapter = Schema.decodeUnknownSync(ByokModelAdapter);

export class LocalAccountError extends Schema.TaggedErrorClass<LocalAccountError>()(
  "LocalAccountError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const parseLocalCredential = (
  content: string,
  provider?: LocalAccountProvider,
): Record<string, unknown> => {
  const value: unknown = JSON.parse(content);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalAccountError({ detail: "账号凭据必须是 JSON 对象。" });
  }
  const record = value as Record<string, unknown>;
  // Codex/Claude 使用嵌套 token envelope；Grok 官方 auth.json 使用登录 URL 作为键。
  const grokEnvelope =
    provider === undefined || provider === "xai"
      ? Object.entries(record).find(
          ([key, value]) =>
            (key === "https://accounts.x.ai/sign-in" ||
              key.startsWith("https://auth.x.ai::") ||
              key === "xai::api_key") &&
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value),
        )?.[1]
      : undefined;
  const nestedValue = record.tokens ?? record.claudeAiOauth ?? grokEnvelope;
  const nested =
    nestedValue !== null && typeof nestedValue === "object" && !Array.isArray(nestedValue)
      ? (nestedValue as Record<string, unknown>)
      : {};
  const normalized = {
    ...record,
    ...nested,
    access_token:
      record.access_token ?? record.accessToken ?? nested.access_token ?? nested.accessToken,
    refresh_token:
      record.refresh_token ?? record.refreshToken ?? nested.refresh_token ?? nested.refreshToken,
    api_key:
      record.api_key ??
      record.apiKey ??
      (provider === undefined || provider === "codex" ? record.OPENAI_API_KEY : undefined) ??
      (provider === undefined || provider === "claude" ? record.ANTHROPIC_API_KEY : undefined) ??
      (provider === undefined || provider === "xai" ? record.XAI_API_KEY : undefined) ??
      nested.api_key ??
      nested.apiKey ??
      (provider === undefined || provider === "codex" ? nested.OPENAI_API_KEY : undefined) ??
      (provider === undefined || provider === "claude" ? nested.ANTHROPIC_API_KEY : undefined) ??
      (provider === undefined || provider === "xai" ? nested.XAI_API_KEY : undefined),
    auth_token: record.auth_token ?? record.authToken ?? nested.auth_token ?? nested.authToken,
    account_id: record.account_id ?? nested.account_id,
    expires_in: record.expires_in ?? nested.expires_in,
    auth_kind:
      record.auth_kind ??
      record.authKind ??
      (grokEnvelope !== undefined && nested.auth_mode === "api_key"
        ? "api-key"
        : grokEnvelope !== undefined
          ? "oauth"
          : undefined),
  };
  const tokenKeys = ["access_token", "api_key", "auth_token", "token", "key"];
  if (
    !tokenKeys.some((key) => {
      const value = normalized[key as keyof typeof normalized];
      return typeof value === "string" && value.trim().length > 0;
    })
  ) {
    throw new LocalAccountError({
      detail: "账号凭据缺少 access_token、api_key、auth_token 或 token。",
    });
  }
  return normalized;
};

export const credentialToken = (
  credential: Record<string, unknown>,
  authKind: LocalAccountAuthKind = credentialAuthKind(credential),
): string | undefined => {
  const keys =
    authKind === "api-key"
      ? ["api_key", "apiKey", "auth_token", "authToken", "key", "token"]
      : ["access_token", "accessToken", "token", "key"];
  for (const key of keys) {
    const value = credential[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
};

/** Cursor ACP 只接受 CLI 启动参数/环境变量；凭据字段必须显式对应官方参数。 */
export const cursorCredentialEnvironment = (
  credential: Record<string, unknown>,
): { readonly CURSOR_API_KEY?: string; readonly CURSOR_AUTH_TOKEN?: string } => {
  const authToken = ["auth_token", "authToken"]
    .map((key) => credential[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (authToken) return { CURSOR_AUTH_TOKEN: authToken.trim() };
  const apiKey = ["api_key", "apiKey", "key", "token"]
    .map((key) => credential[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return apiKey ? { CURSOR_API_KEY: apiKey.trim() } : {};
};

/** 仅按凭据内容判定认证方式；同时存在 refresh/access token 时始终按 OAuth 处理。 */
export const credentialAuthKind = (credential: Record<string, unknown>): LocalAccountAuthKind => {
  const explicit = credential.auth_kind ?? credential.authKind;
  if (explicit === "oauth" || explicit === "api-key") return explicit;
  if (
    ["access_token", "accessToken", "refresh_token", "refreshToken"].some(
      (key) => typeof credential[key] === "string" && credential[key].trim(),
    )
  )
    return "oauth";
  return "api-key";
};

const cursor = new Map<string, number>();
const MAX_LOCAL_ACCOUNT_WEIGHT = 99;
// 冷却截止存在 localPoolUsageStore 里（随 local-pool-usage.json 持久化），
// 服务器重启后限流账号不会立刻被再次选中。
const needsRefresh = new Set<string>();
const refreshLocks = new Map<string, Semaphore.Semaphore>();

export const pickLocalAccount = (
  settings: ServerSettings,
  provider: LocalAccountProvider,
  candidateIds?: readonly string[],
  model?: string,
): LocalAccount | undefined => {
  const pool = settings.localAccountPool ?? {
    accounts: {},
    strategy: "round-robin" as const,
    providerInstances: {},
  };
  const source =
    candidateIds === undefined
      ? Object.values(pool.accounts)
      : candidateIds
          .map((id) => pool.accounts[id as LocalAccountId])
          .filter((account): account is LocalAccount => account !== undefined);
  const now = Date.now();
  const all = source.filter(
    (account) =>
      account.provider === provider &&
      account.enabled &&
      (model === undefined || account.models.length === 0 || account.models.includes(model)) &&
      (localPoolUsageStore.cooldownUntilUnixMs(String(account.id)) ?? 0) <= now,
  );
  if (all.length === 0) return undefined;
  if (pool.strategy === "fill-first") return all[0];
  // ponytail: 以账号子集隔离轮询游标，避免不同 CLI 池共享偏移；账号数量较少，排序扫描成本可忽略。
  // weighted-round-robin 把账号按权重展开成重复槽位后轮询，权重越大分到的调用越多；
  // 权重缺省或小于 1 时按 1 处理，避免权重 0 造成账号不可见。
  const slots =
    pool.strategy === "weighted-round-robin"
      ? all.flatMap((account) =>
          Array.from(
            { length: Math.min(MAX_LOCAL_ACCOUNT_WEIGHT, Math.max(1, account.weight ?? 1)) },
            () => account,
          ),
        )
      : all;
  const cursorKey = `${pool.strategy}:${provider}:${all
    .map((account) => String(account.id))
    .sort()
    .join(",")}`;
  const offset = cursor.get(cursorKey) ?? 0;
  cursor.set(cursorKey, (offset + 1) % slots.length);
  return slots[offset % slots.length];
};

/** 上游限流/鉴权失败只冷却当前账号，避免把整个账号池判死。 */
export const markLocalAccountFailure = (id: string, status: number): void => {
  if (status === 401) needsRefresh.add(id);
  if (status === 401 || status === 403 || status === 429 || status >= 500) {
    localPoolUsageStore.setCooldown(id, Date.now() + (status === 429 ? 60_000 : 15_000));
  }
};

const credentialExpiry = (credential: Record<string, unknown>): number | undefined => {
  if (credential.expired === true) return 0;
  const value = credential.expiresAt ?? credential.expires_at;
  if (typeof value === "number") return value < 1_000_000_000_000 ? value * 1000 : value;
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0)
      return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof credential.expires_in === "number" && credential.expires_in > 0)
    return Date.now() + credential.expires_in * 1000;
  return undefined;
};

/** 官方 OAuth 刷新在每账号锁内重读凭据，防止并发复用一次性 refresh_token。 */
export const ensureLocalAccountCredential = (
  account: LocalAccount,
  secretStore: ServerSecretStore["Service"],
  httpClient: HttpClient.HttpClient,
): Effect.Effect<Record<string, unknown>, LocalAccountError> => {
  const key = String(account.id);
  const lock = refreshLocks.get(key) ?? Semaphore.makeUnsafe(1);
  refreshLocks.set(key, lock);
  return Effect.gen(function* () {
    const credential = yield* readLocalAccountCredential(account, secretStore);
    const expiry = credentialExpiry(credential);
    const refreshToken = credential.refresh_token;
    if (
      !needsRefresh.has(key) &&
      credentialToken(credential, account.authKind ?? credentialAuthKind(credential)) &&
      (expiry === undefined || expiry > Date.now() + 60_000)
    )
      return credential;
    if (typeof refreshToken !== "string" || !refreshToken.trim()) {
      return yield* new LocalAccountError({
        detail: "官方账号令牌已过期，请重新登录或导入包含 refresh_token 的凭据。",
      });
    }
    const endpoint =
      account.provider === "codex"
        ? "https://auth.openai.com/oauth/token"
        : account.provider === "claude"
          ? "https://platform.claude.com/v1/oauth/token"
          : "https://auth.x.ai/oauth2/token";
    const clientId =
      account.provider === "codex"
        ? "app_EMoamEEZ73f0CkXaXp7hrann"
        : account.provider === "claude"
          ? "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
          : "b1a00492-073a-47ea-816f-4c329264a828";
    const fields = {
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    };
    const body =
      account.provider === "claude"
        ? JSON.stringify({
            ...fields,
            scope:
              "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
          })
        : new URLSearchParams(fields).toString();
    const response = yield* httpClient
      .execute(
        HttpClientRequest.post(endpoint).pipe(
          HttpClientRequest.bodyText(
            body,
            account.provider === "claude"
              ? "application/json"
              : "application/x-www-form-urlencoded",
          ),
        ),
      )
      .pipe(Effect.mapError(() => new LocalAccountError({ detail: "无法连接官方令牌刷新端点。" })));
    if (response.status < 200 || response.status >= 300) {
      markLocalAccountFailure(key, response.status);
      return yield* new LocalAccountError({
        detail: `官方账号刷新失败（HTTP ${response.status}），请重新登录。`,
      });
    }
    const raw = yield* response.text.pipe(
      Effect.mapError(() => new LocalAccountError({ detail: "无法读取官方刷新结果。" })),
    );
    const refreshed = yield* Effect.try({
      try: () => parseLocalCredential(raw),
      catch: () => new LocalAccountError({ detail: "官方刷新结果缺少有效令牌。" }),
    });
    if (!credentialToken(refreshed, "oauth"))
      return yield* new LocalAccountError({ detail: "官方刷新结果缺少访问令牌。" });
    const next: Record<string, unknown> = {
      ...credential,
      ...refreshed,
      refresh_token:
        typeof refreshed.refresh_token === "string" ? refreshed.refresh_token : refreshToken,
      account_id: refreshed.account_id ?? credential.account_id,
      expires_at:
        Date.now() +
        (typeof refreshed.expires_in === "number" ? refreshed.expires_in : 3600) * 1000,
    };
    delete next.expired;
    delete next.expiresAt;
    yield* secretStore
      .set(account.credentialRef, Buffer.from(JSON.stringify(next), "utf8"))
      .pipe(Effect.mapError(() => new LocalAccountError({ detail: "刷新后的凭据保存失败。" })));
    needsRefresh.delete(key);
    return next;
  }).pipe(lock.withPermit);
};

export const readLocalAccountCredential = (
  account: LocalAccount,
  secretStore: ServerSecretStore["Service"],
): Effect.Effect<Record<string, unknown>, LocalAccountError> =>
  secretStore.get(account.credentialRef).pipe(
    Effect.mapError(() => new LocalAccountError({ detail: "读取本地账号凭据失败。" })),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new LocalAccountError({ detail: "本地账号凭据不存在，请重新导入。" })),
        onSome: (bytes) =>
          Effect.try({
            try: () => parseLocalCredential(Buffer.from(bytes).toString("utf8"), account.provider),
            catch: () => new LocalAccountError({ detail: "本地账号凭据格式无效。" }),
          }),
      }),
    ),
  );

export const importLocalAccount = (
  settings: ServerSettingsService["Service"],
  secretStore: ServerSecretStore["Service"],
  input: { id: string; provider: string; displayName: string; content: string },
): Effect.Effect<LocalAccount, LocalAccountError> =>
  Effect.gen(function* () {
    const provider = decodeProvider(input.provider);
    if (provider === undefined)
      return yield* new LocalAccountError({ detail: "不支持的官方账号平台。" });
    const id = input.id.trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,95}$/u.test(id)) {
      return yield* new LocalAccountError({
        detail: "账号 ID 只能包含字母、数字、下划线和短横线。",
      });
    }
    const content = input.content.trim();
    const credential = yield* Effect.try({
      try: () => parseLocalCredential(content, provider),
      catch: (error) =>
        error instanceof LocalAccountError
          ? error
          : new LocalAccountError({ detail: "账号凭据 JSON 无效。" }),
    });
    const models = Array.isArray(credential.models)
      ? credential.models.filter(
          (model): model is string => typeof model === "string" && model.trim().length > 0,
        )
      : typeof credential.model === "string" && credential.model.trim().length > 0
        ? [credential.model.trim()]
        : [];
    // 官方 CLI 的 auth 文件通常只包含 OAuth/API 凭据，不会声明模型；空模型列表表示由对应 CLI/请求模型决定能力。
    const credentialRef = `local-account-${id}-${NodeCrypto.createHash("sha256").update(id).digest("hex").slice(0, 12)}`;
    const previousCredential = yield* secretStore
      .get(credentialRef)
      .pipe(Effect.catch(() => Effect.succeed(Option.none<Uint8Array>())));
    const expiresIn =
      typeof credential.expires_in === "number" && credential.expires_in > 0
        ? credential.expires_in
        : undefined;
    const persistedCredential =
      expiresIn === undefined || credential.expires_at !== undefined
        ? credential
        : { ...credential, expires_at: Date.now() + expiresIn * 1000 };
    yield* secretStore
      .set(credentialRef, Buffer.from(JSON.stringify(persistedCredential), "utf8"))
      .pipe(Effect.mapError(() => new LocalAccountError({ detail: "保存本地账号凭据失败。" })));
    const localAccountId = id as LocalAccountId;
    const account: LocalAccount = {
      id: localAccountId,
      provider,
      authKind: credentialAuthKind(credential),
      displayName: input.displayName.trim() || id,
      credentialRef,
      enabled: true,
      models,
    };
    needsRefresh.delete(id);
    localPoolUsageStore.setCooldown(id, null);
    const settingsSave = yield* settings
      .updateSettings((current) => {
        const previousAccount = current.localAccountPool.accounts[localAccountId];
        const autoRoutedByokInstances = new Set(
          Object.entries(current.providerInstances)
            .filter(([, instance]) => {
              if (instance.driver !== "byok") return false;
              const config = instance.config;
              return (
                config !== null &&
                typeof config === "object" &&
                !Array.isArray(config) &&
                (() => {
                  const adapters = (config as Record<string, unknown>).adapters;
                  return (
                    Array.isArray(adapters) &&
                    adapters.some(
                      (adapter: unknown) =>
                        adapter !== null &&
                        typeof adapter === "object" &&
                        !Array.isArray(adapter) &&
                        (adapter as Record<string, unknown>).supplierID ===
                          "codework-local-account",
                    )
                  );
                })()
              );
            })
            .map(([instanceId]) => instanceId),
        );
        const providerInstances = Object.fromEntries(
          Object.entries(current.localAccountPool.providerInstances).map(
            ([instanceId, accountIds]) => {
              const withoutImportedAccount = accountIds.filter(
                (accountId) => accountId !== localAccountId,
              );
              const wasBound = withoutImportedAccount.length !== accountIds.length;
              if (wasBound && previousAccount?.provider === provider) {
                return [instanceId, accountIds] as const;
              }
              if (autoRoutedByokInstances.has(instanceId) && provider !== "cursor") {
                return [instanceId, [...withoutImportedAccount, localAccountId]] as const;
              }
              const boundProviders = new Set(
                withoutImportedAccount
                  .map(
                    (accountId) =>
                      current.localAccountPool.accounts[accountId as LocalAccountId]?.provider,
                  )
                  .filter((value): value is LocalAccountProvider => value !== undefined),
              );
              return [
                instanceId,
                boundProviders.has(provider)
                  ? [...withoutImportedAccount, localAccountId]
                  : withoutImportedAccount,
              ] as const;
            },
          ),
        ) as ServerSettings["localAccountPool"]["providerInstances"];
        const localAccountPool = {
          ...current.localAccountPool,
          accounts: { ...current.localAccountPool.accounts, [id]: account },
          providerInstances,
        };
        return {
          localAccountPool,
          ...refreshLocalPoolInstanceAdapters({ ...current, localAccountPool }),
        };
      })
      .pipe(Effect.exit);
    if (Exit.isFailure(settingsSave)) {
      if (Option.isSome(previousCredential)) {
        yield* secretStore.set(credentialRef, previousCredential.value).pipe(Effect.ignore);
      } else {
        yield* secretStore.remove(credentialRef).pipe(Effect.ignore);
      }
      return yield* new LocalAccountError({ detail: "保存本地账号设置失败，已回滚凭据。" });
    }
    return account;
  });

export const removeLocalAccount = (
  settings: ServerSettingsService["Service"],
  secretStore: ServerSecretStore["Service"],
  id: string,
): Effect.Effect<void, LocalAccountError> =>
  Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() => new LocalAccountError({ detail: "读取本地账号设置失败。" })),
    );
    const account = current.localAccountPool.accounts[id as LocalAccountId];
    if (account === undefined) return;
    const previousCredential = yield* secretStore
      .get(account.credentialRef)
      .pipe(Effect.catch(() => Effect.succeed(Option.none<Uint8Array>())));
    yield* secretStore
      .remove(account.credentialRef)
      .pipe(Effect.mapError(() => new LocalAccountError({ detail: "删除本地账号凭据失败。" })));
    const accounts = { ...current.localAccountPool.accounts };
    delete accounts[id as LocalAccountId];
    const providerInstances = Object.fromEntries(
      Object.entries(current.localAccountPool.providerInstances).map(([instanceId, accountIds]) => [
        instanceId,
        accountIds.filter((accountId) => accountId !== id),
      ]),
    );
    const localAccountPool = { ...current.localAccountPool, accounts, providerInstances };
    const settingsSave = yield* settings
      .updateSettings({
        localAccountPool,
        ...refreshLocalPoolInstanceAdapters({ ...current, localAccountPool }),
      })
      .pipe(Effect.exit);
    if (Exit.isFailure(settingsSave)) {
      if (Option.isSome(previousCredential))
        yield* secretStore.set(account.credentialRef, previousCredential.value).pipe(Effect.ignore);
      return yield* new LocalAccountError({ detail: "删除本地账号设置失败，已恢复凭据。" });
    }
  });

export const setLocalAccountEnabled = (
  settings: ServerSettingsService["Service"],
  id: string,
  enabled: boolean,
): Effect.Effect<void, LocalAccountError> =>
  settings
    .updateSettings((current) => {
      const account = current.localAccountPool.accounts[id as LocalAccountId];
      if (account === undefined) return {};
      const localAccountPool = {
        ...current.localAccountPool,
        accounts: {
          ...current.localAccountPool.accounts,
          [id]: { ...account, enabled },
        },
      };
      return {
        localAccountPool,
        ...refreshLocalPoolInstanceAdapters({ ...current, localAccountPool }),
      };
    })
    .pipe(
      Effect.mapError(() => new LocalAccountError({ detail: "更新本地账号状态失败。" })),
      Effect.asVoid,
    );

export const setLocalAccountsEnabled = (
  settings: ServerSettingsService["Service"],
  ids: readonly string[],
  enabled: boolean,
): Effect.Effect<void, LocalAccountError> =>
  settings
    .updateSettings((current) => {
      const accounts = { ...current.localAccountPool.accounts };
      let changed = false;
      for (const id of ids) {
        const account = accounts[id as LocalAccountId];
        if (account !== undefined && account.enabled !== enabled) {
          accounts[id as LocalAccountId] = { ...account, enabled };
          changed = true;
        }
      }
      if (!changed) return {};
      const localAccountPool = { ...current.localAccountPool, accounts };
      return {
        localAccountPool,
        ...refreshLocalPoolInstanceAdapters({ ...current, localAccountPool }),
      };
    })
    .pipe(
      Effect.mapError(() => new LocalAccountError({ detail: "批量更新本地账号状态失败。" })),
      Effect.asVoid,
    );

export const setLocalAccountPoolStrategy = (
  settings: ServerSettingsService["Service"],
  strategy: LocalAccountPoolStrategy,
): Effect.Effect<void, LocalAccountError> =>
  settings
    .updateSettings((current) => ({
      localAccountPool: { ...current.localAccountPool, strategy },
    }))
    .pipe(
      Effect.mapError(() => new LocalAccountError({ detail: "更新本地账号池策略失败。" })),
      Effect.asVoid,
    );

export const setLocalAccountWeight = (
  settings: ServerSettingsService["Service"],
  id: LocalAccountId,
  weight: number,
): Effect.Effect<void, LocalAccountError> =>
  settings
    .updateSettings((current) => {
      const account = current.localAccountPool.accounts[id];
      if (account === undefined) return current;
      return {
        localAccountPool: {
          ...current.localAccountPool,
          accounts: {
            ...current.localAccountPool.accounts,
            [id]: {
              ...account,
              weight: Math.min(MAX_LOCAL_ACCOUNT_WEIGHT, Math.max(1, Math.trunc(weight))),
            },
          },
        },
      };
    })
    .pipe(
      Effect.mapError(() => new LocalAccountError({ detail: "更新本地账号权重失败。" })),
      Effect.asVoid,
    );

/** 从本地账号池生成 CPA 兼容的模型线路；凭据只在服务端网关内解析。 */
export const localGatewayAdapters = (
  settings: ServerSettings,
  origin: string,
  token: string,
  instanceId: string,
): readonly ByokModelAdapter[] => {
  const accounts = Object.values(settings.localAccountPool.accounts).filter(
    (account) => account.enabled && account.provider !== "cursor",
  );
  return accounts.flatMap((account) =>
    account.models.flatMap((modelId) => {
      const protocol = account.provider === "claude" ? "anthropic" : "openai";
      const id = `local:${instanceId}:${account.provider}:${modelId}`;
      return decodeByokAdapter({
        id,
        displayName: modelId,
        groupName: `CLIProxyAPI · ${account.provider}`,
        protocol,
        baseURL: protocol === "openai" ? `${origin}/v1` : origin,
        apiKey: token,
        modelId,
        supplierID: "codework-local-account",
      });
    }),
  );
};

const isPoolAdapterRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (value as Record<string, unknown>).supplierID === "codework-local-account";

/**
 * 账号池变化后同步刷新本地账号池 BYOK 实例的适配器目录。团队模型绑定
 * （composition 目录）与该实例的模型快照都读 config.adapters，不刷新就会
 * 出现"新账号在会话模型可选、在团队绑定选不到"的断链。origin/token 从既有
 * 池适配器恢复，baseURL 与配置摘要保持稳定，已保存的团队绑定不受影响。
 * 返回 undefined 表示目录已是最新的，无需写入。
 */
export const refreshLocalPoolInstanceAdapters = (
  settings: ServerSettings,
): Pick<ServerSettings, "providerInstances"> | undefined => {
  let changed = false;
  const providerInstances: Record<string, ProviderInstanceConfig> = {};
  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    providerInstances[instanceId] = instance;
    if (instance.driver !== "byok") continue;
    const config = instance.config;
    if (config === null || typeof config !== "object" || Array.isArray(config)) continue;
    const configRecord = config as Record<string, unknown>;
    const adapters = configRecord.adapters;
    if (!Array.isArray(adapters)) continue;
    const anchor = adapters.find(isPoolAdapterRecord);
    if (anchor === undefined) continue;
    const baseURL = typeof anchor.baseURL === "string" ? anchor.baseURL : "";
    const apiKey = typeof anchor.apiKey === "string" ? anchor.apiKey : "";
    if (baseURL.length === 0 || apiKey.length === 0) continue;
    const origin = anchor.protocol === "openai" ? baseURL.replace(/\/v1$/u, "") : baseURL;
    const nextAdapters = localGatewayAdapters(settings, origin, apiKey, instanceId);
    const refreshed: unknown[] = [];
    let inserted = false;
    for (const adapter of adapters) {
      if (isPoolAdapterRecord(adapter)) {
        if (!inserted) {
          inserted = true;
          refreshed.push(...nextAdapters);
        }
        continue;
      }
      refreshed.push(adapter);
    }
    if (!inserted) refreshed.push(...nextAdapters);
    if (JSON.stringify(adapters) === JSON.stringify(refreshed)) continue;
    providerInstances[instanceId] = {
      ...instance,
      config: { ...configRecord, adapters: refreshed },
    };
    changed = true;
  }
  return changed ? { providerInstances } : undefined;
};
