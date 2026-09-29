// @effect-diagnostics nodeBuiltinImport:off - 纯数值/形状规整，无 IO。
// @effect-diagnostics globalDate:off - 时间戳转 ISO 只用于 UI 展示。
/**
 * 号池账号的「用量与订阅」：按平台各自的官方用量/订阅接口拉取并归一化。
 *  - Codex OAuth: chatgpt.com/backend-api/wham/usage（Bearer + chatgpt-account-id）
 *  - Claude OAuth: api.anthropic.com/api/oauth/usage（Bearer + oauth beta 头）
 *  - ZCode: {api.z.ai|open.bigmodel.cn}/api/biz/subscription/list + /api/monitor/usage/quota/limit
 *    （Bearer Coding Plan API Key；上游 bigmodelUsageQuotaProvider 同款端点）+
 *    zcode.z.ai/api/v1/zcode-plan/billing/balance（体验套餐余额，Bearer zcodejwttoken）+
 *    billing/preview（可领取活动）+ client/configs（150% 配额活动文案）
 *  - Grok/xAI: api.x.ai/v1/api-key（只返回 key 元数据，无额度窗口）
 * 所有失败都归一化成 `error` 文案，不让单个账号拖垮整个列表。
 * @module provider/localAccountUsage
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import type {
  CliProxyAccountCampaign,
  CliProxyAccountOffer,
  LocalAccount,
  LocalAccountAuthKind,
} from "@codework/contracts";

import {
  fetchZCodeClaimOffers,
  fetchZCodeClientConfigs,
  fetchZCodeStartPlanBalance,
  type ZCodeStartPlanView,
} from "./zcode/zcodeStartPlan.ts";

export interface UsageWindowView {
  readonly label: string;
  /** 已用百分比 0–100；拿不到时省略。 */
  readonly percent?: number;
  readonly remaining?: string;
  readonly resetsAt?: string;
}

export interface AccountSubscriptionView {
  readonly plan?: string;
  readonly status?: string;
  readonly expiresAt?: string;
  readonly windows: ReadonlyArray<UsageWindowView>;
  readonly metrics?: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly detail?: string;
  readonly error?: string;
  readonly offers?: ReadonlyArray<CliProxyAccountOffer>;
  readonly campaign?: CliProxyAccountCampaign;
}

const REQUEST_TIMEOUT_MS = 15_000;

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const readString = (record: Record<string, unknown> | undefined, key: string): string | undefined =>
  record !== undefined && typeof record[key] === "string" && record[key].trim().length > 0
    ? (record[key] as string).trim()
    : undefined;

const readNumber = (record: Record<string, unknown> | undefined, key: string): number | undefined =>
  record !== undefined && typeof record[key] === "number" && Number.isFinite(record[key])
    ? (record[key] as number)
    : undefined;

const epochMsToIso = (value: number | undefined): string | undefined => {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  // 上游字段混用秒与毫秒：大于 1e12 视为毫秒。
  return new Date(value > 1e12 ? value : value * 1000).toISOString();
};

const getJson = (input: {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly failure: string;
}): Effect.Effect<Record<string, unknown>, string, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(HttpClientRequest.get(input.url).pipe(HttpClientRequest.setHeaders(input.headers)))
      .pipe(
        Effect.timeout(REQUEST_TIMEOUT_MS),
        Effect.mapError(() => input.failure),
      );
    if (response.status === 401 || response.status === 403)
      return yield* Effect.fail(`${input.failure}（凭据已失效）`);
    if (response.status < 200 || response.status >= 300)
      return yield* Effect.fail(`${input.failure}（HTTP ${response.status}）`);
    const text = yield* response.text.pipe(Effect.mapError(() => `${input.failure}（响应不可读）`));
    const decoded = yield* decodeJson(text).pipe(
      Effect.mapError(() => `${input.failure}（响应不是 JSON）`),
    );
    const record = asRecord(decoded);
    return record === undefined
      ? yield* Effect.fail(`${input.failure}（响应不是 JSON 对象）`)
      : record;
  });

