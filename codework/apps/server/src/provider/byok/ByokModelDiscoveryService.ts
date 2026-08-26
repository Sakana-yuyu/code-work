import type {
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
import { fetchByokCatalog } from "./byokHttp.ts";
import type { ByokHttpError } from "./byokHttp.ts";

interface CacheEntry {
  readonly fingerprint: string;
  readonly result: ByokModelDiscoveryResult;
  readonly expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const cacheRef = Effect.runSync(Ref.make(new Map<string, CacheEntry>()));

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

const resultError = (
  input: ByokModelDiscoveryRequest,
  source: string,
  code: ByokModelDiscoveryErrorCode,
  stale = false,
): ByokModelDiscoveryResult => ({
  instanceId: input.instanceId,
  adapterId: input.adapterId,
  status: "failed",
  models: [],
  source,
  stale,
  error: { code, message: errorMessage(code) },
});

const mapHttpError = (error: ByokHttpError): ByokModelDiscoveryErrorCode =>
  error.code === "network" ? "upstream_http" : error.code;

const adapterFromSettings = (
  settings: ServerSettingsContract,
  input: ByokModelDiscoveryRequest,
): ByokModelAdapter | undefined => {
  const instance =
    settings.providerInstances[input.instanceId as keyof typeof settings.providerInstances];
  if (instance?.driver !== "byok") return undefined;
  const config = instance.config;
  if (config === null || typeof config !== "object" || Array.isArray(config)) return undefined;
  const adapters = (config as Record<string, unknown>).adapters;
  if (!Array.isArray(adapters)) return undefined;
  const found = adapters.find(
    (adapter): adapter is ByokModelAdapter =>
      adapter !== null &&
      typeof adapter === "object" &&
      (adapter as Record<string, unknown>).id === input.adapterId,
  );
  return found;
};

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

export interface ByokModelDiscoveryService {
  readonly discover: (
    input: ByokModelDiscoveryRequest,
  ) => Effect.Effect<
    ByokModelDiscoveryResult,
    never,
    HttpClient.HttpClient | ServerSettings.ServerSettingsService
  >;
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
      const candidates = buildModelCatalogCandidates({
        type:
          adapter.protocol === "gemini"
            ? "gemini"
            : adapter.protocol === "anthropic"
              ? "anthropic"
              : template.type,
        baseURL: adapter.baseURL,
        ...(adapter.modelCatalogURL ? { modelCatalogURL: adapter.modelCatalogURL } : {}),
        modelCatalogURLs: [...(adapter.modelCatalogURLs ?? []), ...template.modelCatalog.urls],
        appendGeneratedCandidates:
          adapter.appendModelCatalogCandidates ?? template.modelCatalog.appendCandidates,
      });
      if (candidates.length === 0) return resultError(input, "manual", "unsupported_catalog");
      let lastError: ByokModelDiscoveryResult | undefined;
      for (const candidate of candidates) {
        const response = yield* Effect.result(
          fetchByokCatalog({
            url: candidate,
            headers:
              adapter.protocol === "anthropic"
                ? { "x-api-key": adapter.apiKey, "anthropic-version": "2023-06-01" }
                : adapter.protocol === "gemini"
                  ? { "x-goog-api-key": adapter.apiKey }
                  : { authorization: `Bearer ${adapter.apiKey}` },
          }),
        );
        if (response._tag === "Failure") {
          lastError = resultError(input, new URL(candidate).origin, mapHttpError(response.failure));
          continue;
        }
        if (response.success.status < 200 || response.success.status >= 300) {
          lastError = resultError(input, new URL(candidate).origin, "upstream_http");
          continue;
        }
        let models;
        const decoded = yield* Effect.result(
          Effect.sync(() =>
            filterModelCatalogByType(decodeModelCatalog(response.success.body), template.type),
          ),
        );
        if (decoded._tag === "Failure") {
          lastError = resultError(input, new URL(candidate).origin, "invalid_payload");
          continue;
        }
        models = decoded.success;
        const result: ByokModelDiscoveryResult = {
          instanceId: input.instanceId,
          adapterId: input.adapterId,
          status: models.length > 0 ? "ready" : "empty",
          models: publicModels(models),
          source: new URL(candidate).origin,
          fetchedAt: DateTime.formatIso(yield* DateTime.now),
          stale: false,
          ...(models.length === 0
            ? { error: { code: "no_models", message: errorMessage("no_models") } }
            : {}),
        };
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
        ? { ...cached.result, status: "cached" as const, stale: true, error: lastError?.error }
        : (lastError ?? resultError(input, "catalog", "no_models"));
    }).pipe(
      Effect.catch((error) => Effect.succeed(resultError(input, "service", "invalid_payload"))),
    );

  return {
    discover,
    catalog: publicSupplierCatalog(),
  } satisfies ByokModelDiscoveryService;
});
