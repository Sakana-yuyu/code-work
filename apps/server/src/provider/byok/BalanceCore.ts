export const NEW_API_QUOTA_PER_USD = 500_000;
export const BALANCE_UNLIMITED_THRESHOLD = 99_000_000;
export const POSITIVE_BALANCE_CACHE_TTL_MS = 60_000;
export const NEGATIVE_BALANCE_CACHE_TTL_MS = 10 * 60_000;

export type BalanceProfile =
  | "auto"
  | "none"
  | "general"
  | "official"
  | "newapi"
  | "token_plan"
  | "custom";
export type BalanceWindowStatus = "ok" | "warning" | "exhausted" | "unknown";

export interface NormalizedBalanceWindow {
  readonly id: string;
  readonly label: string;
  readonly unit: string;
  readonly used?: number;
  readonly limit?: number;
  readonly remaining?: number;
  readonly usedFraction?: number;
  readonly remainingFraction?: number;
  readonly resetsAt?: string;
  readonly status: BalanceWindowStatus;
}

export interface NormalizedBalanceResult {
  readonly supported: boolean;
  readonly source: string;
  readonly currency: string;
  readonly unlimited: boolean;
  readonly total?: number;
  readonly used?: number;
  readonly remaining?: number;
  readonly planName?: string;
  readonly windows: readonly NormalizedBalanceWindow[];
  readonly fetchedAt?: string;
  readonly message: string;
  readonly transient: boolean;
}

export interface BalanceProfileInputs {
  readonly requestedProfile?: unknown;
  readonly usageStatus?: unknown;
  readonly baseURL?: unknown;
  readonly codingPlanProvider?: unknown;
  readonly accessToken?: unknown;
  readonly userID?: unknown;
  readonly queryURL?: unknown;
  readonly queryField?: unknown;
}

export type BalanceFailureKind = "transient" | "deterministic";

export type BalanceFailure =
  | { readonly kind: "transport" | "timeout" | "body_read"; readonly status?: undefined }
  | { readonly kind: "http"; readonly status: number }
  | {
      readonly kind:
        | "missing_credentials"
        | "invalid_url"
        | "invalid_json"
        | "invalid_payload"
        | "unsupported";
      readonly status?: undefined;
    };

export interface BalanceCacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

export type BalanceCache<T> = Readonly<Record<string, BalanceCacheEntry<T>>>;

const BALANCE_PROFILES = new Set<BalanceProfile>([
  "auto",
  "none",
  "general",
  "official",
  "newapi",
  "token_plan",
  "custom",
]);

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseNumericField(
  record: unknown,
  fields: readonly string[],
): { readonly value: number; readonly field: string } | undefined {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return undefined;
  }
  const object = record as Readonly<Record<string, unknown>>;
  for (const field of fields) {
    const value = finiteNumber(object[field]);
    if (value !== undefined) {
      return { value, field };
    }
  }
  return undefined;
}