const windowOf = (
  label: string,
  record: Record<string, unknown> | undefined,
): UsageWindowView | undefined => {
  if (record === undefined) return undefined;
  const percent = readNumber(record, "used_percent") ?? readNumber(record, "utilization");
  const resetsAt = readString(record, "resets_at") ?? epochMsToIso(readNumber(record, "reset_at"));
  if (percent === undefined && resetsAt === undefined) return undefined;
  return {
    label,
    ...(percent === undefined ? {} : { percent }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
};

/** 窗口时长秒数 → 可读标签（18000=5 小时、604800=1 周……未知时长也尽量换算）。 */
const windowSecondsLabel = (seconds: number | undefined, fallback: string): string => {
  if (seconds === undefined) return fallback;
  if (seconds % 604800 === 0) return `${Math.round(seconds / 604800)} 周`;
  if (seconds % 86400 === 0) return `${Math.round(seconds / 86400)} 天`;
  if (seconds % 3600 === 0) return `${Math.round(seconds / 3600)} 小时`;
  return `${Math.round(seconds / 60)} 分钟`;
};

/** 遍历 rate_limit 容器里的全部 *_window，不假定固定键名——x20/Team 档的窗口形状与 Pro 不同。 */
const collectRateLimitWindows = (
  container: Record<string, unknown> | undefined,
  prefix: string,
): UsageWindowView[] => {
  if (container === undefined) return [];
  const windows: UsageWindowView[] = [];
  for (const [key, value] of Object.entries(container)) {
    const record = asRecord(value);
    if (record === undefined || !key.endsWith("_window")) continue;
    const base = key === "primary_window" ? "主" : key === "secondary_window" ? "次" : key;
    const label = windowSecondsLabel(readNumber(record, "limit_window_seconds"), base);
    const view = windowOf(`${prefix}${label}`.trim(), record);
    if (view !== undefined) windows.push(view);
  }
  return windows;
};

const planLabel = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  const normalized = raw.replace(/_/gu, " ").trim();
  return normalized === "" ? undefined : normalized[0]!.toUpperCase() + normalized.slice(1);
};

/** 解 JWT payload（中间段 base64url）；非法输入返回 undefined。 */
const decodeJwtPayload = (token: string | undefined): Record<string, unknown> | undefined => {
  if (token === undefined) return undefined;
  const segments = token.split(".");
  if (segments.length < 2 || segments[1] === "") return undefined;
  try {
    const normalized = segments[1]!.replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return asRecord(JSON.parse(Buffer.from(padded, "base64").toString("utf8")));
  } catch {
    return undefined;
  }
};

/** Codex plan_type 兜底：wham/usage 不带 plan 时从 id_token 的 chatgpt_plan_type 取。 */
export const codexPlanFromCredential = (
  credential: Record<string, unknown>,
): string | undefined => {
  const idToken =
    readString(credential, "id_token") ?? readString(credential, "idToken") ?? undefined;
  return readString(decodeJwtPayload(idToken), "chatgpt_plan_type");
};

/** Codex OAuth：`wham/usage` 返回 rate_limit 窗口组 + 附加限额（Spark/专属模型）+ plan_type + credits。 */
const fetchCodexUsage = (
  credential: Record<string, unknown>,
  token: string,
): Effect.Effect<AccountSubscriptionView, string, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const accountId = readString(credential, "account_id");
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(accountId === undefined ? {} : { "chatgpt-account-id": accountId }),
    };
    const data = yield* getJson({
      url: "https://chatgpt.com/backend-api/wham/usage",
      headers,
      failure: "Codex 用量查询失败",
    });
    // 订阅到期是可选数据面：失败不拖垮用量窗口。
    const subscriptionExpiresAt = yield* accountId === undefined
      ? Effect.succeed(undefined as string | undefined)
      : getJson({
          url: `https://chatgpt.com/backend-api/subscriptions?account_id=${encodeURIComponent(accountId)}`,
          headers,
          failure: "Codex 订阅查询失败",
        }).pipe(
          Effect.map((payload) => {
            const value = readString(payload, "active_until") ?? readString(payload, "activeUntil");
            if (value !== undefined) return value;
            const numeric = readNumber(payload, "active_until");
            return epochMsToIso(numeric);
          }),
          Effect.orElseSucceed(() => undefined as string | undefined),
        );
    const windows: UsageWindowView[] = [
      ...collectRateLimitWindows(asRecord(data.rate_limit), ""),
      ...collectRateLimitWindows(asRecord(data.code_review_rate_limit), "评审·"),
    ];
    // additional_rate_limits：Spark 等专属模型的独立限额组。
    const additional = Array.isArray(data.additional_rate_limits)
      ? data.additional_rate_limits
      : [];
    for (const entry of additional) {
      const record = asRecord(entry);
      const name = readString(record, "limit_name") ?? "";
      const prefix = name === "" ? "额外限额·" : `${name}·`;
      windows.push(...collectRateLimitWindows(asRecord(record?.rate_limit), prefix));
    }
    const credits = asRecord(data.credits);
    const balance = readNumber(credits, "balance");
    const metrics: Array<{ label: string; value: string }> = [];
    if (balance !== undefined) metrics.push({ label: "积分余额", value: `$${balance}` });
    const rateLimit = asRecord(data.rate_limit);
    const status = rateLimit?.limit_reached === true ? "已达上限" : undefined;
    const plan = planLabel(readString(data, "plan_type") ?? codexPlanFromCredential(credential));
    return {
      ...(plan === undefined ? {} : { plan }),
      ...(status === undefined ? {} : { status }),
      ...(subscriptionExpiresAt === undefined ? {} : { expiresAt: subscriptionExpiresAt }),
      windows,
      ...(metrics.length === 0 ? {} : { metrics }),
    } satisfies AccountSubscriptionView;
  });

