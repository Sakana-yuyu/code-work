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
