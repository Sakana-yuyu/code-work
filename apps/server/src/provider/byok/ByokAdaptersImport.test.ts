import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { ProviderDriverKind, ProviderInstanceId } from "@codework/contracts";

import * as ServerSettings from "../../serverSettings.ts";

import { make, parseAdaptersYaml } from "./ByokAdaptersImport.ts";

describe("parseAdaptersYaml", () => {
  it("parses a cursor-byok modelAdapters export", () => {
    const yaml = [
      "modelAdapters:",
      "  - displayName: DeepSeek Chat",
      "    type: openai",
      "    baseURL: https://api.deepseek.test/v1",
      "    apiKey: sk-import-secret",
      "    modelID: deepseek-chat",
      "    contextWindowTokens: 64000",
      "  - displayName: Claude",
      "    type: anthropic",
      "    baseURL: https://api.anthropic.test",
      "    apiKey: sk-ant-secret",
      "    modelID: claude-sonnet",
    ].join("\n");

    const { candidates, skippedReasons } = parseAdaptersYaml(yaml);

    expect(skippedReasons).toEqual([]);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      displayName: "DeepSeek Chat",
      protocol: "openai",
      baseURL: "https://api.deepseek.test/v1",
      apiKey: "sk-import-secret",
      modelId: "deepseek-chat",
      contextWindowTokens: 64000,
    });
    expect(candidates[1]).toMatchObject({
      protocol: "anthropic",
      modelId: "claude-sonnet",
    });
  });

  it("accepts a bare adapter list and the adapters root key", () => {
    const bare = [
      "- displayName: A",
      "  type: openai",
      "  baseURL: https://a.test",
      "  modelID: a-model",
    ].join("\n");
    const adaptersRoot = [
      "adapters:",
      "  - displayName: A",
      "    type: openai",
      "    baseURL: https://a.test",
      "    modelID: a-model",
    ].join("\n");

    expect(parseAdaptersYaml(bare).candidates).toHaveLength(1);
    expect(parseAdaptersYaml(adaptersRoot).candidates).toHaveLength(1);
  });

  it("imports native gemini adapters and defaults their base URL", () => {
    const yaml = [
      "modelAdapters:",
      "  - displayName: Gemini",
      "    type: gemini",
      "    modelID: gemini-2.5-pro",
      "  - displayName: Gemini Custom",
      "    type: google",
      "    baseURL: https://gemini-relay.test/v1beta",
      "    modelID: gemini-2.5-flash",
    ].join("\n");

    const { candidates, skippedReasons } = parseAdaptersYaml(yaml);

    expect(candidates).toHaveLength(2);
    expect(skippedReasons).toEqual([]);
    expect(candidates[0]).toMatchObject({
      protocol: "gemini",
      modelId: "gemini-2.5-pro",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
    });
    expect(candidates[1]).toMatchObject({
      protocol: "gemini",
      baseURL: "https://gemini-relay.test/v1beta",
    });
  });

  it("skips unknown protocols with explicit reasons", () => {
    const yaml = [
      "modelAdapters:",
      "  - displayName: Mystery",
      "    type: carrier-pigeon",
      "    baseURL: https://m.test",
      "    modelID: m",
    ].join("\n");

    const { candidates, skippedReasons } = parseAdaptersYaml(yaml);

    expect(candidates).toHaveLength(0);
    expect(
      skippedReasons.some((reason) => reason.startsWith("skipped_unsupported_protocol:")),
    ).toBe(true);
  });

  it("rejects malformed YAML and missing roots deterministically", () => {
    expect(parseAdaptersYaml(":\n  - [broken").skippedReasons).toEqual(["invalid_yaml"]);
    expect(parseAdaptersYaml("unrelated: true").skippedReasons).toEqual(["missing_model_adapters"]);
  });

  it("skips entries with missing required fields", () => {
    const yaml = [
      "modelAdapters:",
      "  - displayName: No Base URL",
      "    type: openai",
      "    modelID: m",
    ].join("\n");

    const { candidates, skippedReasons } = parseAdaptersYaml(yaml);

    expect(candidates).toHaveLength(0);
    expect(skippedReasons).toEqual(["skipped_missing_fields"]);
  });
});

describe("parseAdaptersYaml custom headers and max output", () => {
  it("imports enabled custom headers JSON and max output tokens", () => {
    const yaml = [
      "modelAdapters:",
      "  - displayName: Relay",
      "    type: openai",
      "    baseURL: https://relay.test/v1",
      "    modelID: m",
      "    maxOutputTokens: 64000",
      "    customHeadersEnabled: true",
      '    customHeadersJSON: \'{"X-Custom":"value"}\'',
    ].join("\n");

    const { candidates, skippedReasons } = parseAdaptersYaml(yaml);

    expect(skippedReasons).toEqual([]);
    expect(candidates[0]).toMatchObject({
      maxOutputTokens: 64000,
      customHeaders: '{"X-Custom":"value"}',
    });
  });

  it("drops custom headers when disabled or invalid", () => {
    const yaml = [
      "modelAdapters:",
      "  - displayName: Disabled",
      "    type: openai",
      "    baseURL: https://relay.test/v1",
      "    modelID: m",
      "    customHeadersEnabled: false",
      '    customHeadersJSON: {"X-Custom":"value"}',
      "  - displayName: Invalid",
      "    type: openai",
      "    baseURL: https://relay.test/v1",
      "    modelID: m2",
      "    customHeadersEnabled: true",
      "    customHeadersJSON: not-json",
      "  - displayName: NonString",
      "    type: openai",
      "    baseURL: https://relay.test/v1",
      "    modelID: m3",
      "    customHeadersEnabled: true",
      '    customHeadersJSON: {"n":1}',
    ].join("\n");

    const { candidates } = parseAdaptersYaml(yaml);

    expect(candidates[0]?.customHeaders).toBeUndefined();
    expect(candidates[1]?.customHeaders).toBeUndefined();
    expect(candidates[2]?.customHeaders).toBeUndefined();
  });
});

describe("importAdapters", () => {
  effectIt.effect(
    "stores the imported YAML key in settings without pre-marking it as redacted",
    () =>
      Effect.gen(function* () {
        const instanceId = "byok_yaml_import";
        const layer = ServerSettings.layerTest({
          providerInstances: {
            [ProviderInstanceId.make(instanceId)]: {
              driver: ProviderDriverKind.make("byok"),
              displayName: "Imported BYOK",
              enabled: true,
              config: { enabled: true, adapters: [] },
            },
          },
        } as never);
        const result = yield* Effect.gen(function* () {
          const service = yield* make;
          const imported = yield* service.importAdapters({
            instanceId,
            yaml: [
              "modelAdapters:",
              "  - displayName: DeepSeek Chat",
              "    type: openai",
              "    baseURL: https://api.deepseek.test/v1",
              "    apiKey: sk-import-secret",
              "    modelID: deepseek-chat",
            ].join("\n"),
          } as never);
          const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
          return { imported, settings };
        }).pipe(Effect.provide(layer));

        expect(result.imported.imported).toBe(1);
        const stored = (
          result.settings.providerInstances[ProviderInstanceId.make(instanceId)]?.config as
            | { adapters: ReadonlyArray<Record<string, unknown>> }
            | undefined
        )?.adapters[0];
        // 关键回归点：先打 apiKeyRedacted 标记会让真实写路径跳过入库并抹掉密钥。
        expect(stored?.apiKey).toBe("sk-import-secret");
        expect(stored?.apiKeyRedacted).toBeUndefined();
      }),
  );
});
