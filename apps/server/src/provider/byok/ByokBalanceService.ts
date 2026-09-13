import type {
  ByokBalanceDashboardRequest,
  ByokBalanceDashboardResult,
  ByokBalanceRequest,
  ByokBalanceResult,
  ByokModelAdapter,
  ServerSettings as ServerSettingsContract,
  ServerSettingsError,
} from "@codework/contracts";
import { resolveProviderInstanceEnabled } from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { HttpClient } from "effect/unstable/http";

import * as ServerSettings from "../../serverSettings.ts";
import {
  balanceCacheGet,
  balanceCacheSet,
  parseDeepSeekBalance,
  parseNewAPIQuota,
  parseOpenAIBilling,
  parseZhipuBalance,
  resolveBalanceProfile,
  shouldCacheBalanceResult,
  type BalanceCache,
  type NormalizedBalanceResult,
} from "./BalanceCore.ts";
import {
  projectByokBalanceDashboard,
  type ByokBalanceDashboardAdapterInput,
  type ByokBalanceDashboardInstanceInput,
} from "./ByokBalanceDashboardCore.ts";
import { supplierTemplate } from "./SupplierCatalog.ts";
import { fetchByokCatalog } from "./byokHttp.ts";
import type { ByokHttpError } from "./byokHttp.ts";

type BalanceErrorCode = NonNullable<ByokBalanceResult["error"]>["code"];

interface CacheEntry {
  readonly fingerprint: string;
  readonly result: ByokBalanceResult;
}

const cacheRef = Effect.runSync(Ref.make<BalanceCache<CacheEntry>>({}));

const errorMessage = (code: BalanceErrorCode): string => {
  switch (code) {
    case "missing_credentials":
      return "The BYOK adapter has no API key configured.";
    case "unsupported_profile":
      return "This BYOK adapter does not support balance queries.";
    case "invalid_endpoint":
      return "The balance endpoint is invalid.";
    case "timeout":
      return "The balance request timed out.";
    case "response_too_large":
      return "The balance response is too large.";
    case "redirect_blocked":
      return "The balance redirect was blocked.";
    case "upstream_http":
      return "The balance endpoint returned an HTTP error.";
    case "invalid_payload":
      return "The balance response is invalid.";
  }
};

const failure = (
  input: ByokBalanceRequest,
  source: string,
  code: BalanceErrorCode,
  transient = false,
): ByokBalanceResult => ({
  instanceId: input.instanceId,
  adapterId: input.adapterId,
  supported: false,
  source,
  currency: "",
  unlimited: false,
  windows: [],
  message: errorMessage(code),
  transient,
  error: { code, message: errorMessage(code) },
});

const mapHttpError = (error: ByokHttpError): BalanceErrorCode =>
  error.code === "invalid_endpoint"
    ? "invalid_endpoint"
    : error.code === "timeout"
      ? "timeout"
      : error.code === "response_too_large"
        ? "response_too_large"
        : error.code === "redirect_blocked"
          ? "redirect_blocked"
          : "upstream_http";

const adapterFromSettings = (
  settings: ServerSettingsContract,
  input: ByokBalanceRequest,
): ByokModelAdapter | undefined => {
  const instance =
    settings.providerInstances[input.instanceId as keyof typeof settings.providerInstances];
  if (instance?.driver !== "byok") return undefined;
  const config = instance.config;
  if (config === null || typeof config !== "object" || Array.isArray(config)) return undefined;
  const adapters = (config as Record<string, unknown>).adapters;
  if (!Array.isArray(adapters)) return undefined;
  return adapters.find(
    (adapter): adapter is ByokModelAdapter =>
      adapter !== null &&
      typeof adapter === "object" &&
      (adapter as Record<string, unknown>).id === input.adapterId,
  );
};

const fingerprintFor = (adapter: ByokModelAdapter): string =>
  JSON.stringify([
    adapter.protocol,
    adapter.baseURL,
    adapter.supplierID ?? "",
    adapter.balanceProfile ?? "",
    adapter.balanceUserID ?? "",
    // Token length only: rotates the cache when the stored secret changes
    // without embedding the secret itself in the fingerprint.
    adapter.balanceAccessToken?.length ?? 0,
  ]);

const billingOrigin = (baseURL: string): string | null => {
  try {
    return new URL(baseURL).origin;
  } catch {
    return null;
  }
};

const parseJson = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

