import type {
  ByokContextWindowMatchRequest,
  ByokContextWindowMatchResult,
  ByokDraftModelDiscoveryRequest,
  ByokDraftModelDiscoveryResult,
  ByokDiscoveredModel,
  ByokModelDiscoveryErrorCode,
  ByokModelDiscoveryResult,
  ByokModelDiscoveryRequest,
  ByokSupplierCatalogEntry,
  ByokModelAdapter,
  ServerSettings as ServerSettingsContract,
} from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { HttpClient } from "effect/unstable/http";

import * as ServerSettings from "../../serverSettings.ts";
import {
  buildModelCatalogCandidates,
  decodeModelCatalog,
  filterModelCatalogByType,
} from "./ModelCatalog.ts";
import { publicSupplierCatalog } from "./SupplierCatalogTransport.ts";
import { supplierTemplate } from "./SupplierCatalog.ts";
import { matchContextWindows } from "./ContextWindowMatcher.ts";
import { fetchByokCatalog } from "./byokHttp.ts";
import type { ByokHttpError } from "./byokHttp.ts";

interface CacheEntry {
  readonly fingerprint: string;
  readonly result: ByokModelDiscoveryResult;
  readonly expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const cacheRef = Effect.runSync(Ref.make(new Map<string, CacheEntry>()));

type ModelDiscoveryTarget = Pick<
  ByokModelAdapter,
  | "protocol"
  | "baseURL"
  | "apiKey"
  | "supplierID"
  | "modelCatalogURL"
  | "modelCatalogURLs"
  | "modelCatalogStatus"
  | "appendModelCatalogCandidates"
>;

const errorMessage = (code: ByokModelDiscoveryErrorCode): string => {
  switch (code) {
    case "missing_credentials":
      return "The BYOK adapter has no API key configured.";
    case "unsupported_catalog":
      return "This BYOK adapter does not support automatic model discovery.";
    case "invalid_endpoint":
      return "The model catalog endpoint is invalid.";
    case "timeout":
      return "The model catalog request timed out.";
    case "response_too_large":
      return "The model catalog response is too large.";
    case "redirect_blocked":
      return "The model catalog redirect was blocked.";
    case "upstream_http":
      return "The model catalog endpoint returned an HTTP error.";
    case "invalid_payload":
      return "The model catalog response is invalid.";
    case "no_models":
      return "The model catalog did not contain any models.";
  }
};

const draftResultError = (
  source: string,
  code: ByokModelDiscoveryErrorCode,
): ByokDraftModelDiscoveryResult => ({
  status: "failed",
  models: [],
  source,
  error: { code, message: errorMessage(code) },
});

const resultError = (
  input: ByokModelDiscoveryRequest,
  source: string,
  code: ByokModelDiscoveryErrorCode,
  stale = false,
): ByokModelDiscoveryResult => ({
  instanceId: input.instanceId,
  adapterId: input.adapterId,
  ...draftResultError(source, code),
  stale,
});

const mapHttpError = (error: ByokHttpError): ByokModelDiscoveryErrorCode =>
  error.code === "network" ? "upstream_http" : error.code;

const adaptersFromSettings = (
  settings: ServerSettingsContract,
  instanceId: string,
): ReadonlyArray<ByokModelAdapter> => {
  const instance =
    settings.providerInstances[instanceId as keyof typeof settings.providerInstances];
  if (instance?.driver !== "byok") return [];
  const config = instance.config;
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

const adapterFromSettings = (
  settings: ServerSettingsContract,
  input: Pick<ByokModelDiscoveryRequest, "instanceId" | "adapterId">,
): ByokModelAdapter | undefined =>
  adaptersFromSettings(settings, input.instanceId).find(
    (adapter) => adapter.id === input.adapterId,
  );

const sameRelayConnection = (left: ByokModelAdapter, right: ByokModelAdapter): boolean =>
  left.protocol === right.protocol &&
  left.baseURL.trim() === right.baseURL.trim() &&
  (left.groupName?.trim() ?? "") === (right.groupName?.trim() ?? "");

const emptyContextWindowMatch = (adapterId: string): ByokContextWindowMatchResult => ({
  adapterId,
  total: 0,
  fromCatalog: 0,
  fromProbe: 0,
  unchanged: 0,
  details: [],
});

const fingerprintFor = (adapter: ByokModelAdapter): string =>
  JSON.stringify([
    adapter.protocol,
    adapter.baseURL,
    adapter.supplierID ?? "",
    adapter.modelCatalogURL ?? "",
    adapter.modelCatalogURLs ?? [],
    adapter.modelCatalogStatus ?? "",
    adapter.appendModelCatalogCandidates ?? true,
  ]);

const targetFromAdapter = (adapter: ByokModelAdapter): ModelDiscoveryTarget => ({
  protocol: adapter.protocol,
  baseURL: adapter.baseURL,
  apiKey: adapter.apiKey,
  ...(adapter.supplierID ? { supplierID: adapter.supplierID } : {}),
  ...(adapter.modelCatalogURL ? { modelCatalogURL: adapter.modelCatalogURL } : {}),
  ...(adapter.modelCatalogURLs ? { modelCatalogURLs: adapter.modelCatalogURLs } : {}),
  ...(adapter.modelCatalogStatus ? { modelCatalogStatus: adapter.modelCatalogStatus } : {}),
  ...(adapter.appendModelCatalogCandidates !== undefined
    ? { appendModelCatalogCandidates: adapter.appendModelCatalogCandidates }
    : {}),
});

const targetFromDraft = (input: ByokDraftModelDiscoveryRequest): ModelDiscoveryTarget => ({
  protocol: input.protocol,
  baseURL: input.baseURL,
  apiKey: input.apiKey,
  ...(input.supplierID ? { supplierID: input.supplierID } : {}),
});

const publicModels = (models: ReturnType<typeof decodeModelCatalog>): ByokDiscoveredModel[] =>
  models.map((model) => ({
    id: model.id,
    ...(model.ownedBy ? { ownedBy: model.ownedBy } : {}),
    ...(model.contextWindowTokens ? { contextWindowTokens: model.contextWindowTokens } : {}),
    ...(model.pricing
      ? {
          pricing: {
            ...(model.pricing.input !== undefined ? { input: model.pricing.input } : {}),
            ...(model.pricing.output !== undefined ? { output: model.pricing.output } : {}),
            ...(model.pricing.cacheRead !== undefined
              ? { cacheRead: model.pricing.cacheRead }
              : {}),
            ...(model.pricing.cacheWrite !== undefined
              ? { cacheWrite: model.pricing.cacheWrite }
              : {}),
            ...(model.pricing.currency ? { currency: model.pricing.currency } : {}),
          },
        }
      : {}),
    ...(model.capabilities ? { capabilities: model.capabilities } : {}),
  }));

const discoverTarget = (target: ModelDiscoveryTarget) =>
  Effect.gen(function* () {
    if (target.apiKey.trim() === "") return draftResultError("draft", "missing_credentials");
    const template = supplierTemplate(target.supplierID);
    const status = target.modelCatalogStatus ?? template.modelCatalog.status;
    if (status === "manual_only") return draftResultError("manual", "unsupported_catalog");
    const candidateBuild = yield* Effect.try({
      try: () => ({
        status: "ready" as const,
        candidates: buildModelCatalogCandidates({
          type:
            target.protocol === "gemini"
              ? "gemini"
              : target.protocol === "anthropic"
                ? "anthropic"
                : template.type,
          baseURL: target.baseURL,
          ...(target.modelCatalogURL ? { modelCatalogURL: target.modelCatalogURL } : {}),
          modelCatalogURLs: [...(target.modelCatalogURLs ?? []), ...template.modelCatalog.urls],
          appendGeneratedCandidates:
            target.appendModelCatalogCandidates ?? template.modelCatalog.appendCandidates,
        }),
      }),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => ({ status: "invalid_endpoint" as const })));
    if (candidateBuild.status === "invalid_endpoint")
      return draftResultError("draft", "invalid_endpoint");
    const candidates = candidateBuild.candidates;
    if (candidates.length === 0) return draftResultError("manual", "unsupported_catalog");

    let lastError: ByokDraftModelDiscoveryResult | undefined;
    for (const candidate of candidates) {
      const response = yield* Effect.result(
        fetchByokCatalog({
          url: candidate,
          headers:
            target.protocol === "anthropic"
              ? { "x-api-key": target.apiKey, "anthropic-version": "2023-06-01" }
              : target.protocol === "gemini"
                ? { "x-goog-api-key": target.apiKey }
                : { authorization: `Bearer ${target.apiKey}` },
        }),
      );
      if (response._tag === "Failure") {
        lastError = draftResultError(new URL(candidate).origin, mapHttpError(response.failure));
        continue;
      }
      if (response.success.status < 200 || response.success.status >= 300) {
        lastError = draftResultError(new URL(candidate).origin, "upstream_http");
        continue;
      }
      const decoded = yield* Effect.result(
        Effect.sync(() =>
          filterModelCatalogByType(decodeModelCatalog(response.success.body), template.type),
        ),
      );
      if (decoded._tag === "Failure") {
        lastError = draftResultError(new URL(candidate).origin, "invalid_payload");
        continue;
      }
      const models = decoded.success;
      return {
        status: models.length > 0 ? "ready" : "empty",
        models: publicModels(models),
        source: new URL(candidate).origin,
        fetchedAt: DateTime.formatIso(yield* DateTime.now),
        ...(models.length === 0
          ? { error: { code: "no_models", message: errorMessage("no_models") } }
          : {}),
      } satisfies ByokDraftModelDiscoveryResult;
    }
    return lastError ?? draftResultError("catalog", "no_models");
  });

export interface ByokModelDiscoveryService {
  readonly discover: (
    input: ByokModelDiscoveryRequest,
  ) => Effect.Effect<
    ByokModelDiscoveryResult,
    never,
    HttpClient.HttpClient | ServerSettings.ServerSettingsService
  >;
  readonly matchContextWindows: (
    input: ByokContextWindowMatchRequest,
  ) => Effect.Effect<
    ByokContextWindowMatchResult,
    never,
    HttpClient.HttpClient | ServerSettings.ServerSettingsService
  >;
  readonly discoverDraft: (
    input: ByokDraftModelDiscoveryRequest,
  ) => Effect.Effect<ByokDraftModelDiscoveryResult, never, HttpClient.HttpClient>;
  readonly catalog: ReadonlyArray<ByokSupplierCatalogEntry>;
}

export const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const discover = (input: ByokModelDiscoveryRequest) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const adapter = adapterFromSettings(settings, input);
      if (!adapter) return resultError(input, "settings", "unsupported_catalog");
      if (adapter.apiKey.trim() === "")
        return resultError(input, "settings", "missing_credentials");
      const template = supplierTemplate(adapter.supplierID);
      const status = adapter.modelCatalogStatus ?? template.modelCatalog.status;
      if (status === "manual_only") return resultError(input, "manual", "unsupported_catalog");
      const fingerprint = fingerprintFor(adapter);
      const cacheKey = `${input.instanceId}:${input.adapterId}`;
      if (!input.forceRefresh) {
        const cached = yield* Ref.get(cacheRef).pipe(Effect.map((cache) => cache.get(cacheKey)));
        const now = yield* Clock.currentTimeMillis;
        if (cached && cached.fingerprint === fingerprint && cached.expiresAt > now) {
          return { ...cached.result, status: "cached" as const, stale: false };
        }
      }
      const draftResult = yield* discoverTarget(targetFromAdapter(adapter));
      const result: ByokModelDiscoveryResult = { ...input, ...draftResult, stale: false };
      if (result.status !== "failed") {
        const fetchedAtMillis = yield* Clock.currentTimeMillis;
        yield* Ref.update(cacheRef, (cache) =>
          new Map(cache).set(cacheKey, {
            fingerprint,
            result,
            expiresAt: fetchedAtMillis + CACHE_TTL_MS,
          }),
        );
        return result;
      }
      const cached = yield* Ref.get(cacheRef).pipe(Effect.map((cache) => cache.get(cacheKey)));
      return cached && cached.fingerprint === fingerprint
        ? { ...cached.result, status: "cached" as const, stale: true, error: result.error }
        : result;
    }).pipe(
      Effect.catch((error) => Effect.succeed(resultError(input, "service", "invalid_payload"))),
    );

  const discoverDraft = (input: ByokDraftModelDiscoveryRequest) =>
    discoverTarget(targetFromDraft(input));

  const matchContextWindowsForRelay = (input: ByokContextWindowMatchRequest) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const representative = adapterFromSettings(settings, input);
      if (!representative) return emptyContextWindowMatch(input.adapterId);

      const relayAdapters = adaptersFromSettings(settings, input.instanceId).filter((adapter) =>
        sameRelayConnection(adapter, representative),
      );
      const discovery = yield* discover({
        instanceId: input.instanceId,
        adapterId: representative.id,
        forceRefresh: true,
      });
      const summary = matchContextWindows(relayAdapters, discovery.models);
      return { adapterId: representative.id, ...summary } satisfies ByokContextWindowMatchResult;
    }).pipe(Effect.catch(() => Effect.succeed(emptyContextWindowMatch(input.adapterId))));

  return {
    discover,
    matchContextWindows: matchContextWindowsForRelay,
    discoverDraft,
    catalog: publicSupplierCatalog(),
  } satisfies ByokModelDiscoveryService;
});