export function lookupDotPath(root: unknown, path: string): unknown | undefined {
  let current = root;
  for (const rawSegment of path.split(".")) {
    const segment = rawSegment.trim();
    if (!segment) continue;

    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      const index = Number(segment);
      if (index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (current === null || typeof current !== "object") return undefined;
    const object = current as Readonly<Record<string, unknown>>;
    if (!Object.prototype.hasOwnProperty.call(object, segment)) return undefined;
    current = object[segment];
  }
  return current;
}

export function parseNumericDotPath(root: unknown, path: string): number | undefined {
  return finiteNumber(lookupDotPath(root, path));
}

function isCodingPlan(baseURL: string, explicitProvider: string): boolean {
  if (
    ["kimi", "zhipu", "zhipu_team", "minimax", "zenmux", "volcengine"].includes(explicitProvider)
  ) {
    return true;
  }
  const url = baseURL.toLowerCase();
  return [
    "api.kimi.com/coding",
    "bigmodel.cn",
    "api.z.ai",
    "api.minimaxi.com",
    "api.minimax.io",
    "api.minimax.com",
    "zenmux",
    "volces.com/api/coding",
  ].some((part) => url.includes(part));
}

export function resolveBalanceProfile(inputs: BalanceProfileInputs): BalanceProfile {
  const usageStatus = cleanString(inputs.usageStatus).toLowerCase();
  if (usageStatus === "none") return "none";
  if (usageStatus === "general") return "general";
  if (usageStatus === "newapi") return "newapi";
  if (usageStatus === "token_plan") return "token_plan";
  if (usageStatus === "custom_only") return "custom";

  const requested = cleanString(inputs.requestedProfile).toLowerCase();
  if (BALANCE_PROFILES.has(requested as BalanceProfile)) {
    return requested as BalanceProfile;
  }
  if (
    isCodingPlan(cleanString(inputs.baseURL), cleanString(inputs.codingPlanProvider).toLowerCase())
  ) {
    return "token_plan";
  }
  if (cleanString(inputs.accessToken) && cleanString(inputs.userID)) {
    return "newapi";
  }
  if (cleanString(inputs.queryURL) && cleanString(inputs.queryField)) {
    return "custom";
  }
  return "auto";
}

function unlimitedResult(
  source: string,
  currency: string,
  planName?: string,
): NormalizedBalanceResult {
  return {
    supported: true,
    source,
    currency,
    unlimited: true,
    ...(planName ? { planName } : {}),
    windows: [],
    message: "额度不限",
    transient: false,
  };
}

export function parseNewAPIQuota(payload: unknown): NormalizedBalanceResult | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const root = payload as Readonly<Record<string, unknown>>;
  if (root.success === false) return undefined;
  if (root.data === null || typeof root.data !== "object" || Array.isArray(root.data))
    return undefined;
  const data = root.data as Readonly<Record<string, unknown>>;
  const quota = finiteNumber(data.quota);
  if (quota === undefined) return undefined;

  const remaining = quota / NEW_API_QUOTA_PER_USD;
  const planName = cleanString(data.group) || "默认套餐";
  if (remaining >= BALANCE_UNLIMITED_THRESHOLD) return unlimitedResult("newapi", "USD", planName);

  const usedQuota = finiteNumber(data.used_quota);
  const used = usedQuota === undefined ? undefined : usedQuota / NEW_API_QUOTA_PER_USD;
  return {
    supported: true,
    source: "newapi",
    currency: "USD",
    unlimited: false,
    ...(used === undefined ? {} : { total: remaining + used, used }),
    remaining,
    planName,
    windows: [],
    message: "查询成功",
    transient: false,
  };
}

export function parseDeepSeekBalance(payload: unknown): NormalizedBalanceResult | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const root = payload as Readonly<Record<string, unknown>>;
  const rawBalances = root["balance_infos"];
  if (!Array.isArray(rawBalances)) return undefined;

  const balances = new Map<string, number>();
  const currencyOrder: string[] = [];
  for (const entry of rawBalances) {
    const totalBalance = parseNumericField(entry, ["total_balance"]);
    if (!totalBalance) continue;
    const record = entry as Readonly<Record<string, unknown>>;
    const currency =
      typeof record["currency"] === "string" && record["currency"].trim()
        ? record["currency"].trim().toUpperCase()
        : "CNY";
    if (!balances.has(currency)) currencyOrder.push(currency);
    balances.set(currency, (balances.get(currency) ?? 0) + totalBalance.value);
  }
  if (currencyOrder.length === 0) return undefined;

  const currency = currencyOrder.find((entry) => entry === "CNY") ?? currencyOrder[0]!;
  const remaining = balances.get(currency);
  if (remaining === undefined) return undefined;
  const available = root["is_available"];
  return {
    supported: true,
    source: "deepseek",
    currency,
    unlimited: false,
    remaining,
    windows: [],
    message:
      available === false
        ? "余额不足"
        : currencyOrder.length > 1
          ? `查询成功（多币种，仅显示 ${currency}）`
          : "查询成功",
    transient: false,
  };
}

export function parseMoonshotBalance(
  payload: unknown,
  currency: "CNY" | "USD",
): NormalizedBalanceResult | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const root = payload as Readonly<Record<string, unknown>>;
  if (root["status"] === false || (typeof root["code"] === "number" && root["code"] !== 0))
    return undefined;
  const remaining = parseNumericField(root["data"], ["available_balance"])?.value;
  if (remaining === undefined) return undefined;
  return {
    supported: true,
    source: "moonshot",
    currency,
    unlimited: false,
    remaining,
    windows: [],
    message: "查询成功",
    transient: false,
  };
}

