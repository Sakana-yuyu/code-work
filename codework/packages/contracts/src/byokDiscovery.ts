import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

export const ByokDiscoveryProtocol = Schema.Literals(["openai", "anthropic", "gemini"]);
export type ByokDiscoveryProtocol = typeof ByokDiscoveryProtocol.Type;

export const ByokModelCatalogStatus = Schema.Literals([
  "openai_models",
  "gemini_models",
  "custom_url",
  "manual_only",
]);
export type ByokModelCatalogStatus = typeof ByokModelCatalogStatus.Type;

export const ByokModelPricing = Schema.Struct({
  input: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.Number),
  cacheRead: Schema.optional(Schema.Number),
  cacheWrite: Schema.optional(Schema.Number),
  currency: Schema.optional(TrimmedString),
});
export type ByokModelPricing = typeof ByokModelPricing.Type;

export const ByokSupplierModelPreset = Schema.Struct({
  modelId: TrimmedNonEmptyString,
  displayName: Schema.optional(TrimmedString),
  contextWindowTokens: Schema.optional(NonNegativeInt),
  pricing: Schema.optional(ByokModelPricing),
});
export type ByokSupplierModelPreset = typeof ByokSupplierModelPreset.Type;

export const ByokSupplierCatalogEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  protocol: ByokDiscoveryProtocol,
  defaultBaseURL: TrimmedString,
  allowCustomURL: Schema.Boolean,
  modelCatalogStatus: ByokModelCatalogStatus,
  modelCatalogURLs: Schema.Array(TrimmedNonEmptyString),
  appendGeneratedCandidates: Schema.Boolean,
  websiteURL: Schema.optional(TrimmedString),
  apiKeyURL: Schema.optional(TrimmedString),
  iconURL: Schema.optional(TrimmedString),
  iconLight: Schema.Boolean,
  models: Schema.Array(ByokSupplierModelPreset),
});
export type ByokSupplierCatalogEntry = typeof ByokSupplierCatalogEntry.Type;

export const ByokModelDiscoveryRequest = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  adapterId: TrimmedNonEmptyString,
  forceRefresh: Schema.optional(Schema.Boolean),
});
export type ByokModelDiscoveryRequest = typeof ByokModelDiscoveryRequest.Type;

/**
 * One-shot model discovery for an adapter that has not been saved yet.
 * The API key is request-only: it must never appear in the result, cache, or
 * persisted BYOK settings.
 */
export const ByokDraftModelDiscoveryRequest = Schema.Struct({
  protocol: ByokDiscoveryProtocol,
  baseURL: TrimmedNonEmptyString,
  apiKey: TrimmedNonEmptyString,
  supplierID: Schema.optional(TrimmedString),
});
export type ByokDraftModelDiscoveryRequest = typeof ByokDraftModelDiscoveryRequest.Type;

export const ByokDiscoveredModel = Schema.Struct({
  id: TrimmedNonEmptyString,
  ownedBy: Schema.optional(TrimmedString),
  contextWindowTokens: Schema.optional(NonNegativeInt),
  pricing: Schema.optional(ByokModelPricing),
  capabilities: Schema.optional(Schema.Record(TrimmedNonEmptyString, Schema.Unknown)),
});
export type ByokDiscoveredModel = typeof ByokDiscoveredModel.Type;

export const ByokModelDiscoveryStatus = Schema.Literals(["ready", "cached", "empty", "failed"]);
export type ByokModelDiscoveryStatus = typeof ByokModelDiscoveryStatus.Type;

export const ByokModelDiscoveryErrorCode = Schema.Literals([
  "missing_credentials",
  "unsupported_catalog",
  "invalid_endpoint",
  "timeout",
  "response_too_large",
  "redirect_blocked",
  "upstream_http",
  "invalid_payload",
  "no_models",
]);
export type ByokModelDiscoveryErrorCode = typeof ByokModelDiscoveryErrorCode.Type;

export const ByokModelDiscoveryError = Schema.Struct({
  code: ByokModelDiscoveryErrorCode,
  message: TrimmedNonEmptyString,
});
export type ByokModelDiscoveryError = typeof ByokModelDiscoveryError.Type;

export const ByokModelDiscoveryResult = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  adapterId: TrimmedNonEmptyString,
  status: ByokModelDiscoveryStatus,
  models: Schema.Array(ByokDiscoveredModel),
  source: TrimmedNonEmptyString,
  fetchedAt: Schema.optional(TrimmedNonEmptyString),
  stale: Schema.Boolean,
  error: Schema.optional(ByokModelDiscoveryError),
});
export type ByokModelDiscoveryResult = typeof ByokModelDiscoveryResult.Type;

/**
 * A context-window diagnosis never returns credentials. The server evaluates
 * saved relay settings and the client decides whether to persist the suggested
 * values through its normal settings update path.
 */
export const ByokContextWindowMatchRequest = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  /** A representative model adapter for the relay being diagnosed. */
  adapterId: TrimmedNonEmptyString,
});
export type ByokContextWindowMatchRequest = typeof ByokContextWindowMatchRequest.Type;

export const ByokContextWindowMatchSource = Schema.Literals(["catalog", "probe", "unchanged"]);
export type ByokContextWindowMatchSource = typeof ByokContextWindowMatchSource.Type;

export const ByokContextWindowMatchDetail = Schema.Struct({
  adapterId: TrimmedNonEmptyString,
  modelId: TrimmedNonEmptyString,
  source: ByokContextWindowMatchSource,
  before: NonNegativeInt,
  after: NonNegativeInt,
});
export type ByokContextWindowMatchDetail = typeof ByokContextWindowMatchDetail.Type;

export const ByokContextWindowMatchResult = Schema.Struct({
  adapterId: TrimmedNonEmptyString,
  total: NonNegativeInt,
  fromCatalog: NonNegativeInt,
  fromProbe: NonNegativeInt,
  unchanged: NonNegativeInt,
  details: Schema.Array(ByokContextWindowMatchDetail),
});
export type ByokContextWindowMatchResult = typeof ByokContextWindowMatchResult.Type;

/** Result shape for draft discovery. It deliberately has no adapter identity or cache state. */
export const ByokDraftModelDiscoveryResult = Schema.Struct({
  status: Schema.Literals(["ready", "empty", "failed"]),
  models: Schema.Array(ByokDiscoveredModel),
  source: TrimmedNonEmptyString,
  fetchedAt: Schema.optional(TrimmedNonEmptyString),
  error: Schema.optional(ByokModelDiscoveryError),
});
export type ByokDraftModelDiscoveryResult = typeof ByokDraftModelDiscoveryResult.Type;
