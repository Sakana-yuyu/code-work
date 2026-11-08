// @effect-diagnostics globalDate:off - 快照过期与重置时间判断使用墙上时间。
// @effect-diagnostics globalDateInEffect:off - 调度冷却与 TTL 判断使用墙上时间，与 LocalAccountPool 同款。
/**
 * 本地账号池的配额快照缓存：把 localAccountUsage 的按需查询变成调度可用的
 * 进程内快照。smart 策略在选号热路径同步读这里（TTL 内的旧数据可接受），
 * 刷新由两个入口驱动——CliProxy.layer 的后台 fiber（smart 模式周期刷新）与
 * 网关 429 精确冷却（失败当下拉一次，用真实重置点替换固定 60s 冷却）。
 * 成功缓存 5 分钟、失败 60 秒：失败不进长缓存，一次平台抖动不会把"无数据"
 * 钉死一个刷新周期。快照只在内存里，重启后由后台刷新重新填充。
 * @module provider/LocalAccountQuota
 */
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/http";
import type { LocalAccount, LocalAccountAuthKind, ServerSettings } from "@codework/contracts";
import type { ServerSecretStore } from "../auth/ServerSecretStore.ts";
// 仅类型引用：错误通道复用 LocalAccountError，运行时不与 LocalAccountPool 形成环。
import type { LocalAccountError } from "./LocalAccountPool.ts";
import { localPoolUsageStore } from "./LocalPoolUsage.ts";
import {
  fetchLocalAccountSubscription,
  type AccountSubscriptionView,
} from "./localAccountUsage.ts";

export const LOCAL_POOL_QUOTA_TTL_MS = 5 * 60_000;
export const LOCAL_POOL_QUOTA_ERROR_TTL_MS = 60_000;

interface LocalAccountQuotaSnapshot {
  readonly view: AccountSubscriptionView;
  readonly fetchedAtUnixMs: number;
}

const snapshots = new Map<string, LocalAccountQuotaSnapshot>();
const refreshLocks = new Map<string, Semaphore.Semaphore>();

/** 依赖注入形状：与 LocalAccountPool.ensureLocalAccountCredential 同形；避免环依赖由调用方绑定。 */
export interface LocalAccountQuotaDeps {
  readonly secretStore: ServerSecretStore["Service"];
  readonly httpClient: HttpClient.HttpClient;
  readonly ensureCredential: (
    account: LocalAccount,
    secretStore: ServerSecretStore["Service"],
    httpClient: HttpClient.HttpClient,
  ) => Effect.Effect<Record<string, unknown>, LocalAccountError>;
}

const snapshotFresh = (snapshot: LocalAccountQuotaSnapshot, now: number): boolean => {
  const ttl =
    snapshot.view.error === undefined ? LOCAL_POOL_QUOTA_TTL_MS : LOCAL_POOL_QUOTA_ERROR_TTL_MS;
  return now - snapshot.fetchedAtUnixMs <= ttl;
};

const resetIsoToUnixMs = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
};

export interface LocalAccountQuotaPick {
  /** 主窗口（已用百分比最大的窗口，最先触顶的约束）的已用百分数 0–100。 */
  readonly percent: number;
  /** 主窗口重置时间（unix ms）；上游没给时缺省。 */
  readonly resetsAtMs?: number;
}

/**
 * smart 选号热路径的同步读：TTL 内的快照才可信；没有可用快照（缺数据、
 * 过期、查询失败）返回 undefined，由调用方退化为轮询。
 */
export const localAccountQuotaForPick = (
  accountId: string,
  now: number,
): LocalAccountQuotaPick | undefined => {
  const snapshot = snapshots.get(accountId);
  if (snapshot === undefined || !snapshotFresh(snapshot, now)) return undefined;
  let percent: number | undefined;
  let resetsAtMs: number | undefined;
  for (const window of snapshot.view.windows) {
    if (window.percent === undefined) continue;
    if (percent !== undefined && window.percent <= percent) continue;
    percent = window.percent;
    resetsAtMs = resetIsoToUnixMs(window.resetsAt);
  }
  return percent === undefined
    ? undefined
    : { percent, ...(resetsAtMs !== undefined ? { resetsAtMs } : {}) };
};

/**
 * 429 精确冷却用：快照里已触顶（percent ≥ 100）窗口的最早重置时间。只用
 * 有确凿耗尽证据的窗口——percent 缺失的窗口可能是突发限流，按它的重置点
 * 冷却会把一次瞬时 429 拖成几小时。
 */
