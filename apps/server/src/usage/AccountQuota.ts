// @effect-diagnostics globalDate:off - 新鲜度判断使用墙上时间。

/**
 * 第一方订阅额度（Codex/Claude 的 5h/7d 滚动窗口）。
 *
 * 数据源是 provider CLI 自己推送的 `account.rate-limits.updated` 运行时事件，
 * 由 ingestion 在转发活动时顺路投喂给这里的进程内单例；不读凭据、不调
 * 计费 API——CLI 没跑过就诚实显示无数据。持久化与 `LocalPoolUsage` 同款：
 * 纯同步模块级 store，`layer` 在启动时水合并定时把脏快照写进
 * `<stateDir>/account-quota.json`。
 *
 * 归一化按容错读取：Codex 是嵌套 `primary`/`secondary` 窗口（usedPercent
 * 0-100、resetsAt unix 秒），Claude 是单窗口事件（`rate_limit_type` +
 * `utilization`），两种都归一到 `AccountQuotaWindow`。
 *
 * @module usage/AccountQuota
 */
import {
  AccountQuotaProviderState,
  type AccountQuotaResult,
  type AccountQuotaWindow,
  type AccountQuotaWindowStatus,
  type ProviderDriverKind,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";

interface QuotaWindowEntry extends AccountQuotaWindow {
  updatedAtUnixMs: number;
}

interface QuotaProviderEntry {
  readonly provider: string;
  planName?: string;
  readonly windows: Map<string, QuotaWindowEntry>;
  updatedAtUnixMs: number;
}

export interface AccountQuotaPersistence {
  readonly version: 1;
  readonly providers: ReadonlyArray<AccountQuotaProviderState>;
}

const AccountQuotaPersistenceSchema = Schema.Struct({
  version: Schema.Literal(1),
  providers: Schema.Array(AccountQuotaProviderState),
});
const isAccountQuotaPersistence = Schema.is(AccountQuotaPersistenceSchema);

export interface AccountQuotaStore {
  /** CLI 报告了一次额度；按窗口 id 合并（Claude 一次只报一个窗口）。 */
  readonly update: (provider: string, rateLimits: unknown, nowUnixMs: number) => void;
  readonly snapshot: (nowUnixMs: number) => AccountQuotaResult;
  readonly serialize: () => AccountQuotaPersistence;
  readonly hydrate: (state: AccountQuotaPersistence) => void;
  /** 有未落盘的变更时返回快照并清脏标记；否则返回 undefined。 */
  readonly takeDirtySnapshot: () => AccountQuotaPersistence | undefined;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const readNumber = (record: Record<string, unknown>, keys: readonly string[]): number | null => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
};

const readString = (record: Record<string, unknown>, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
};

/** 重置时间容错读取：ISO 字符串或 unix 秒/毫秒，统一成 ISO。 */
const readResetAt = (
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      const date = new Date(value > 1_000_000_000_000 ? value : value * 1_000);
      if (Number.isFinite(date.getTime())) return date.toISOString();
    }
  }
  return undefined;
};

/** 百分比与分数混用时按 ≤1 视为分数处理（与客户端既有容错一致）。 */
const toFraction = (value: number): number =>
  Math.max(0, Math.min(1, value <= 1 ? value : value / 100));

const statusFromFraction = (fraction: number | null): AccountQuotaWindowStatus =>
  fraction === null ? "unknown" : fraction >= 1 ? "exhausted" : fraction >= 0.8 ? "warning" : "ok";

const WINDOW_LABELS: Readonly<Record<string, string>> = {
  primary: "5 hours",
  five_hour: "5 hours",
  secondary: "7 days",
  seven_day: "7 days",
};

const windowLabel = (id: string, windowMinutes: number | null): string => {
  if (windowMinutes === 300) return WINDOW_LABELS.primary ?? id;
  if (windowMinutes === 10_080) return WINDOW_LABELS.secondary ?? id;
  return WINDOW_LABELS[id] ?? id;
};

