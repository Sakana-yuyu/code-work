import type {
  ByokDraftModelDiscoveryResult,
  ByokDiscoveredModel,
  ByokModelDiscoveryErrorCode,
  ByokModelAdapter,
} from "@codework/contracts";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import {
  makeProviderCatalogCache,
  ProviderCatalogForceRefresh,
  type ProviderCatalogResult,
} from "../ProviderCatalogCache.ts";
import { parseByokCustomHeaders } from "../Layers/byokChatClient.ts";
import {
  buildModelCatalogCandidates,
  decodeModelCatalog,
  filterModelCatalogByType,
} from "./ModelCatalog.ts";
import { SUPPLIER_TEMPLATES, supplierTemplate } from "./SupplierCatalog.ts";
import { catalogCapabilitiesForModel } from "./ContextWindowCatalog.ts";
import {
  BYOK_HTTP_TIMEOUT_MS,
  fetchByokCatalog,
  withByokCatalogHttpScope,
  type ByokHttpError,
} from "./byokHttp.ts";

const knownTemplateCatalogURLs = new Set(
  SUPPLIER_TEMPLATES.flatMap((template) => template.modelCatalog.urls),
);

export type ByokCatalogTarget = Pick<
  ByokModelAdapter,
  | "protocol"
  | "baseURL"
  | "apiKey"
  | "supplierID"
  | "modelCatalogURL"
  | "modelCatalogURLs"
  | "modelCatalogStatus"
  | "appendModelCatalogCandidates"
> & {
  readonly customHeaders?: string;
};

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

export const byokCatalogFailure = (
  source: string,
  code: ByokModelDiscoveryErrorCode,
): ByokDraftModelDiscoveryResult => ({
  status: "failed",
  models: [],
  source,
  error: { code, message: errorMessage(code) },
});

const mapHttpError = (error: ByokHttpError): ByokModelDiscoveryErrorCode =>
  error.code === "network" ? "upstream_http" : error.code;

export const byokCatalogTargetFromAdapter = (adapter: ByokModelAdapter): ByokCatalogTarget => ({
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
  ...(adapter.customHeaders !== undefined && adapter.customHeaders.trim().length > 0
    ? { customHeaders: adapter.customHeaders }
    : {}),
});

/** 索引只用于共享目录结果；实际请求始终保留本次传入的地址、凭据和候选顺序。 */
export const byokCatalogIdentity = (target: ByokCatalogTarget): string => {
  const template = supplierTemplate(target.supplierID);
  return NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        target.protocol,
        target.baseURL,
        target.supplierID ?? "",
        target.modelCatalogURL ?? "",
        target.modelCatalogURLs ?? [],
        target.modelCatalogStatus ?? template.modelCatalog.status,
        target.appendModelCatalogCandidates ?? template.modelCatalog.appendCandidates,
        target.apiKey,
        target.customHeaders ?? "",
      ]),
    )
    .digest("hex");
};