export const localAccountQuotaExhaustedResetMs = (
  accountId: string,
  now: number,
): number | undefined => {
  const snapshot = snapshots.get(accountId);
  if (snapshot === undefined || !snapshotFresh(snapshot, now)) return undefined;
  let earliest: number | undefined;
  for (const window of snapshot.view.windows) {
    if (window.percent === undefined || window.percent < 100) continue;
    const ms = resetIsoToUnixMs(window.resetsAt);
    if (ms === undefined) continue;
    earliest = earliest === undefined ? ms : Math.min(earliest, ms);
  }
  return earliest;
};

/**
 * 429 精确冷却（magpie 语义：配额耗尽的账号停到真实重置点）：拉一次配额
 * 快照，若某窗口已触顶且带重置时间，把冷却延长到 min(resetsAt, now+capMs)。
 * 只延长不缩短——markLocalAccountFailure 已按 Retry-After 或默认值落过冷却，
 * 快照不可用或重置点已过时维持原冷却不动。
 */
export const extendLocalAccountCooldownFromQuota = (
  account: LocalAccount,
  capMs: number,
  deps: LocalAccountQuotaDeps,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const now = Date.now();
    const view = yield* refreshLocalAccountQuota(account, deps);
    if (view.error !== undefined) return;
    const resetsAtMs = localAccountQuotaExhaustedResetMs(String(account.id), now);
    if (resetsAtMs === undefined || resetsAtMs <= now) return;
    const existing = localPoolUsageStore.cooldownUntilUnixMs(String(account.id)) ?? 0;
    const target = Math.min(resetsAtMs, now + capMs);
    if (target <= existing) return;
    localPoolUsageStore.setCooldown(String(account.id), target);
  });

/** 与 LocalAccountPool.credentialAuthKind 同形；凭据里同时有 refresh/access token 时按 OAuth。 */ const credentialAuthKind =
  (credential: Record<string, unknown>): LocalAccountAuthKind => {
    const explicit = credential.auth_kind ?? credential.authKind;
    if (explicit === "oauth" || explicit === "api-key") return explicit;
    return ["access_token", "accessToken", "refresh_token", "refreshToken"].some(
      (key) => typeof credential[key] === "string" && credential[key].trim(),
    )
      ? "oauth"
      : "api-key";
  };

/** 写入快照；refreshLocalAccountQuota 与测试共用这一个入口（fetchedAt 可注入以便测过期）。 */
export const rememberLocalAccountQuota = (
  accountId: string,
  view: AccountSubscriptionView,
  fetchedAtUnixMs: number = Date.now(),
): void => {
  snapshots.set(accountId, { view, fetchedAtUnixMs });
};

/**
 * 拉取并记住一个账号的配额快照；锁内先查 TTL，新鲜则直接返回缓存，
 * 因此并发调用与后台周期刷新天然去重。永不失败——平台错误归一成
 * `error` 视图并按失败 TTL 短缓存。
 */
export const refreshLocalAccountQuota = (
  account: LocalAccount,
  deps: LocalAccountQuotaDeps,
): Effect.Effect<AccountSubscriptionView> => {
  const key = String(account.id);
  const lock = refreshLocks.get(key) ?? Semaphore.makeUnsafe(1);
  refreshLocks.set(key, lock);
  const fetchFresh = Effect.gen(function* () {
    const view = yield* deps.ensureCredential(account, deps.secretStore, deps.httpClient).pipe(
      Effect.flatMap((credential) =>
        fetchLocalAccountSubscription({
          account,
          credential,
          authKind: account.authKind ?? credentialAuthKind(credential),
        }),
      ),
      Effect.catch(() =>
        Effect.succeed<AccountSubscriptionView>({ windows: [], error: "账号凭据不可用" }),
      ),
      Effect.provideService(HttpClient.HttpClient, deps.httpClient),
    );
    rememberLocalAccountQuota(key, view);
    return view;
  });
  return Effect.gen(function* () {
    const now = Date.now();
    const cached = snapshots.get(key);
    if (cached !== undefined && snapshotFresh(cached, now)) return cached.view;
    return yield* fetchFresh;
  }).pipe(lock.withPermit);
};

/** 全池刷新（后台 fiber 入口）：并发 2，失败账号留在快照里带 error 字段，不中断其余账号。 */
export const refreshLocalPoolQuotas = (
  settings: ServerSettings,
  deps: LocalAccountQuotaDeps,
): Effect.Effect<number> =>
  Effect.forEach(
    Object.values(settings.localAccountPool.accounts).filter((account) => account.enabled),
    (account) =>
      refreshLocalAccountQuota(account, deps).pipe(
        Effect.map((view) => (view.error === undefined ? 1 : 0)),
        Effect.orElseSucceed(() => 0),
      ),
    { concurrency: 2 },
  ).pipe(Effect.map((marks) => marks.reduce((sum, mark) => sum + mark, 0)));

/** 测试隔离用：清空快照与锁表。 */
export const resetLocalAccountQuotaCacheForTest = (): void => {
  snapshots.clear();
  refreshLocks.clear();
};
