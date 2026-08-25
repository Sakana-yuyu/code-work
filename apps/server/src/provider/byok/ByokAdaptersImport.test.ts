import { describe, expect, it } from "vite-plus/test";

import { parseAdaptersYaml } from "./ByokAdaptersImport.ts";

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