const publicModels = (models: ReturnType<typeof decodeModelCatalog>): ByokDiscoveredModel[] =>
  models.map((model) => {
    // 中转 /models 普遍不报窗口/输出上限：缺什么就用内置目录补什么，
    // 让新加的模型直接带上正确的上下文元数据，而不是落到 128K 默认值。
    const catalog = catalogCapabilitiesForModel(model.id);
    const contextWindowTokens = model.contextWindowTokens ?? catalog?.contextWindowTokens;
    const maxOutputTokens = catalog?.maxOutputTokens;
    return {
      id: model.id,
      ...(model.ownedBy ? { ownedBy: model.ownedBy } : {}),
      ...(contextWindowTokens ? { contextWindowTokens } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
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
    };
  });

const discoverTarget = (target: ByokCatalogTarget) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + BYOK_HTTP_TIMEOUT_MS;
    if (target.apiKey.trim() === "") return byokCatalogFailure("draft", "missing_credentials");
    const template = supplierTemplate(target.supplierID);
    const status = target.modelCatalogStatus ?? template.modelCatalog.status;
    if (status === "manual_only") return byokCatalogFailure("manual", "unsupported_catalog");
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
          // 模板目录只允许使用当前推理地址的 origin；旧供应商残留的模板地址也不能接收新密钥。
          modelCatalogURLs: [...(target.modelCatalogURLs ?? []), ...template.modelCatalog.urls]
            .filter((url) => {
              try {
                return new URL(url).origin === new URL(target.baseURL).origin;
              } catch {
                return false;
              }
            })
            .filter(
              (url) =>
                !knownTemplateCatalogURLs.has(url) || template.modelCatalog.urls.includes(url),
            ),
          appendGeneratedCandidates:
            target.appendModelCatalogCandidates ?? template.modelCatalog.appendCandidates,
        }),
      }),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => ({ status: "invalid_endpoint" as const })));
    if (candidateBuild.status === "invalid_endpoint")
      return byokCatalogFailure("draft", "invalid_endpoint");
    const candidates = candidateBuild.candidates;
    if (candidates.length === 0) return byokCatalogFailure("manual", "unsupported_catalog");

    let lastError: ByokDraftModelDiscoveryResult | undefined;
    // 通道级自定义请求头与协议默认头合并（自定义头可覆盖）。
    const customHeaderValues = parseByokCustomHeaders(target.customHeaders);
    const discoveryHeaders = {
      ...(target.protocol === "anthropic"
        ? { "x-api-key": target.apiKey, "anthropic-version": "2023-06-01" }
        : target.protocol === "gemini"
          ? { "x-goog-api-key": target.apiKey }
          : { authorization: `Bearer ${target.apiKey}` }),
      ...customHeaderValues,
    };
    for (const candidate of candidates) {
      const remainingMs = deadline - (yield* Clock.currentTimeMillis);
      if (remainingMs <= 0) return byokCatalogFailure("catalog", "timeout");
      const response = yield* Effect.result(
        fetchByokCatalog({
          url: candidate,
          headers: discoveryHeaders,
          timeoutMs: remainingMs,
        }),
      );
      if (response._tag === "Failure") {
        lastError = byokCatalogFailure(new URL(candidate).origin, mapHttpError(response.failure));
        if (response.failure.code === "timeout") return lastError;
        continue;
      }
      if (response.success.status < 200 || response.success.status >= 300) {
        lastError = byokCatalogFailure(new URL(candidate).origin, "upstream_http");
        continue;
      }
      const decoded = yield* Effect.result(
        Effect.try({
          try: () =>
            filterModelCatalogByType(decodeModelCatalog(response.success.body), template.type),
          catch: () => undefined,
        }),
      );
      if (decoded._tag === "Failure") {
        lastError = byokCatalogFailure(new URL(candidate).origin, "invalid_payload");
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
    return lastError ?? byokCatalogFailure("catalog", "no_models");
  }).pipe(
    withByokCatalogHttpScope,
    // 整轮预算包含候选、重定向和正文读取；子请求不能各自重置十五秒。
    Effect.timeoutOption(BYOK_HTTP_TIMEOUT_MS),
    Effect.map(Option.getOrElse(() => byokCatalogFailure("catalog", "timeout"))),
  );

export class ByokCatalog extends Context.Service<
  ByokCatalog,
  {
    readonly fetchCatalog: (
      target: ByokCatalogTarget,
      options?: { readonly forceRefresh?: boolean; readonly timeoutMs?: number },
    ) => Effect.Effect<ProviderCatalogResult<ByokDraftModelDiscoveryResult>>;
  }
>()("codework/provider/byok/ByokCatalog") {}

export const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const cache = yield* makeProviderCatalogCache<ByokDraftModelDiscoveryResult>({
    ttlMs: 60_000,
    capacity: 128,
    shouldCache: (value) => value.status !== "failed",
  });
  const fetchCatalog = Effect.fn("ByokCatalog.fetchCatalog")(function* (
    target: ByokCatalogTarget,
    options?: { readonly forceRefresh?: boolean; readonly timeoutMs?: number },
  ) {
    const forceRefresh = options?.forceRefresh ?? (yield* ProviderCatalogForceRefresh);
    return yield* cache.fetchCatalog({
      key: byokCatalogIdentity(target),
      load: discoverTarget(target).pipe(Effect.provideService(HttpClient.HttpClient, client)),
      forceRefresh,
      ...(options?.timeoutMs !== undefined
        ? {
            timeout: {
              milliseconds: options.timeoutMs,
              onTimeout: () => byokCatalogFailure("catalog", "timeout"),
            },
          }
        : {}),
    });
  });
  return { fetchCatalog };
});

export const layer = Layer.effect(ByokCatalog, make);