/**
 * 从一份 CLI 原样转发的 rateLimits 载荷提取窗口。识别不出任何窗口时返回
 * 空数组，调用方据此跳过这次更新——绝不猜测未上报的数据。
 */
export const normalizeAccountRateLimits = (
  rateLimits: unknown,
): { windows: AccountQuotaWindow[]; planName?: string } => {
  const limits = asRecord(rateLimits);
  if (!limits) return { windows: [] };

  const planName = readString(limits, ["planType", "plan_type", "planName", "plan"]);
  const windows: AccountQuotaWindow[] = [];

  // Codex app-server: 嵌套 primary/secondary 窗口。
  for (const key of ["primary", "secondary"]) {
    const window = asRecord(limits[key]);
    if (!window) continue;
    const usedPercent = readNumber(window, ["usedPercent", "used_percent"]);
    if (usedPercent === null) continue;
    const windowMinutes = readNumber(window, ["windowDurationMins", "window_duration_mins"]);
    windows.push({
      id: key,
      label: windowLabel(key, windowMinutes),
      usedFraction: toFraction(usedPercent),
      resetsAt: readResetAt(window, ["resetsAt", "resets_at"]),
      status: statusFromFraction(toFraction(usedPercent)),
    });
  }
  if (windows.length > 0) return { windows, ...(planName ? { planName } : {}) };

  // Claude stream-json: 单窗口事件（rate_limit_type + utilization）。
  const directUsed = readNumber(limits, [
    "usedPercent",
    "used_percent",
    "utilization",
    "rate_limit_percentage",
  ]);
  const directType = readString(limits, ["rate_limit_type", "type", "window"]);
  if (directUsed !== null) {
    const id = directType ?? "current";
    windows.push({
      id,
      label: windowLabel(id, null),
      usedFraction: toFraction(directUsed),
      resetsAt: readResetAt(limits, ["resetsAt", "reset_at", "resets_at"]),
      status: statusFromFraction(toFraction(directUsed)),
    });
    return { windows, ...(planName ? { planName } : {}) };
  }

  // 兜底：其他 provider 的嵌套窗口对象，按 key 逐个识别。
  for (const [key, value] of Object.entries(limits)) {
    const window = asRecord(value);
    if (!window) continue;
    const usedPercent = readNumber(window, ["usedPercent", "used_percent", "utilization"]);
    if (usedPercent === null) continue;
    windows.push({
      id: key,
      label: windowLabel(key, readNumber(window, ["windowDurationMins", "window_duration_mins"])),
      usedFraction: toFraction(usedPercent),
      resetsAt: readResetAt(window, ["resetsAt", "resets_at"]),
      status: statusFromFraction(toFraction(usedPercent)),
    });
  }
  return { windows, ...(planName ? { planName } : {}) };
};

/** 读取时丢弃超过 7 天没刷新的窗口（7d 窗口本身的生命周期上限）。 */
const WINDOW_TTL_UNIX_MS = 7 * 24 * 60 * 60 * 1000;