/** Claude profile → 套餐档位（CPA resolveClaudePlanType 同款判定）。 */
export const claudePlanFromProfile = (payload: unknown): string | undefined => {
  const profile = asRecord(payload);
  const organization = asRecord(profile?.organization);
  const account = asRecord(profile?.account);
  const organizationType = readString(organization, "organization_type")?.toLowerCase();
  const subscriptionStatus = readString(organization, "subscription_status")?.toLowerCase();
  if (organizationType === "claude_team" && subscriptionStatus === "active") return "Team";
  // 账号旗标在 Team 令牌下也带个人订阅信息，Max 优先于 Pro；旗标缺失≠false。
  const hasClaudeMax = account?.has_claude_max;
  if (hasClaudeMax === true) return "Max";
  const hasClaudePro = account?.has_claude_pro;
  if (hasClaudePro === true) return "Pro";
  if (hasClaudeMax === false && hasClaudePro === false) return "Free";
  return undefined;
};

/** usage.limits[] 里的 weekly_scoped Fable 周窗（iguana_necktie 键缺席时的形态）。 */
export const claudeFableWindow = (data: Record<string, unknown>): UsageWindowView | undefined => {
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const candidates = limits
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .filter((limit) => {
      if (readString(limit, "kind")?.toLowerCase() !== "weekly_scoped") return false;
      const model = readString(asRecord(asRecord(limit.scope)?.model), "display_name") ?? "";
      const name = model.toLowerCase();
      return name === "fable" || name === "fable 5";
    })
    .filter((limit) => readNumber(limit, "percent") !== undefined);
  const picked = candidates.find((limit) => limit.is_active === true) ?? candidates[0];
  if (picked === undefined) return undefined;
  return windowOf("Fable 7 天", {
    ...(readNumber(picked, "percent") === undefined
      ? {}
      : { utilization: readNumber(picked, "percent")! }),
    ...(readString(picked, "resets_at") === undefined
      ? {}
      : { resets_at: readString(picked, "resets_at")! }),
  });
};

