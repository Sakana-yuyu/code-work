/**
 * ByokProvider — snapshot / health-check layer for the built-in BYOK engine.
 *
 * The engine is fully in-process TypeScript calling user-configured model
 * adapters (OpenAI- or Anthropic-compatible endpoints) directly, so there is
 * no gateway to probe and no binary to launch. The snapshot reflects the
 * configured adapters:
 *
 *   - disabled → warning "disabled in settings".
 *   - enabled with no adapters → warning prompting the user to add one.
 *   - enabled with adapters → available ("N model adapters configured").
 *
 * As a lightweight liveness probe, each `openai`-protocol adapter gets one
 * `GET ${baseURL}/models` call to validate its API key. Probe failures only
 * downgrade the snapshot message — they never mark the provider unavailable.
 *
 * @module provider/Layers/ByokProvider
 */
import type { ByokSettings, ModelCapabilities, ServerProviderModel } from "@codework/contracts";
import { createModelCapabilities } from "@codework/shared/model";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { decodeModelCatalog } from "../byok/ModelCatalog.ts";
import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";

const BYOK_PRESENTATION = {
  displayName: "Cursor BYOK",
  showInteractionModeToggle: false,
} as const;

export const EMPTY_BYOK_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const BYOK_KEY_PROBE_TIMEOUT_MS = 6_000;

const normalizedRelayURL = (baseURL: string): string => baseURL.trim().replace(/\/+$/u, "");

const relayKey = (adapter: ByokSettings["adapters"][number]): string =>
  `${adapter.protocol}\u0000${normalizedRelayURL(adapter.baseURL)}`;

const authenticatedRelayKey = (adapter: ByokSettings["adapters"][number]): string =>
  `${relayKey(adapter)}\u0000${adapter.apiKey}`;

// ── model snapshots ────────────────────────────────────────────────

/** Map configured model adapters to provider model entries (slug = adapter id). */
export function byokModelsFromSettings(
  byokSettings: ByokSettings,
  discoveredModels: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  const adapterModels = byokSettings.adapters.map((adapter) => ({
    slug: adapter.id,
    name: adapter.displayName.trim().length > 0 ? adapter.displayName : adapter.modelId,
    ...(adapter.modelId.trim().length > 0 ? { subProvider: adapter.modelId.trim() } : {}),
    isCustom: false,
    capabilities: EMPTY_BYOK_MODEL_CAPABILITIES,
  }));
  return [...adapterModels, ...discoveredModels];
}

export function buildInitialByokProviderSnapshot(
  byokSettings: ByokSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = byokModelsFromSettings(byokSettings);

    if (!byokSettings.enabled) {
      return buildServerProvider({
        presentation: BYOK_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Cursor BYOK is disabled in Code Work settings.",
        },
      });
    }

    if (byokSettings.adapters.length === 0) {
      return buildServerProvider({
        presentation: BYOK_PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "No model adapters are configured yet. Add one in Settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: BYOK_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated", type: "byok" },
        message: `${byokSettings.adapters.length} model adapter${
          byokSettings.adapters.length === 1 ? "" : "s"
        } configured.`,
      },
    });
  });
}

// ── health check ───────────────────────────────────────────────────

/**
 * One lightweight `GET ${baseURL}/models` probe against an OpenAI-compatible
 * adapter to validate its API key. Returns a failure detail string, or the
 * model ids advertised by the endpoint on success.
 */
const probeErrorDetail = (cause: unknown): string => {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return detail.trim().length > 0 ? detail : "The adapter probe request failed.";
};

const probeOpenaiAdapter = (
  httpClient: HttpClient.HttpClient,
  input: { readonly baseURL: string; readonly apiKey: string },
): Effect.Effect<ReadonlyArray<string>, string> =>
  Effect.gen(function* () {
    const url = `${input.baseURL.trim().replace(/\/+$/u, "")}/models`;
    const request = HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${input.apiKey}`),
    );
    const responseOption = yield* httpClient
      .execute(request)
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.mapError(probeErrorDetail),
        Effect.timeoutOption(BYOK_KEY_PROBE_TIMEOUT_MS),
      );
    if (Option.isNone(responseOption)) {
      return yield* Effect.fail(`Timed out after ${BYOK_KEY_PROBE_TIMEOUT_MS}ms.`);
    }
    const response = responseOption.value;
    const body: unknown = yield* HttpClientResponse.schemaBodyJson(Schema.Unknown)(response).pipe(
      Effect.mapError(probeErrorDetail),
    );
    return decodeModelCatalog(body).map((model) => model.id);
  });

export const checkByokProviderStatus = Effect.fn("checkByokProviderStatus")(function* (
  byokSettings: ByokSettings,
): Effect.fn.Return<ServerProviderDraft, never, HttpClient.HttpClient> {
  const httpClient = yield* HttpClient.HttpClient;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);

  if (!byokSettings.enabled) {
    return yield* buildInitialByokProviderSnapshot(byokSettings);
  }
  if (byokSettings.adapters.length === 0) {
    return yield* buildInitialByokProviderSnapshot(byokSettings);
  }

  // 同一中转的模型通道共用一次目录探测，避免重复请求和重复模型快照。
  const failures: Array<string> = [];
  const discoveredModels: ServerProviderModel[] = [];
  const configuredModelsByRelay = new Set(
    byokSettings.adapters.map((adapter) => `${relayKey(adapter)}\u0000${adapter.modelId.trim()}`),
  );
  const discoveredModelsByRelay = new Set<string>();
  const probedRelays = new Set<string>();
  for (const adapter of byokSettings.adapters) {
    if (adapter.protocol !== "openai" || adapter.baseURL.trim().length === 0) {
      continue;
    }
    const connectionKey = authenticatedRelayKey(adapter);
    if (probedRelays.has(connectionKey)) continue;
    probedRelays.add(connectionKey);

    const probeExit = yield* Effect.exit(
      probeOpenaiAdapter(httpClient, { baseURL: adapter.baseURL, apiKey: adapter.apiKey }),
    );
    if (probeExit._tag === "Failure") {
      const failure = Cause.squash(probeExit.cause);
      const detail = typeof failure === "string" ? failure : String(failure ?? "");
      failures.push(`${adapter.displayName}: ${detail}`);
    } else {
      for (const modelId of probeExit.value) {
        const normalizedModelId = modelId.trim();
        if (normalizedModelId.length === 0) continue;
        const modelRelayKey = `${relayKey(adapter)}\u0000${normalizedModelId}`;
        if (
          configuredModelsByRelay.has(modelRelayKey) ||
          discoveredModelsByRelay.has(modelRelayKey)
        ) {
          continue;
        }
        discoveredModelsByRelay.add(modelRelayKey);
        discoveredModels.push({
          slug: `${adapter.id}/${normalizedModelId}`,
          name: normalizedModelId,
          subProvider: adapter.displayName,
          isCustom: false,
          capabilities: EMPTY_BYOK_MODEL_CAPABILITIES,
        });
      }
    }
  }

  const models = byokModelsFromSettings(byokSettings, discoveredModels);
  return buildServerProvider({
    presentation: BYOK_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated", type: "byok" },
      message:
        failures.length > 0
          ? `${byokSettings.adapters.length} model adapter${
              byokSettings.adapters.length === 1 ? "" : "s"
            } configured. Key check failed for: ${failures.join("; ")}`
          : `${byokSettings.adapters.length} model adapter${
              byokSettings.adapters.length === 1 ? "" : "s"
            } configured.`,
    },
  });
});