export function parseStepFunAccount(
  payload: unknown,
  currency: "CNY" | "USD",
): NormalizedBalanceResult | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const root = payload as Readonly<Record<string, unknown>>;
  if (root["object"] !== "account") return undefined;
  const remaining = parseNumericField(root, ["balance"])?.value;
  if (remaining === undefined) return undefined;
  return {
    supported: true,
    source: "stepfun_account",
    currency,
    unlimited: false,
    remaining,
    windows: [],
    message: "账户余额查询成功",
    transient: false,
  };
}

export function parseNovitaAccount(payload: unknown): NormalizedBalanceResult | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const raw = (payload as Readonly<Record<string, unknown>>)["credit_balance"];
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const credits = String(raw).trim();
  if (!/^\d+$/u.test(credits)) return undefined;
  const units = Number(credits);
  if (!Number.isSafeInteger(units)) return undefined;
  return {
    supported: true,
    source: "novita_account",
    currency: "USD",
    unlimited: false,
    remaining: units / 10_000,
    windows: [],
    message: "账户余额查询成功",
    transient: false,
  };
}

export function parseOpenRouterCredits(payload: unknown): NormalizedBalanceResult | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const data = (payload as Readonly<Record<string, unknown>>).data;
  const total = parseNumericField(data, ["total_credits"])?.value;
  const used = parseNumericField(data, ["total_usage"])?.value;
  if (total === undefined || used === undefined || total < 0 || used < 0) return undefined;
  return {
    supported: true,
    source: "openrouter_credits",
    currency: "USD",
    unlimited: false,
    total,
    used,
    remaining: total - used,
    windows: [],
    message: "账户余额查询成功",
    transient: false,
  };
}

export function parseOpenRouterKeyLimit(payload: unknown): NormalizedBalanceResult | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const data = (payload as Readonly<Record<string, unknown>>).data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Readonly<Record<string, unknown>>;
  if (record.limit === null && record.limit_remaining === null) {
    return {
      supported: true,
      source: "openrouter_key_limit",
      currency: "USD",
      unlimited: false,
      windows: [],
      message: "当前 API Key 未设置支出上限；账户余额需管理密钥查询",
      transient: false,
    };
  }
  const total = parseNumericField(data, ["limit"])?.value;
  const remaining = parseNumericField(data, ["limit_remaining"])?.value;
  if (total === undefined || remaining === undefined || total < 0) return undefined;
  return {
    supported: true,
    source: "openrouter_key_limit",
    currency: "USD",
    unlimited: false,
    total,
    remaining,
    windows: [],
    message: "当前 API Key 支出限额；非账户余额",
    transient: false,
  };
}

export function parseOpenAIBilling(
  subscription: unknown,
  usage?: unknown,
): NormalizedBalanceResult | undefined {
  const totalField = parseNumericField(subscription, ["hard_limit_usd", "system_hard_limit_usd"]);
  if (!totalField) return undefined;
  const total = totalField.value;
  if (total >= BALANCE_UNLIMITED_THRESHOLD) return unlimitedResult("openai_billing", "USD");

  const usageField = parseNumericField(usage, ["total_usage"]);
  const used = usageField ? usageField.value / 100 : undefined;
  return {
    supported: true,
    source: "openai_billing",
    currency: "USD",
    unlimited: false,
    total,
    ...(used === undefined ? {} : { used, remaining: total - used }),
    windows: [],
    message: "查询成功",
    transient: false,
  };
}

// ── 智谱 GLM / Z.ai（open.bigmodel.cn 控制台接口族）───────────────────────────
//
// Coding Plan 配额走 `GET /api/monitor/usage/quota/limit`（Authorization 直填
// API Key），钱包余额走 `GET /api/biz/account/query-customer-account-report`，
// 控制台报表路由不可用时回退文档化的 `GET /api/paas/v4/balance`（Bearer 形式）。
// 响应结构按社区核实脚本（cc-switch / TokenLedger）对齐，字段缺失一律留空
// 而不是补零：「没读到」和「余额为零」是两件事。

const ZHIPU_TOKEN_LIMIT_TYPES = new Set(["TOKENS_LIMIT", "CREDIT_LIMIT"]);

/** Z.ai 窗口长度单位码 → 每单位分钟数；未识别的码不猜。 */
const ZHIPU_UNIT_MINUTES = new Map([
  [5, 1],
  [3, 60],
  [1, 24 * 60],
  [6, 7 * 24 * 60],
]);

