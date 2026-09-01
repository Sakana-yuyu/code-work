export type ByokProviderType = "openai" | "anthropic" | "gemini";

export interface ModelPricing {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly currency?: string;
  readonly known: true;
  readonly source: "catalog";
}

export interface ModelCatalogItem {
  readonly id: string;
  readonly object?: string;
  readonly ownedBy?: string;
  readonly contextWindowTokens?: number;
  readonly pricing?: ModelPricing;
  readonly capabilities?: Readonly<Record<string, unknown>>;
}

export interface ModelCatalogCandidateOptions {
  readonly type: ByokProviderType;
  readonly baseURL: string;
  readonly modelCatalogURL?: string;
  readonly modelCatalogURLs?: readonly string[];
  readonly appendGeneratedCandidates?: boolean;
}

export interface ModelContextRule<T> {
  readonly pattern: RegExp | string;
  readonly value: T;
}

export interface ModelContextMatch<T> {
  readonly covered: boolean;
  readonly normalizedID: string;
  readonly value?: T;
}

const SPECIAL_BASE_SUFFIXES = [
  "/api/claudecode",
  "/api/anthropic",
  "/apps/anthropic",
  "/api/coding",
  "/claudecode",
  "/anthropic",
  "/step_plan",
  "/coding",
  "/claude",
  "/compatible",
] as const;

export function normalizeModelID(value: string): string {
  let normalized = value.trim().toLowerCase();
  if (normalized.startsWith("models/")) normalized = normalized.slice("models/".length);
  const slash = normalized.lastIndexOf("/");
  if (slash >= 0) normalized = normalized.slice(slash + 1);
  return normalized.replace(/[ _]/g, "-");
}

export function matchModelContext<T>(
  modelID: string,
  rules: readonly ModelContextRule<T>[],
): ModelContextMatch<T> {
  const normalizedID = normalizeModelID(modelID);
  if (!normalizedID) return { covered: false, normalizedID };

  for (const rule of rules) {
    const pattern = typeof rule.pattern === "string" ? new RegExp(rule.pattern) : rule.pattern;
    pattern.lastIndex = 0;
    if (pattern.test(normalizedID)) {
      return { covered: true, normalizedID, value: rule.value };
    }
  }
  return { covered: false, normalizedID };
}

export function buildModelCatalogCandidates(options: ModelCatalogCandidateOptions): string[] {
  const baseURL = parseAbsoluteURL(options.baseURL).toString();
  const candidates: string[] = [];
  const append = (candidate: string | undefined) => {
    if (!candidate) return;
    const trimmed = candidate.trim();
    if (!trimmed || !isAbsoluteURL(trimmed) || candidates.includes(trimmed)) return;
    candidates.push(trimmed);
  };

  append(options.modelCatalogURL);
  for (const candidate of options.modelCatalogURLs ?? []) append(candidate);

  if (options.appendGeneratedCandidates !== false) {
    const generated =
      options.type === "gemini"
        ? geminiModelCatalogCandidates(baseURL)
        : openAICompatibleModelCatalogCandidates(baseURL);
    for (const candidate of generated) append(candidate);
  }

  return candidates;
}

export function decodeModelCatalog(payload: string | unknown): ModelCatalogItem[] {
  let value: unknown;
  try {
    value = typeof payload === "string" ? JSON.parse(payload) : payload;
  } catch {
    throw new Error("Model catalog response is not valid JSON");
  }

  let rawItems: unknown[] = [];
  if (Array.isArray(value)) {
    rawItems = value;
  } else if (isRecord(value)) {
    for (const key of ["data", "models", "items"] as const) {
      if (Array.isArray(value[key])) {
        rawItems = value[key];
        break;
      }
    }
  }

  const byID = new Map<string, ModelCatalogItem>();
  for (const rawItem of rawItems) {
    const item = modelCatalogItemFromValue(rawItem);
    if (item && !byID.has(item.id)) byID.set(item.id, item);
  }
  if (byID.size === 0) throw new Error("Model catalog response contains no usable models");

  return [...byID.values()].sort((left, right) =>
    left.id.localeCompare(right.id, "en", { sensitivity: "base" }),
  );
}

export function filterModelCatalogByType(
  models: readonly ModelCatalogItem[],
  type: ByokProviderType,
): ModelCatalogItem[] {
  if (type !== "anthropic") return [...models];
  const filtered = models.filter((model) => {
    const owner = model.ownedBy?.trim().toLowerCase() ?? "";
    return owner === "" || owner === "anthropic";
  });
  return filtered.length > 0 ? filtered : [...models];
}