export const createAccountQuotaStore = (): AccountQuotaStore => {
  const providers = new Map<string, QuotaProviderEntry>();
  let dirty = false;

  const toPersistence = (): AccountQuotaPersistence => ({
    version: 1,
    providers: [...providers.values()].map((entry) => ({
      provider: entry.provider as ProviderDriverKind,
      ...(entry.planName ? { planName: entry.planName } : {}),
      windows: [...entry.windows.values()].map(
        ({ updatedAtUnixMs: _updatedAt, ...window }) => window,
      ),
      updatedAtUnixMs: entry.updatedAtUnixMs,
    })),
  });

  return {
    update: (provider, rateLimits, nowUnixMs) => {
      const { windows, planName } = normalizeAccountRateLimits(rateLimits);
      if (windows.length === 0 && !planName) return;
      let entry = providers.get(provider);
      if (!entry) {
        entry = { provider, windows: new Map(), updatedAtUnixMs: nowUnixMs };
        providers.set(provider, entry);
      }
      for (const window of windows) {
        entry.windows.set(window.id, { ...window, updatedAtUnixMs: nowUnixMs });
      }
      if (planName) entry.planName = planName;
      entry.updatedAtUnixMs = nowUnixMs;
      dirty = true;
    },
    snapshot: (nowUnixMs) => {
      const states: AccountQuotaProviderState[] = [];
      for (const entry of providers.values()) {
        const windows: AccountQuotaWindow[] = [];
        for (const { updatedAtUnixMs, ...window } of entry.windows.values()) {
          if (nowUnixMs - updatedAtUnixMs > WINDOW_TTL_UNIX_MS) continue;
          windows.push(window);
        }
        if (windows.length === 0) continue;
        windows.sort((left, right) => left.id.localeCompare(right.id));
        states.push({
          provider: entry.provider as ProviderDriverKind,
          ...(entry.planName ? { planName: entry.planName } : {}),
          windows,
          updatedAtUnixMs: entry.updatedAtUnixMs,
        });
      }
      states.sort((left, right) => left.provider.localeCompare(right.provider));
      return { generatedAtUnixMs: nowUnixMs, providers: states };
    },
    serialize: toPersistence,
    // 水合按窗口取最新：重启前的快照不能覆盖进程已收到的更新。
    hydrate: (state) => {
      for (const incoming of state.providers ?? []) {
        let entry = providers.get(incoming.provider);
        if (!entry) {
          entry = { provider: incoming.provider, windows: new Map(), updatedAtUnixMs: 0 };
          providers.set(incoming.provider, entry);
        }
        if ((incoming.updatedAtUnixMs ?? 0) > entry.updatedAtUnixMs) {
          entry.updatedAtUnixMs = incoming.updatedAtUnixMs;
          if (incoming.planName !== undefined) {
            entry.planName = incoming.planName;
          }
        }
        for (const window of incoming.windows ?? []) {
          // 窗口级时间戳在序列化时剥离了，持久化的内容比不了新旧——
          // 只补进程里还没有的窗口，绝不覆盖已收到的更新。
          if (!entry.windows.has(window.id)) {
            entry.windows.set(window.id, { ...window, updatedAtUnixMs: entry.updatedAtUnixMs });
          }
        }
      }
    },
    takeDirtySnapshot: () => {
      if (!dirty) return undefined;
      dirty = false;
      return toPersistence();
    },
  };
};

/** ingestion 投喂、RPC 读取共享的进程内单例；落盘由 `layer` 驱动。 */
export const accountQuotaStore = createAccountQuotaStore();

export const parseAccountQuotaPersistence = (text: string): AccountQuotaPersistence | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return isAccountQuotaPersistence(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

/**
 * 启动水合 + 10 秒节流落盘脏快照 + 关闭补写；组合在 server.ts 里，
 * 与 CliProxy 层给本地池用量做的持久化完全同款。
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig;
    yield* fs.readFile(config.accountQuotaPath).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
      Effect.flatMap((bytes) => {
        const state =
          bytes === undefined
            ? undefined
            : parseAccountQuotaPersistence(Buffer.from(bytes).toString("utf8"));
        if (state !== undefined) accountQuotaStore.hydrate(state);
        return Effect.void;
      }),
    );
    const persist = (snapshot: AccountQuotaPersistence) =>
      fs
        .writeFile(config.accountQuotaPath, Buffer.from(JSON.stringify(snapshot), "utf8"))
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to persist account quota", { cause }),
          ),
        );
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.flatMap(Effect.sleep("10 seconds"), () => {
          const snapshot = accountQuotaStore.takeDirtySnapshot();
          return snapshot === undefined ? Effect.void : persist(snapshot);
        }),
      ),
    );
    yield* Effect.addFinalizer(() => {
      const snapshot = accountQuotaStore.takeDirtySnapshot();
      return snapshot === undefined ? Effect.void : persist(snapshot);
    });
  }),
);
