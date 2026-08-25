import type {
  ByokAdaptersImportRequest,
  ByokAdaptersImportResult,
  ByokModelAdapter,
  ServerSettings as ServerSettingsContract,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { parse as parseYaml } from "yaml";

import * as ServerSettings from "../../serverSettings.ts";

const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

interface CandidateAdapter {
  readonly displayName: string;
  readonly protocol: "openai" | "anthropic" | "gemini";
  readonly baseURL: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly contextWindowTokens: number;
  readonly supplierID?: string;
  readonly modelCatalogURL?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const cleanString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const parseProtocol = (type: unknown): "openai" | "anthropic" | "gemini" | null => {
  const value = cleanString(type).toLowerCase();
  if (value === "openai") return "openai";
  if (value === "anthropic" || value === "claude") return "anthropic";
  if (value === "gemini" || value === "google") return "gemini";
  return null;
};

/**
 * Parse a cursor-byok YAML export (`modelAdapters:` root key, or a bare list)
 * into candidate adapters. Malformed entries are skipped with a reason.
 * Gemini entries map to the native `gemini` protocol transport.
 */
export function parseAdaptersYaml(yamlText: string): {
  readonly candidates: readonly CandidateAdapter[];
  readonly skippedReasons: readonly string[];
} {
  let document: unknown;
  try {
    document = parseYaml(yamlText);
  } catch {
    return { candidates: [], skippedReasons: ["invalid_yaml"] };
  }
  const list = Array.isArray(document)
    ? document
    : isRecord(document) && Array.isArray(document["modelAdapters"])
      ? document["modelAdapters"]
      : isRecord(document) && Array.isArray(document["adapters"])
        ? document["adapters"]
        : null;
  if (list === null) {
    return { candidates: [], skippedReasons: ["missing_model_adapters"] };
  }

  const candidates: CandidateAdapter[] = [];
  const skippedReasons: string[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) {
      skippedReasons.push("skipped_malformed_entry");
      continue;
    }
    const protocol = parseProtocol(entry["type"] ?? entry["protocol"]);
    if (protocol === null) {
      skippedReasons.push(
        `skipped_unsupported_protocol:${cleanString(entry["type"] ?? entry["protocol"]) || "unknown"}`,
      );
      continue;
    }
    const displayName = cleanString(entry["displayName"] ?? entry["name"]);
    const baseURL =
      cleanString(entry["baseURL"]) ||
      (protocol === "gemini" ? "https://generativelanguage.googleapis.com/v1beta" : "");
    const modelId = cleanString(entry["modelID"] ?? entry["modelId"] ?? entry["model"]);
    if (!displayName || !baseURL || !modelId) {
      skippedReasons.push("skipped_missing_fields");
      continue;
    }
    const contextWindowRaw = entry["contextWindowTokens"];
    const contextWindowTokens =
      typeof contextWindowRaw === "number" &&
      Number.isFinite(contextWindowRaw) &&
      contextWindowRaw > 0
        ? contextWindowRaw
        : DEFAULT_CONTEXT_WINDOW_TOKENS;
    const supplierID = cleanString(entry["supplierID"]);
    const modelCatalogURL = cleanString(entry["modelCatalogURL"]);
    candidates.push({
      displayName,
      protocol,
      baseURL,
      apiKey: cleanString(entry["apiKey"]),
      modelId,
      contextWindowTokens,
      ...(supplierID ? { supplierID } : {}),
      ...(modelCatalogURL ? { modelCatalogURL } : {}),
    });
  }
  return { candidates, skippedReasons };
}

/**
 * Import adapters into settings. The write path in `serverSettings` moves any
 * non-empty `apiKey` straight into the secret store and persists only a
 * redacted shell, so imported keys never appear in the settings file, the
 * response, or logs.
 */
export const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const importAdapters = (
    input: ByokAdaptersImportRequest,
  ): Effect.Effect<ByokAdaptersImportResult> =>
    Effect.gen(function* () {
      const settings: ServerSettingsContract = yield* serverSettings.getSettings;
      const instance =
        settings.providerInstances[input.instanceId as keyof typeof settings.providerInstances];
      if (instance?.driver !== "byok") {
        return { imported: 0, skipped: 0, skippedReasons: ["instance_not_byok"], adapters: [] };
      }

      const { candidates, skippedReasons } = parseAdaptersYaml(input.yaml);
      if (candidates.length === 0) {
        return { imported: 0, skipped: 0, skippedReasons: [...skippedReasons], adapters: [] };
      }

      const config = isRecord(instance.config) ? instance.config : {};
      const existing = Array.isArray(config["adapters"])
        ? (config["adapters"] as ByokModelAdapter[])
        : [];
      const existingIds = new Set(existing.map((adapter) => adapter.id));

      const imported: ByokModelAdapter[] = [];
      for (const candidate of candidates) {
        let id = candidate.modelId;
        let suffix = 2;
        while (existingIds.has(id) || imported.some((adapter) => adapter.id === id)) {
          id = `${candidate.modelId}-${suffix}`;
          suffix += 1;
        }
        imported.push({
          id,
          displayName: candidate.displayName,
          protocol: candidate.protocol,
          baseURL: candidate.baseURL,
          apiKey: candidate.apiKey,
          ...(candidate.apiKey.length > 0 ? { apiKeyRedacted: true } : {}),
          balanceAccessToken: "",
          modelId: candidate.modelId,
          contextWindowTokens: candidate.contextWindowTokens,
          ...(candidate.supplierID ? { supplierID: candidate.supplierID } : {}),
          ...(candidate.modelCatalogURL ? { modelCatalogURL: candidate.modelCatalogURL } : {}),
        });
        existingIds.add(id);
      }

      const patch: ServerSettingsPatch = {
        providerInstances: {
          ...settings.providerInstances,
          [input.instanceId]: {
            ...instance,
            config: {
              ...config,
              adapters: [...existing, ...imported],
            },
          },
        } as typeof settings.providerInstances,
      };
      const patched = yield* Effect.result(serverSettings.updateSettings(patch));
      if (patched._tag === "Failure") {
        return {
          imported: 0,
          skipped: imported.length,
          skippedReasons: ["settings_write_failed"],
          adapters: [],
        };
      }

      return {
        imported: imported.length,
        skipped: skippedReasons.length,
        skippedReasons: [...skippedReasons],
        // Response shells are redacted: no apiKey field at all.
        adapters: imported.map((adapter) => ({
          id: adapter.id,
          displayName: adapter.displayName,
          protocol: adapter.protocol,
          baseURL: adapter.baseURL,
          modelId: adapter.modelId,
        })),
      };
    }).pipe(
      Effect.catch(() =>
        Effect.succeed<ByokAdaptersImportResult>({
          imported: 0,
          skipped: 0,
          skippedReasons: ["settings_read_failed"],
          adapters: [],
        }),
      ),
    );

  return { importAdapters };
});
