import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedString } from "./baseSchemas.ts";

export const CursorByokProtocol = Schema.Literals(["openai", "anthropic", "gemini"]);
export type CursorByokProtocol = typeof CursorByokProtocol.Type;

export const CursorByokSecretValue = Schema.Struct({
  value: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  valueRedacted: Schema.optional(Schema.Boolean),
});
export type CursorByokSecretValue = typeof CursorByokSecretValue.Type;

export const CursorByokModelConfig = Schema.Struct({
  id: Schema.String,
  modelId: TrimmedString,
  displayName: TrimmedString,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  contextWindowTokens: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(128000))),
  maxOutputTokens: Schema.optional(Schema.Number),
  discovered: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type CursorByokModelConfig = typeof CursorByokModelConfig.Type;

export const CursorByokSupplierConfig = Schema.Struct({
  id: Schema.String,
  templateId: TrimmedString,
  displayName: TrimmedString,
  protocol: CursorByokProtocol,
  baseURL: TrimmedString,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  apiKey: CursorByokSecretValue,
  modelCatalogURL: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  customHeaders: CursorByokSecretValue.pipe(
    Schema.withDecodingDefault(Effect.succeed({ value: "" })),
  ),
  models: Schema.Array(CursorByokModelConfig).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type CursorByokSupplierConfig = typeof CursorByokSupplierConfig.Type;

export const CursorByokDriverConfig = Schema.Struct({
  schemaVersion: Schema.Literal(1).pipe(Schema.withDecodingDefault(Effect.succeed(1 as const))),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  suppliers: Schema.Array(CursorByokSupplierConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type CursorByokDriverConfig = typeof CursorByokDriverConfig.Type;

/** Legacy one-model-per-credential shape used before supplier migration. */
export const LegacyByokModelAdapter = Schema.Struct({
  id: Schema.String,
  displayName: TrimmedString,
  protocol: Schema.Literals(["openai", "anthropic"]),
  baseURL: TrimmedString,
  apiKey: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  apiKeyRedacted: Schema.optional(Schema.Boolean),
  modelId: TrimmedString,
  contextWindowTokens: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(128000))),
});
export type LegacyByokModelAdapter = typeof LegacyByokModelAdapter.Type;

export function migrateLegacyByokAdapters(
  adapters: ReadonlyArray<LegacyByokModelAdapter>,
): ReadonlyArray<CursorByokSupplierConfig> {
  const suppliers = new Map<string, CursorByokSupplierConfig>();
  for (const adapter of adapters) {
    const connectionKey = `${adapter.protocol}\u0000${adapter.baseURL}\u0000${adapter.apiKey}`;
    const existing = suppliers.get(connectionKey);
    const model: CursorByokModelConfig = {
      id: adapter.id,
      modelId: adapter.modelId,
      displayName: adapter.displayName,
      enabled: true,
      contextWindowTokens: adapter.contextWindowTokens,
      discovered: false,
    };
    if (existing) {
      suppliers.set(connectionKey, { ...existing, models: [...existing.models, model] });
      continue;
    }
    suppliers.set(connectionKey, {
      id: adapter.id,
      templateId: "custom",
      displayName: adapter.displayName,
      protocol: adapter.protocol,
      baseURL: adapter.baseURL,
      enabled: true,
      apiKey: {
        value: adapter.apiKey,
        ...(adapter.apiKeyRedacted ? { valueRedacted: true } : {}),
      },
      modelCatalogURL: "",
      customHeaders: { value: "" },
      models: [model],
    });
  }
  return [...suppliers.values()];
}