const zhipuLimitMinutes = (limit: Readonly<Record<string, unknown>>): number | undefined => {
  const unit = finiteNumber(limit["unit"]);
  const count = finiteNumber(limit["number"]);
  const per = unit === undefined ? undefined : ZHIPU_UNIT_MINUTES.get(Math.trunc(unit));
  return per === undefined || count === undefined || count <= 0 ? undefined : per * count;
};

const zhipuWindowLabel = (minutes: number | undefined): string => {
  if (minutes === undefined) return "额度窗口";
  if (minutes >= 7 * 24 * 60) return "每周额度";
  if (minutes >= 24 * 60) return "每日额度";
  if (minutes >= 60) return `${Math.round(minutes / 60)} 小时额度`;
  return `${Math.round(minutes)} 分钟额度`;
};

const zhipuLimitToWindow = (
  limit: Readonly<Record<string, unknown>>,
  id: string,
): NormalizedBalanceWindow | undefined => {
  const minutes = zhipuLimitMinutes(limit);
  const percentage = finiteNumber(limit["percentage"]) ?? finiteNumber(limit["usedPercent"]);
  const resetsAt =
    typeof limit["nextResetTime"] === "string" && limit["nextResetTime"].trim() !== ""
      ? limit["nextResetTime"].trim()
      : undefined;
  // quota/limit 的 percentage 是「已用百分比」；没有百分比时退回
  // currentValue/usage（usage 在这些行上是配额而非已用量）。
  const current = finiteNumber(limit["currentValue"]);
  const allowance = finiteNumber(limit["usage"]);
  const remainingCount = finiteNumber(limit["remaining"]);
  const usedFraction =
    percentage !== undefined
      ? percentage / 100
      : current !== undefined && allowance !== undefined && allowance > 0
        ? current / allowance
        : undefined;
  if (usedFraction === undefined && remainingCount === undefined) return undefined;
  const isCreditLimit = String(limit["type"] ?? "").toUpperCase() === "CREDIT_LIMIT";
  const percentView = percentage !== undefined;
  return normalizeBalanceWindow({
    id,
    label: zhipuWindowLabel(minutes),
    unit: percentView ? "%" : isCreditLimit ? "credits" : "tokens",
    ...(percentView
      ? { used: percentage, limit: 100 }
      : current !== undefined && allowance !== undefined
        ? { used: current, limit: allowance }
        : {}),
    ...(remainingCount !== undefined ? { remaining: remainingCount } : {}),
    ...(usedFraction !== undefined ? { usedFraction } : {}),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  });
};

/** 解析 quota/limit 响应；结构不认识时返回 undefined（让调用方换下一个端点）。 */
export function parseZhipuQuotaWindows(
  payload: unknown,
):
  | { readonly planName?: string; readonly windows: readonly NormalizedBalanceWindow[] }
  | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const root = payload as Readonly<Record<string, unknown>>;
  if (root.success === false) return undefined;
  const data = root.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Readonly<Record<string, unknown>>;
  if (!Array.isArray(record.limits)) return undefined;

  const typeOf = (limit: unknown): string =>
    limit !== null && typeof limit === "object" && !Array.isArray(limit)
      ? String((limit as Readonly<Record<string, unknown>>)["type"] ?? "").toUpperCase()
      : "";
  const minutesOf = (limit: unknown): number =>
    limit !== null && typeof limit === "object" && !Array.isArray(limit)
      ? (zhipuLimitMinutes(limit as Readonly<Record<string, unknown>>) ?? Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;

  const tokenLimits = record.limits
    .filter((limit) => ZHIPU_TOKEN_LIMIT_TYPES.has(typeOf(limit)))
    .sort((left, right) => minutesOf(left) - minutesOf(right));
  const billingLimit = record.limits.find((limit) => typeOf(limit) === "TIME_LIMIT");

  // 最短的 token 窗口是滚动窗口（5 小时），最长的当作每周；顺序不保证时排序兜底。
  const windows = [
    tokenLimits.length > 0 ? zhipuLimitToWindow(asRecord(tokenLimits[0]), "session") : undefined,
    tokenLimits.length > 1
      ? zhipuLimitToWindow(asRecord(tokenLimits[tokenLimits.length - 1]!), "weekly")
      : undefined,
    billingLimit !== undefined ? zhipuLimitToWindow(asRecord(billingLimit), "billing") : undefined,
  ].filter((window): window is NormalizedBalanceWindow => window !== undefined);

  const planName =
    typeof record.level === "string" && record.level.trim() !== ""
      ? record.level.trim().toUpperCase()
      : undefined;
  if (windows.length === 0 && planName === undefined) return undefined;
  return { ...(planName === undefined ? {} : { planName }), windows };
}

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};