interface BalanceAttempt {
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Optional companion usage endpoint for OpenAI-style billing. */
  readonly usageEndpoint?: string;
  readonly parse: (payload: unknown, usage?: unknown) => NormalizedBalanceResult | undefined;
}

/**
 * Build the endpoint list for a profile. "newapi" proper needs an access
 * token + user id that we deliberately do not persist; as a pragmatic
 * fallback many relays expose `/api/user/self` to the API key itself, so both
 * that and the OpenAI-style billing endpoints are attempted in auto mode.
 */
const attemptsFor = (
  adapter: ByokModelAdapter,
  profile: "general" | "newapi",
): readonly BalanceAttempt[] => {
  const origin = billingOrigin(adapter.baseURL);
  if (!origin) return [];
  const authHeaders =
    adapter.protocol === "anthropic"
      ? { "x-api-key": adapter.apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${adapter.apiKey}` };
  if (profile === "newapi") {
    return [
      {
        endpoint: `${origin}/api/user/self`,
        headers: {
          authorization: `Bearer ${adapter.balanceAccessToken || adapter.apiKey}`,
          ...(adapter.balanceUserID ? { "new-api-user": adapter.balanceUserID } : {}),
          accept: "application/json",
        },
        parse: parseNewAPIQuota,
      },
    ];
  }
  return [
    {
      endpoint: `${origin}/v1/dashboard/billing/subscription`,
      usageEndpoint: `${origin}/v1/dashboard/billing/usage`,
      headers: authHeaders,
      parse: (payload, usage) => parseOpenAIBilling(payload, usage),
    },
    {
      endpoint: `${origin}/dashboard/billing/subscription`,
      usageEndpoint: `${origin}/dashboard/billing/usage`,
      headers: authHeaders,
      parse: (payload, usage) => parseOpenAIBilling(payload, usage),
    },
    {
      endpoint: `${origin}/api/user/self`,
      headers: { authorization: `Bearer ${adapter.apiKey}`, accept: "application/json" },
      parse: parseNewAPIQuota,
    },
  ];
};

const usesOfficialDeepSeekEndpoint = (baseURL: string): boolean => {
  try {
    const url = new URL(baseURL);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "api.deepseek.com";
  } catch {
    return false;
  }
};

const deepSeekAttempts = (adapter: ByokModelAdapter): readonly BalanceAttempt[] => [
  {
    endpoint: "https://api.deepseek.com/user/balance",
    headers: { authorization: `Bearer ${adapter.apiKey}`, accept: "application/json" },
    parse: (payload) => parseDeepSeekBalance(payload),
  },
];

/**
 * 智谱 GLM / Z.ai 的计费 origin：控制台接口族挂在 open.bigmodel.cn（国内）或
 * api.z.ai（国际），推理 baseURL 可能是同域或裸域，统一归一到计费域。
 */
const zhipuBillingOrigin = (baseURL: string): string | null => {
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    if (host === "open.bigmodel.cn" || host === "www.bigmodel.cn" || host === "bigmodel.cn") {
      return "https://open.bigmodel.cn";
    }
    if (host === "api.z.ai" || host === "z.ai") return "https://api.z.ai";
    return null;
  } catch {
    return null;
  }
};

/**
 * 智谱尝试链。主请求是 Coding Plan 配额窗口（quota/limit），伴随请求是钱包
 * 报表（query-customer-account-report）——两个控制台路由都用裸 Key；报表是
 * 前端路由、并非所有 origin 都提供，主请求成功而报表失败时仍返回窗口。
 * 报表不可用且需要钱包时的兜底是文档化的 v4 balance（Bearer 形式）。
 */
const zhipuAttempts = (adapter: ByokModelAdapter): readonly BalanceAttempt[] => {
  const origin = zhipuBillingOrigin(adapter.baseURL);
  if (!origin) return [];
  const consoleHeaders = { authorization: adapter.apiKey, accept: "application/json" };
  return [
    {
      endpoint: `${origin}/api/monitor/usage/quota/limit`,
      usageEndpoint: `${origin}/api/biz/account/query-customer-account-report`,
      headers: consoleHeaders,
      parse: (quota, report) => parseZhipuBalance(report, quota),
    },
    {
      endpoint: `${origin}/api/paas/v4/balance`,
      headers: { authorization: `Bearer ${adapter.apiKey}`, accept: "application/json" },
      parse: (v4Balance) => parseZhipuBalance(undefined, undefined, v4Balance),
    },
  ];
};

const toResult = (
  input: ByokBalanceRequest,
  normalized: NormalizedBalanceResult,
  fetchedAtIso: string,
  cached = false,
): ByokBalanceResult => ({
  instanceId: input.instanceId,
  adapterId: input.adapterId,
  supported: normalized.supported,
  source: normalized.source,
  currency: normalized.currency,
  unlimited: normalized.unlimited,
  ...(normalized.total !== undefined ? { total: normalized.total } : {}),
  ...(normalized.used !== undefined ? { used: normalized.used } : {}),
  ...(normalized.remaining !== undefined ? { remaining: normalized.remaining } : {}),
  ...(normalized.planName !== undefined ? { planName: normalized.planName } : {}),
  windows: [...normalized.windows],
  fetchedAt: fetchedAtIso,
  message: normalized.message,
  transient: normalized.transient,
  ...(cached ? { cached: true } : {}),
});

/**
 * List a BYOK instance's adapters from the opaque config blob. Same duck
 * typing as `adapterFromSettings`, but returning the whole array so the
 * dashboard can enumerate.
 */
const byokAdaptersFromConfig = (config: unknown): ReadonlyArray<ByokModelAdapter> => {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return [];
  const adapters = (config as Record<string, unknown>).adapters;
  if (!Array.isArray(adapters)) return [];
  return adapters.filter(
    (adapter): adapter is ByokModelAdapter =>
      adapter !== null &&
      typeof adapter === "object" &&
      typeof (adapter as Record<string, unknown>).id === "string",
  );
};

export interface ByokBalanceService {
  readonly balance: (
    input: ByokBalanceRequest,
  ) => Effect.Effect<
    ByokBalanceResult,
    never,
    HttpClient.HttpClient | ServerSettings.ServerSettingsService
  >;
  /**
   * Aggregate balance/usage/health across every configured BYOK instance.
   * Each adapter query reuses `balance` (including its cache); per-adapter
   * failures are carried as structured error results, never swallowed.
   */
  readonly dashboard: (
    input: ByokBalanceDashboardRequest,
  ) => Effect.Effect<
    ByokBalanceDashboardResult,
    ServerSettingsError,
    HttpClient.HttpClient | ServerSettings.ServerSettingsService
  >;
}

export const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const balance = (input: ByokBalanceRequest) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const adapter = adapterFromSettings(settings, input);
      if (!adapter) return failure(input, "settings", "unsupported_profile");
      if (adapter.apiKey.trim() === "") return failure(input, "settings", "missing_credentials");
      const template = supplierTemplate(adapter.supplierID);
      const profile = resolveBalanceProfile({
        requestedProfile: adapter.balanceProfile,
        ...(template.usage.status === "newapi" || template.usage.status === "general"
          ? { usageStatus: template.usage.status }
          : {}),
        baseURL: adapter.baseURL,
      });
      const fingerprint = fingerprintFor(adapter);
      const cacheKey = `${input.instanceId}:${input.adapterId}`;
      const now = yield* Clock.currentTimeMillis;
      if (!input.forceRefresh) {
        const cache = yield* Ref.get(cacheRef);
        const cached = balanceCacheGet(cache, cacheKey, now);
        if (cached && cached.fingerprint === fingerprint) {
          return { ...cached.result, cached: true };
        }
      }
      // A stored "none" used to be stamped onto adapters whose supplier has
      // since gained a verified balance implementation (e.g. DeepSeek), so a
      // known-official host or supplier overrides the legacy opt-out; the
      // query is user-initiated anyway. Everything else stays hard-opted-out.
      const supportedProfile =
        profile === "general" || profile === "newapi" || profile === "auto"
          ? profile
          : profile === "none" &&
              (usesOfficialDeepSeekEndpoint(adapter.baseURL) || template.usage.status === "fixed")
            ? ("auto" as const)
            : null;
      // 智谱计费域有专属接口族：模板声明为 token_plan（或用户落在该域的
      // auto/general/newapi）都由智谱尝试链应答；显式 "none" 仍然尊重。
      const zhipuOrigin =
        profile !== "none" && profile !== "custom" ? zhipuBillingOrigin(adapter.baseURL) : null;
      if (supportedProfile === null && zhipuOrigin === null) {
        return failure(input, "manual", "unsupported_profile");
      }
      // Native Gemini has no public balance endpoint; auto mode would only
      // burn two doomed requests against the Google origin.
      if (adapter.protocol === "gemini" && supportedProfile === "auto") {
        return failure(input, "manual", "unsupported_profile");
      }
      const candidateProfiles: readonly ("general" | "newapi")[] =
        supportedProfile === "general" || supportedProfile === "newapi"
          ? [supportedProfile]
          : ["general", "newapi"];
      const attempts =
        zhipuOrigin !== null
          ? zhipuAttempts(adapter)
          : usesOfficialDeepSeekEndpoint(adapter.baseURL)
            ? deepSeekAttempts(adapter)
            : candidateProfiles.flatMap((candidateProfile) =>
                attemptsFor(adapter, candidateProfile),
              );
      let lastError: ByokBalanceResult | undefined;
      for (const attempt of attempts) {
        const response = yield* Effect.result(
          fetchByokCatalog({ url: attempt.endpoint, headers: attempt.headers }),
        );
        if (response._tag === "Failure") {
          lastError = failure(
            input,
            new URL(attempt.endpoint).origin,
            mapHttpError(response.failure),
            response.failure.code === "timeout",
          );
          continue;
        }
        if (response.success.status === 401 || response.success.status === 403) {
          lastError = failure(input, new URL(attempt.endpoint).origin, "upstream_http");
          continue;
        }
        if (response.success.status < 200 || response.success.status >= 300) {
          lastError = failure(input, new URL(attempt.endpoint).origin, "upstream_http");
          continue;
        }
        let usagePayload: unknown;
        if (attempt.usageEndpoint !== undefined) {
          const usageResponse = yield* Effect.result(
            fetchByokCatalog({ url: attempt.usageEndpoint, headers: attempt.headers }),
          );
          usagePayload =
            usageResponse._tag === "Success" &&
            usageResponse.success.status >= 200 &&
            usageResponse.success.status < 300
              ? parseJson(usageResponse.success.body)
              : undefined;
        }
        const parsed = attempt.parse(parseJson(response.success.body), usagePayload);
        if (parsed === undefined || !parsed.supported) {
          lastError = failure(input, new URL(attempt.endpoint).origin, "invalid_payload");
          continue;
        }
        const result = toResult(input, parsed, DateTime.formatIso(yield* DateTime.now));
        const cacheKind = shouldCacheBalanceResult(parsed);
        if (cacheKind !== undefined) {
          const fetchedAt = yield* Clock.currentTimeMillis;
          yield* Ref.update(cacheRef, (cache) =>
            balanceCacheSet(cache, cacheKey, { fingerprint, result }, cacheKind, fetchedAt),
          );
        }
        return result;
      }
      return lastError ?? failure(input, "balance", "invalid_payload");
    }).pipe(Effect.catch(() => Effect.succeed(failure(input, "service", "invalid_payload"))));

  const dashboard = (input: ByokBalanceDashboardRequest) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const byokInstances = Object.entries(settings.providerInstances).filter(
        ([, instance]) => instance.driver === "byok",
      );
      const instances = yield* Effect.forEach(
        byokInstances,
        ([instanceId, instance]) =>
          Effect.gen(function* () {
            const adapters = byokAdaptersFromConfig(instance.config);
            const adapterEntries = yield* Effect.forEach(
              adapters,
              (adapter) =>
                balance({
                  instanceId,
                  adapterId: adapter.id,
                  ...(input.forceRefresh === undefined ? {} : { forceRefresh: input.forceRefresh }),
                }).pipe(
                  Effect.map(
                    (result): ByokBalanceDashboardAdapterInput => ({
                      adapterId: adapter.id,
                      // The config blob is duck-typed; a malformed adapter may
                      // lack displayName at runtime despite the schema type.
                      ...(typeof adapter.displayName === "string" &&
                      adapter.displayName.trim() !== ""
                        ? { displayName: adapter.displayName }
                        : {}),
                      ...(typeof adapter.baseURL === "string" && adapter.baseURL.trim() !== ""
                        ? { baseURL: adapter.baseURL }
                        : {}),
                      balance: result,
                    }),
                  ),
                ),
              { concurrency: 4 },
            );
            return {
              instanceId,
              ...(instance.displayName === undefined ? {} : { displayName: instance.displayName }),
              enabled: resolveProviderInstanceEnabled(instance),
              adapters: adapterEntries,
            } satisfies ByokBalanceDashboardInstanceInput;
          }),
        { concurrency: 2 },
      );
      const nowUnixMs = yield* Clock.currentTimeMillis;
      return projectByokBalanceDashboard({ instances, nowUnixMs });
    });

  return { balance, dashboard } satisfies ByokBalanceService;
});
