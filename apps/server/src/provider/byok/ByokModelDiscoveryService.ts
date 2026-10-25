// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalErrorInEffectFailure:off
import type {
  ByokCatalogModelLookupRequest,
  ByokCatalogModelLookupResult,
  ByokContextWindowMatchRequest,
  ByokContextWindowMatchResult,
  ByokDraftModelDiscoveryRequest,
  ByokDraftModelDiscoveryResult,
  ByokModelDiscoveryErrorCode,
  ByokModelDiscoveryResult,
  ByokModelDiscoveryRequest,
  ByokModelBenchmarkRequest,
  ByokModelBenchmarkResult,
  ByokSupplierCatalogEntry,
  ByokModelAdapter,
  ServerSettings as ServerSettingsContract,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/http";

import * as ServerSettings from "../../serverSettings.ts";
import { publicSupplierCatalog } from "./SupplierCatalogTransport.ts";
import { catalogCapabilitiesForModel } from "./ContextWindowCatalog.ts";
import { matchContextWindows } from "./ContextWindowMatcher.ts";
import { streamChat } from "../Layers/byokChatClient.ts";
import * as Stream from "effect/Stream";
import {
  ByokCatalog,
  byokCatalogFailure,
  byokCatalogTargetFromAdapter,
  type ByokCatalogTarget,
} from "./ByokCatalog.ts";

const BENCHMARK_TIMEOUT_MS = 45_000;
const BENCHMARK_OPENAI_MAX_OUTPUT_TOKENS = 4_096;
const BENCHMARK_ANTHROPIC_MAX_OUTPUT_TOKENS = 65_536;

const estimateBenchmarkTextTokens = (text: string): number =>
  Math.max(
    1,
    text.trim().split(/\s+/u).filter(Boolean).length +
      Math.round(text.replace(/\s+/gu, "").length / 8),
  );
const resultError = (
  input: ByokModelDiscoveryRequest,
  source: string,
  code: ByokModelDiscoveryErrorCode,
  stale = false,
): ByokModelDiscoveryResult => ({
  instanceId: input.instanceId,
  adapterId: input.adapterId,
  ...byokCatalogFailure(source, code),
  stale,
});

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

const targetFromDraft = (input: ByokDraftModelDiscoveryRequest): ByokCatalogTarget => ({
  protocol: input.protocol,
  baseURL: input.baseURL,
  apiKey: input.apiKey,
  ...(input.supplierID ? { supplierID: input.supplierID } : {}),
});

export interface ByokModelDiscoveryService {
  readonly benchmark: (
    input: ByokModelBenchmarkRequest,
  ) => Effect.Effect<
    ByokModelBenchmarkResult,
    never,
    HttpClient.HttpClient | ServerSettings.ServerSettingsService
  >;
  readonly discover: (input: ByokModelDiscoveryRequest) => Effect.Effect<ByokModelDiscoveryResult>;
  readonly matchContextWindows: (
    input: ByokContextWindowMatchRequest,
  ) => Effect.Effect<
    ByokContextWindowMatchResult,
    never,
    HttpClient.HttpClient | ServerSettings.ServerSettingsService
  >;
  readonly discoverDraft: (
    input: ByokDraftModelDiscoveryRequest,
  ) => Effect.Effect<ByokDraftModelDiscoveryResult>;
  readonly lookupCatalogModel: (
    input: ByokCatalogModelLookupRequest,
  ) => Effect.Effect<ByokCatalogModelLookupResult>;
  readonly catalog: ReadonlyArray<ByokSupplierCatalogEntry>;
}

export const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const catalog = yield* ByokCatalog;

  const discover = (input: ByokModelDiscoveryRequest) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const adapter = adapterFromSettings(settings, input);
      if (!adapter) return resultError(input, "settings", "unsupported_catalog");
      const { value, cached, previous } = yield* catalog.fetchCatalog(
        byokCatalogTargetFromAdapter(adapter),
        input.forceRefresh === undefined ? undefined : { forceRefresh: input.forceRefresh },
      );
      const identity = { instanceId: input.instanceId, adapterId: input.adapterId };
      if (value.status === "failed" && previous) {
        return {
          ...identity,
          ...previous,
          status: "cached" as const,
          stale: true,
          error: value.error,
        };
      }
      return {
        ...identity,
        ...value,
        status: cached ? ("cached" as const) : value.status,
        stale: false,
      };
    }).pipe(Effect.orElseSucceed(() => resultError(input, "service", "invalid_payload")));

  const benchmark = (input: ByokModelBenchmarkRequest) => {
    let resolvedModelId = input.adapterId;
    return Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const adapter = adapterFromSettings(settings, input);
      if (!adapter) throw new Error("模型适配器不存在");
      resolvedModelId = adapter.modelId;
      const started = Date.now();
      let firstToken = 0;
      let firstResponse = 0;
      let output = "";
      let measuredOutputTokens: number | undefined;
      yield* streamChat(yield* Effect.service(HttpClient.HttpClient), {
        protocol: adapter.protocol,
        baseURL: adapter.baseURL,
        apiKey: adapter.apiKey,
        modelId: adapter.modelId,
        ...(adapter.customHeaders !== undefined && adapter.customHeaders.trim().length > 0
          ? { customHeaders: adapter.customHeaders }
          : {}),
        messages: [
          {
            role: "user",
            content:
              "Output the numbers 1 through 120 separated by a single space. No commas, no newlines, no explanation.",
          },
        ],
        includeUsage: true,
        maxOutputTokens:
          adapter.protocol === "anthropic"
            ? BENCHMARK_ANTHROPIC_MAX_OUTPUT_TOKENS
            : BENCHMARK_OPENAI_MAX_OUTPUT_TOKENS,
        signal: AbortSignal.timeout(BENCHMARK_TIMEOUT_MS),
      }).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === "text" || event.type === "reasoning" || event.type === "tool_call") {
              if (firstResponse === 0) firstResponse = Date.now() - started;
            }
            if (event.type === "text") {
              if (firstToken === 0) firstToken = Date.now() - started;
              output += event.text;
            }
            if (event.type === "completed" && event.outputTokens !== undefined) {
              measuredOutputTokens = event.outputTokens;
            }
          }),
        ),
        Effect.mapError(() => new Error("模型测速请求失败")),
      );
      const totalMs = Math.max(1, Date.now() - started);
      // 上游没有 usage 时才退回本地估算；结果会显式标记，避免把估算冒充真实吞吐。
      const outputTokens = measuredOutputTokens ?? estimateBenchmarkTextTokens(output);
      const firstResponseMs = firstResponse || firstToken || totalMs;
      const generationMs = Math.max(1, totalMs - firstResponseMs);
      const tokensPerSecond = Math.round(((outputTokens * 1000) / generationMs) * 100) / 100;
      const visibleOutputTokens =
        output.trim().length > 0 ? estimateBenchmarkTextTokens(output) : 0;
      const visibleStartMs = firstToken || firstResponse || totalMs;
      const visibleGenerationMs = Math.max(1, totalMs - visibleStartMs);
      return {
        adapterId: input.adapterId,
        modelId: adapter.modelId,
        firstTokenMs: firstToken || totalMs,
        firstResponseMs,
        totalMs,
        outputTokens,
        tokensEstimated: measuredOutputTokens === undefined,
        tokensPerSecond,
        visibleTokensPerSecond:
          visibleOutputTokens === 0
            ? 0
            : Math.round(((visibleOutputTokens * 1000) / visibleGenerationMs) * 100) / 100,
      } satisfies ByokModelBenchmarkResult;
    }).pipe(
      Effect.orElseSucceed(() => ({
        adapterId: input.adapterId,
        modelId: resolvedModelId,
        error: "模型测速请求失败",
        firstTokenMs: 0,
        firstResponseMs: 0,
        totalMs: 0,
        outputTokens: 0,
        tokensEstimated: true,
        visibleTokensPerSecond: 0,
        tokensPerSecond: 0,
      })),
    );
  };

  const discoverDraft = (input: ByokDraftModelDiscoveryRequest) =>
    catalog.fetchCatalog(targetFromDraft(input)).pipe(Effect.map((result) => result.value));

  const lookupCatalogModel = (input: ByokCatalogModelLookupRequest) => {
    const capabilities = catalogCapabilitiesForModel(input.modelId);
    return Effect.succeed({
      ...(capabilities?.contextWindowTokens !== undefined
        ? { contextWindowTokens: capabilities.contextWindowTokens }
        : {}),
      ...(capabilities?.maxOutputTokens !== undefined
        ? { maxOutputTokens: capabilities.maxOutputTokens }
        : {}),
    });
  };

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
    }).pipe(Effect.orElseSucceed(() => emptyContextWindowMatch(input.adapterId)));

  return {
    discover,
    benchmark,
    matchContextWindows: matchContextWindowsForRelay,
    discoverDraft,
    lookupCatalogModel,
    catalog: publicSupplierCatalog(),
  } satisfies ByokModelDiscoveryService;
});