/** Claude OAuth：`oauth/usage` 返回 five_hour / seven_day / opus 限额窗口；`oauth/profile` 给套餐档位。 */
const fetchClaudeUsage = (
  _credential: Record<string, unknown>,
  token: string,
): Effect.Effect<AccountSubscriptionView, string, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
    };
    const data = yield* getJson({
      url: "https://api.anthropic.com/api/oauth/usage",
      headers,
      failure: "Claude 用量查询失败",
    });
    const claudeLabels: Record<string, string> = {
      five_hour: "5 小时",
      seven_day: "7 天",
      seven_day_opus: "Opus 7 天",
      seven_day_sonnet: "Sonnet 7 天",
      seven_day_oauth_apps: "7 天·第三方应用",
      seven_day_cowork: "Cowork 7 天",
      iguana_necktie: "Fable 7 天",
    };
    // 不固定键名：所有带 utilization/resets_at 的顶层字段都当作一个限额窗口。
    const windows = Object.entries(data)
      .map(([key, value]) => {
        const record = asRecord(value);
        if (record === undefined) return undefined;
        return windowOf(claudeLabels[key] ?? key.replace(/_/gu, " "), record);
      })
      .filter((entry): entry is UsageWindowView => entry !== undefined);
    if (!windows.some((entry) => entry.label === "Fable 7 天")) {
      const fable = claudeFableWindow(data);
      if (fable !== undefined) windows.push(fable);
    }
    // 套餐档位是可选数据面：profile 拿不到不影响窗口。
    const plan = yield* getJson({
      url: "https://api.anthropic.com/api/oauth/profile",
      headers,
      failure: "Claude 套餐查询失败",
    }).pipe(
      Effect.map((payload) => claudePlanFromProfile(payload)),
      Effect.orElseSucceed(() => undefined as string | undefined),
    );
    const extra = asRecord(data.extra_usage);
    return {
      ...(plan === undefined ? {} : { plan }),
      windows,
      ...(extra?.is_enabled === true ? { detail: "extra_usage 已开启" } : {}),
    } satisfies AccountSubscriptionView;
  });

const ZCODE_USAGE_HOST: Record<string, string> = {
  zai: "https://api.z.ai",
  bigmodel: "https://open.bigmodel.cn",
};

const ZCODE_LIMIT_LABELS: Record<string, string> = {
  TIME_LIMIT: "限时额度",
  TOKEN_LIMIT: "Token",
  MCP_LIMIT: "MCP",
};

const ZCODE_API_ORIGIN = "https://zcode.z.ai";

/** z.ai/bigmodel biz+monitor 接口的鉴权头：上游 normalizeApiKeyForHeader 输出裸 key，不加 Bearer。 */
const zcodeMonitorHeaders = (apiKey: string): Record<string, string> => ({
  Authorization: apiKey.replace(/^Bearer\s+/iu, "").trim(),
});