/**
 * 组合智谱钱包（account report 或 v4/balance 回退）与 Coding Plan 配额窗口。
 * 两路任一有数据即成功；都没有时返回 undefined。
 */
export function parseZhipuBalance(
  report: unknown,
  quota?: unknown,
  v4Balance?: unknown,
): NormalizedBalanceResult | undefined {
  const quotaResult = quota === undefined ? undefined : parseZhipuQuotaWindows(quota);

  let remaining: number | undefined;
  let used: number | undefined;
  let currency = "CNY";
  if (report !== null && typeof report === "object" && !Array.isArray(report)) {
    const root = report as Readonly<Record<string, unknown>>;
    if (root.success !== false) {
      const data = asRecord(root.data);
      const available = finiteNumber(data.availableBalance) ?? finiteNumber(data.balance);
      if (available !== undefined) {
        remaining = available;
        used = finiteNumber(data.totalSpendAmount);
        if (typeof data.currency === "string" && data.currency.trim() !== "") {
          currency = data.currency.trim().toUpperCase();
        }
      }
    }
  }
  if (remaining === undefined && v4Balance !== null && typeof v4Balance === "object") {
    const root = v4Balance as Readonly<Record<string, unknown>>;
    if (root.success !== false) {
      const data = asRecord(root.data);
      const available = finiteNumber(data.available_balance);
      if (available !== undefined) {
        remaining = available;
        if (typeof data.currency === "string" && data.currency.trim() !== "") {
          currency = data.currency.trim().toUpperCase();
        }
      }
    }
  }

  if (remaining === undefined && (quotaResult === undefined || quotaResult.windows.length === 0)) {
    return undefined;
  }

  return {
    supported: true,
    source: "zhipu",
    currency,
    unlimited: false,
    ...(remaining !== undefined ? { remaining } : {}),
    ...(used !== undefined && remaining !== undefined ? { total: used + remaining, used } : {}),
    ...(quotaResult?.planName === undefined ? {} : { planName: quotaResult.planName }),
    windows: quotaResult?.windows ?? [],
    message: "查询成功",
    transient: false,
  };
}

export function normalizeBalanceWindow(
  input: Omit<NormalizedBalanceWindow, "status"> & { readonly status?: BalanceWindowStatus },
): NormalizedBalanceWindow {
  const usedFraction =
    input.usedFraction ??
    (input.used !== undefined && input.limit !== undefined && input.limit > 0
      ? input.used / input.limit
      : undefined);
  const remainingFraction =
    input.remainingFraction ?? (usedFraction === undefined ? undefined : 1 - usedFraction);
  const status =
    input.status ??
    (remainingFraction === undefined
      ? "unknown"
      : remainingFraction <= 0
        ? "exhausted"
        : remainingFraction <= 0.2
          ? "warning"
          : "ok");
  return {
    ...input,
    ...(usedFraction === undefined ? {} : { usedFraction }),
    ...(remainingFraction === undefined ? {} : { remainingFraction }),
    status,
  };
}

export function classifyBalanceFailure(failure: BalanceFailure): BalanceFailureKind {
  return failure.kind === "transport" || failure.kind === "timeout" || failure.kind === "body_read"
    ? "transient"
    : "deterministic";
}

export function balanceCacheGet<T>(
  cache: BalanceCache<T>,
  key: string,
  now: number,
): T | undefined {
  const entry = cache[key];
  return entry && entry.expiresAt > now ? entry.value : undefined;
}

export function balanceCacheSet<T>(
  cache: BalanceCache<T>,
  key: string,
  value: T,
  kind: "positive" | "negative",
  now: number,
): BalanceCache<T> {
  const ttl = kind === "positive" ? POSITIVE_BALANCE_CACHE_TTL_MS : NEGATIVE_BALANCE_CACHE_TTL_MS;
  return { ...cache, [key]: { value, expiresAt: now + ttl } };
}

export function balanceCacheDelete<T>(cache: BalanceCache<T>, key: string): BalanceCache<T> {
  const { [key]: _deleted, ...rest } = cache;
  return rest;
}

export function shouldCacheBalanceResult(
  result: NormalizedBalanceResult,
): "positive" | "negative" | undefined {
  if (result.supported) return "positive";
  return result.transient ? undefined : "negative";
}