function openAICompatibleModelCatalogCandidates(baseURL: string): string[] {
  const parsed = parseAbsoluteURL(baseURL);
  const path = trimTrailingSlashes(parsed.pathname);
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith("/models")) return [parsed.toString()];

  const paths: string[] = [];
  if (lowerPath.endsWith("/v1") || hasVersionPathSuffix(path)) {
    paths.push(`${path}/models`);
    if (!lowerPath.endsWith("/v1")) paths.push(`${path}/v1/models`);
  } else {
    paths.push(`${path}/v1/models`);
  }

  for (const suffix of SPECIAL_BASE_SUFFIXES) {
    if (!lowerPath.endsWith(suffix)) continue;
    const root = trimTrailingSlashes(path.slice(0, -suffix.length));
    if (root) paths.push(`${root}/v1/models`, `${root}/models`);
    break;
  }
  return paths.map((candidatePath) => withPath(parsed, candidatePath));
}

function geminiModelCatalogCandidates(baseURL: string): string[] {
  const parsed = parseAbsoluteURL(baseURL);
  const path = trimTrailingSlashes(parsed.pathname);
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith("/models")) return [parsed.toString()];
  return [
    withPath(parsed, lowerPath.endsWith("/v1beta") ? `${path}/models` : `${path}/v1beta/models`),
  ];
}

function modelCatalogItemFromValue(value: unknown): ModelCatalogItem | undefined {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id, object: "model" } : undefined;
  }
  if (!isRecord(value)) return undefined;

  const rawID = firstString(value, "id", "model", "name");
  if (!rawID) return undefined;
  const id = rawID.startsWith("models/") ? rawID.slice("models/".length) : rawID;
  const object = firstString(value, "object", "type");
  const ownedBy = firstString(value, "owned_by", "ownedBy", "provider");
  const contextWindowTokens = firstPositiveInteger(
    value,
    "contextWindowTokens",
    "context_window",
    "context_window_tokens",
    "contextLength",
    "context_length",
    "inputTokenLimit",
    "input_token_limit",
  );
  const pricing = modelPricingFromValue(value);
  const capabilities = isRecord(value.capabilities) ? value.capabilities : undefined;

  return {
    id,
    ...(object ? { object } : {}),
    ...(ownedBy ? { ownedBy } : {}),
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    ...(pricing ? { pricing } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
}

function modelPricingFromValue(value: Readonly<Record<string, unknown>>): ModelPricing | undefined {
  const nested = isRecord(value.pricing)
    ? value.pricing
    : isRecord(value.price)
      ? value.price
      : value;
  const input = firstNonNegativeNumber(
    nested,
    "input",
    "input_price",
    "inputPrice",
    "prompt",
    "prompt_price",
  );
  const output = firstNonNegativeNumber(
    nested,
    "output",
    "output_price",
    "outputPrice",
    "completion",
    "completion_price",
  );
  const cacheRead = firstNonNegativeNumber(
    nested,
    "cacheRead",
    "cache_read",
    "cache_read_price",
    "cacheReadPrice",
  );
  const cacheWrite = firstNonNegativeNumber(
    nested,
    "cacheWrite",
    "cache_write",
    "cache_write_price",
    "cacheWritePrice",
  );
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  )
    return undefined;
  const currency = firstString(nested, "currency", "unit");
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(currency ? { currency } : {}),
    known: true,
    source: "catalog",
  };
}

function firstString(
  value: Readonly<Record<string, unknown>>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function firstPositiveInteger(
  value: Readonly<Record<string, unknown>>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0)
      return candidate;
  }
  return undefined;
}

function firstNonNegativeNumber(
  value: Readonly<Record<string, unknown>>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0)
      return candidate;
  }
  return undefined;
}

function hasVersionPathSuffix(path: string): boolean {
  return /^v\d+$/i.test(path.slice(path.lastIndexOf("/") + 1));
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function withPath(base: URL, pathname: string): string {
  const candidate = new URL(base);
  candidate.pathname = pathname;
  return candidate.toString();
}

function isAbsoluteURL(value: string): boolean {
  try {
    parseAbsoluteURL(value);
    return true;
  } catch {
    return false;
  }
}

function parseAbsoluteURL(value: string): URL {
  const parsed = new URL(value.trim());
  if (!parsed.protocol || !parsed.host) throw new Error("Model catalog URL must be absolute");
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