/** ZCode 活动统计时间窗：与上游 resolveCreditUsageActivityTimeRange 一致——近 365 天。 */
const zcodeActivityRange = (): { startTime: string; endTime: string } => {
  const fmt = (date: Date): string =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
      date.getDate(),
    ).padStart(2, "0")}`;
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 365);
  return { startTime: `${fmt(start)} 00:00:00`, endTime: `${fmt(end)} 23:59:59` };
};

const formatTokenCount = (value: number): string =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1_000
      ? `${(value / 1_000).toFixed(1)}k`
      : String(value);

const formatDuration = (ms: number): string => {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  return hours > 0 ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
};

/** Coding Plan Key 不可用时的体验套餐查询结果。 */
type ZCodeStartPlanOutcome = { readonly view: ZCodeStartPlanView } | { readonly error: string };

/** ZCode Coding Plan：订阅 + 用量限额 + 体验套餐余额 + 可领取活动 + 近一年活动统计 + MCP 额度。 */
const fetchZCodeUsage = (
  credential: Record<string, unknown>,
  token: string,
): Effect.Effect<AccountSubscriptionView, string, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const family = readString(credential, "zcode_family") ?? "zai";
    const host = ZCODE_USAGE_HOST[family] ?? ZCODE_USAGE_HOST.zai!;
    const apiKey = readString(credential, "api_key");
    const jwt = readString(credential, "zcode_jwt");
    // monitor/biz 接口吃 Coding Plan Key（normalizeApiKeyForHeader 输出裸 key）；
    // JWT-only 账号（只有体验套餐）没有 Key，Key 系端点整体跳过。
    const headers = zcodeMonitorHeaders(apiKey ?? token);

    const subscription = yield* apiKey === undefined
      ? Effect.succeed<Record<string, unknown>>({})
      : getJson({
          url: `${host}/api/biz/subscription/list`,
          headers,
          failure: "ZCode 订阅查询失败",
        }).pipe(
          Effect.map((payload) => {
            const list = Array.isArray(payload.data) ? payload.data : [];
            const item = list
              .map((entry) => asRecord(entry))
              .find((entry) =>
                [entry?.productId, entry?.productName].some(
                  (field) => typeof field === "string" && field.toLowerCase().includes("coding"),
                ),
              );
            if (item === undefined) return {};
            const plan = readString(item, "productName");
            const status =
              readString(item, "status") === "VALID" ? "有效" : readString(item, "status");
            const expiresAt =
              readString(item, "subscribeEndTime") ??
              readString(item, "nextRenewTime") ??
              epochMsToIso(readNumber(item, "expires_at"));
            return {
              ...(plan === undefined ? {} : { plan }),
              ...(status === undefined ? {} : { status }),
              ...(expiresAt === undefined ? {} : { expiresAt }),
            };
          }),
          Effect.orElseSucceed(() => ({}) as Record<string, unknown>),
        );

    const quotaView = yield* apiKey === undefined
      ? Effect.succeed<{ windows: UsageWindowView[]; level?: string }>({ windows: [] })
      : getJson({
          url: `${host}/api/monitor/usage/quota/limit`,
          headers,
          failure: "ZCode 额度查询失败",
        }).pipe(
          Effect.map((quota) => {
            const quotaData = asRecord(quota.data);
            const limits = Array.isArray(quotaData?.limits)
              ? quotaData.limits
                  .map((entry) => asRecord(entry))
                  .filter((entry): entry is Record<string, unknown> => entry !== undefined)
              : [];
            const windows = limits
              .map((limit): UsageWindowView | undefined => {
                const type = readString(limit, "type") ?? "";
                const percent = readNumber(limit, "percentage");
                const remaining = readNumber(limit, "remaining");
                const total = readNumber(limit, "number");
                const resetsAt = epochMsToIso(readNumber(limit, "nextResetTime"));
                if (percent === undefined && remaining === undefined) return undefined;
                return {
                  label: ZCODE_LIMIT_LABELS[type] ?? (type || "额度"),
                  ...(percent === undefined ? {} : { percent: percent * (percent <= 1 ? 100 : 1) }),
                  ...(remaining === undefined
                    ? {}
                    : {
                        remaining: total === undefined ? `${remaining}` : `${remaining}/${total}`,
                      }),
                  ...(resetsAt === undefined ? {} : { resetsAt }),
                };
              })
              .filter((entry): entry is UsageWindowView => entry !== undefined);
            const level = readString(quotaData, "level");
            return { windows, ...(level === undefined ? {} : { level }) };
          }),
        );

    // 体验套餐余额/可领取活动与平台活动文案都是可选数据面：失败只丢该区域。
    const range = zcodeActivityRange();
    const startPlan: ZCodeStartPlanOutcome | undefined = yield* jwt === undefined
      ? Effect.succeed(undefined)
      : fetchZCodeStartPlanBalance(jwt).pipe(
          Effect.map((view): ZCodeStartPlanOutcome => ({ view })),
          Effect.catch((detail) => Effect.succeed({ error: detail } as ZCodeStartPlanOutcome)),
        );
    const startPlanView =
      startPlan !== undefined && "view" in startPlan ? startPlan.view : undefined;

    const [offers, campaign, activity, mcpUsage] = yield* Effect.all(
      [
        jwt === undefined
          ? Effect.succeed(undefined as ReadonlyArray<CliProxyAccountOffer> | undefined)
          : fetchZCodeClaimOffers(jwt).pipe(
              Effect.map((entries) =>
                entries.length === 0 ? undefined : (entries as ReadonlyArray<CliProxyAccountOffer>),
              ),
              Effect.orElseSucceed(() => undefined),
            ),
        fetchZCodeClientConfigs().pipe(Effect.map((configs) => configs.campaign)),
        getJson({
          url:
            `${host}/api/monitor/usage/credit-usage/activity` +
            `?type=1&startTime=${encodeURIComponent(range.startTime)}` +
            `&endTime=${encodeURIComponent(range.endTime)}`,
          headers,
          failure: "ZCode 活动统计查询失败",
        }).pipe(
          Effect.map((payload) => {
            const data = asRecord(payload.data);
            const summary = asRecord(data?.summary);
            const metrics: Array<{ label: string; value: string }> = [];
            const totalTokens = readNumber(summary, "totalTokens");
            const peakTokens = readNumber(summary, "peakDailyTokens");
            const peakDate = readString(summary, "peakDailyTokensDate");
            const durationMs = readNumber(summary, "totalUsageDurationMs");
            const streak = readNumber(summary, "currentStreakDays");
            const longestStreak = readNumber(summary, "longestStreakDays");
            if (totalTokens !== undefined)
              metrics.push({
                label: "近一年总用量",
                value: `${formatTokenCount(totalTokens)} tokens`,
              });
            if (peakTokens !== undefined)
              metrics.push({
                label: "峰值日",
                value: `${formatTokenCount(peakTokens)}${peakDate === undefined ? "" : `（${peakDate.slice(5)}）`}`,
              });
            if (durationMs !== undefined)
              metrics.push({ label: "累计使用时长", value: formatDuration(durationMs) });
            if (streak !== undefined)
              metrics.push({
                label: "连续使用",
                value: `${streak} 天${longestStreak === undefined ? "" : ` · 最长 ${longestStreak} 天`}`,
              });
            return metrics;
          }),
          Effect.orElseSucceed((): Array<{ label: string; value: string }> => []),
        ),
        jwt === undefined
          ? Effect.succeed(undefined as UsageWindowView | undefined)
          : getJson({
              url: `${ZCODE_API_ORIGIN}/api/v1/mcp/usage`,
              headers: {
                Authorization: `Bearer ${jwt}`,
                "X-Bigmodel-Authorization": `Bearer ${token}`,
                "Bigmodel-Target-Type": "PERSONAL",
              },
              failure: "ZCode MCP 额度查询失败",
            }).pipe(
              Effect.map((payload): UsageWindowView | undefined => {
                const data = asRecord(payload.data);
                const total = asRecord(data?.total_usage);
                if (total === undefined) return undefined;
                const used = readNumber(total, "used");
                const limit = readNumber(total, "limit");
                const remaining = readNumber(total, "remaining");
                const nextRefresh = epochMsToIso(readNumber(data, "next_refresh_at"));
                if (used === undefined && remaining === undefined) return undefined;
                return {
                  label: "MCP 调用",
                  ...(used === undefined || limit === undefined || limit <= 0
                    ? {}
                    : { percent: (used / limit) * 100 }),
                  ...(remaining === undefined
                    ? {}
                    : {
                        remaining: limit === undefined ? `${remaining}` : `${remaining}/${limit}`,
                      }),
                  ...(nextRefresh === undefined ? {} : { resetsAt: nextRefresh }),
                };
              }),
              Effect.orElseSucceed(() => undefined as UsageWindowView | undefined),
            ),
      ],
      { concurrency: "unbounded" },
    );

    const level = quotaView.level;
    const mcpWindows = mcpUsage === undefined ? [] : [mcpUsage];
    const startPlanWindows = startPlanView?.windows ?? [];
    const windows = [...quotaView.windows, ...startPlanWindows, ...mcpWindows];
    // 订阅套餐名优先（Coding Plan），其次体验套餐名。
    const startPlanName =
      readString(subscription, "plan") === undefined ? startPlanView?.plan?.name : undefined;
    const details = [
      level === undefined ? undefined : `额度水位 ${level}`,
      startPlanView?.expired === true ? "体验套餐已过期" : undefined,
    ].filter((entry): entry is string => entry !== undefined);
    // 只有体验套餐可查却失败（登录失效）时给出明确错误；Key 账号的错误由
    // quota/limit 主请求给出，这里不覆盖。
    const startPlanError =
      startPlan !== undefined && "error" in startPlan && apiKey === undefined && jwt !== undefined
        ? startPlan.error
        : undefined;
    return {
      ...subscription,
      ...(startPlanName === undefined ? {} : { plan: startPlanName }),
      windows,
      ...(activity.length === 0 ? {} : { metrics: activity }),
      ...(details.length === 0 ? {} : { detail: details.join(" · ") }),
      ...(startPlanError !== undefined && windows.length === 0 && offers === undefined
        ? { error: startPlanError }
        : {}),
      ...(offers === undefined ? {} : { offers }),
      ...(campaign === undefined ? {} : { campaign }),
    } satisfies AccountSubscriptionView;
  });

/** xAI OAuth 账号的 CLI 计费接口（cli-chat-proxy.grok.com/v1/billing；CPA Management Center 同款）。 */
const XAI_CLI_BILLING_BASE = "https://cli-chat-proxy.grok.com/v1/billing";

export const xaiBillingWindow = (
  label: string,
  payload: Record<string, unknown>,
): UsageWindowView | undefined => {
  const config = asRecord(payload.config);
  if (config === undefined) return undefined;
  const weeklyPercent =
    readNumber(config, "creditUsagePercent") ?? readNumber(config, "credit_usage_percent");
  const monthlyLimit = readNumber(config, "monthlyLimit") ?? readNumber(config, "monthly_limit");
  const used = readNumber(config, "used") ?? readNumber(config, "onDemandUsed");
  const percent =
    weeklyPercent ??
    (monthlyLimit !== undefined && monthlyLimit > 0 && used !== undefined
      ? (Math.min(used, monthlyLimit) / monthlyLimit) * 100
      : undefined);
  const periodEnd =
    readString(asRecord(config.currentPeriod), "end") ??
    readString(config, "billingPeriodEnd") ??
    readString(config, "billing_period_end");
  const remainingText =
    monthlyLimit !== undefined && used !== undefined
      ? `$${((monthlyLimit - used) / 100).toFixed(2)}/$${(monthlyLimit / 100).toFixed(2)}`
      : undefined;
  if (percent === undefined && remainingText === undefined) return undefined;
  return {
    label,
    ...(percent === undefined ? {} : { percent }),
    ...(remainingText === undefined ? {} : { remaining: remainingText }),
    ...(periodEnd === undefined ? {} : { resetsAt: periodEnd }),
  };
};

/** Grok OAuth（免费池）账号：周/月两条计费窗口；都拿不到时退回空窗口。 */
const fetchXaiOAuthUsage = (
  credential: Record<string, unknown>,
  token: string,
): Effect.Effect<AccountSubscriptionView, string, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    // x-userid 取 JWT sub（CPA resolveXaiUserId 同源）。
    const userId = readString(decodeJwtPayload(token), "sub");
    const headers = {
      Authorization: `Bearer ${token}`,
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-client-version": "0.2.120",
      accept: "*/*",
      "user-agent": "grok-pager/0.2.120 grok-shell/0.2.120 (windows; x64)",
      ...(userId === undefined ? {} : { "x-userid": userId }),
    };
    const [weekly, monthly] = yield* Effect.all(
      [
        getJson({
          url: `${XAI_CLI_BILLING_BASE}?format=credits`,
          headers,
          failure: "Grok 周额度查询失败",
        }).pipe(Effect.orElseSucceed(() => undefined as Record<string, unknown> | undefined)),
        getJson({
          url: XAI_CLI_BILLING_BASE,
          headers,
          failure: "Grok 月额度查询失败",
        }).pipe(Effect.orElseSucceed(() => undefined as Record<string, unknown> | undefined)),
      ],
      { concurrency: "unbounded" },
    );
    const windows = [
      weekly === undefined ? undefined : xaiBillingWindow("周额度", weekly),
      monthly === undefined ? undefined : xaiBillingWindow("月额度", monthly),
    ].filter((entry): entry is UsageWindowView => entry !== undefined);
    const paidTier = Object.entries(decodeJwtPayload(token) ?? {}).find(([key]) =>
      key.toLowerCase().endsWith("tier"),
    )?.[1];
    return {
      ...(typeof paidTier === "number" && paidTier >= 1 ? { plan: "Paid" } : {}),
      windows,
      ...(windows.length === 0
        ? { detail: "Grok 账号未返回额度数据（付费档无公开额度接口）" }
        : {}),
    } satisfies AccountSubscriptionView;
  });

/** xAI API Key 元数据（没有公开额度窗口接口）。 */
const fetchXaiUsage = (
  _credential: Record<string, unknown>,
  token: string,
): Effect.Effect<AccountSubscriptionView, string, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const data = yield* getJson({
      url: "https://api.x.ai/v1/api-key",
      headers: { Authorization: `Bearer ${token}` },
      failure: "Grok 用量查询失败",
    });
    const name = readString(data, "name");
    return {
      ...(name === undefined ? {} : { plan: name }),
      windows: [],
      detail: "xAI 未提供账号级额度接口",
    } satisfies AccountSubscriptionView;
  });

const credentialString = (
  credential: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | undefined => {
  for (const key of keys) {
    const value = readString(credential, key);
    if (value !== undefined) return value;
  }
  return undefined;
};

export const fetchLocalAccountSubscription = (input: {
  readonly account: LocalAccount;
  readonly credential: Record<string, unknown>;
  readonly authKind: LocalAccountAuthKind;
}): Effect.Effect<AccountSubscriptionView, never, HttpClient.HttpClient> => {
  const { account, credential, authKind } = input;
  const tokenKeys =
    account.provider === "zcode"
      ? // zcode：Coding Plan Key 优先，JWT-only 账号（仅体验套餐）落到 zcode_jwt。
        ["api_key", "zcode_jwt", "access_token", "token", "key"]
      : authKind === "api-key"
        ? ["api_key", "access_token", "token", "key"]
        : ["access_token", "api_key", "token", "key"];
  const token = credentialString(credential, tokenKeys);
  if (token === undefined) {
    return Effect.succeed({ windows: [], error: "凭据里没有可用令牌" });
  }
  const fetcher =
    account.provider === "codex"
      ? authKind === "api-key"
        ? null
        : fetchCodexUsage
      : account.provider === "claude"
        ? authKind === "api-key"
          ? null
          : fetchClaudeUsage
        : account.provider === "zcode"
          ? fetchZCodeUsage
          : account.provider === "xai"
            ? // OAuth 账号走 CLI 计费接口；API Key 只有元数据可查。
              authKind === "oauth"
              ? fetchXaiOAuthUsage
              : fetchXaiUsage
            : null;
  if (fetcher === null) {
    return Effect.succeed({
      windows: [],
      detail:
        account.provider === "cursor" ? "Cursor 账号无公开额度接口" : "API Key 账号无公开额度接口",
    });
  }
  return fetcher(credential, token).pipe(
    Effect.catch((detail) => Effect.succeed({ windows: [], error: detail })),
  );
};
