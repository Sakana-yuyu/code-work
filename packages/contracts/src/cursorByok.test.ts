import { describe, expect, it } from "vite-plus/test";

import { migrateLegacyByokAdapters } from "./cursorByok.ts";

describe("cursor BYOK contracts", () => {
  it("groups legacy model adapters by connection while preserving model ids", () => {
    const suppliers = migrateLegacyByokAdapters([
      {
        id: "deepseek-chat",
        displayName: "DeepSeek Chat",
        protocol: "openai",
        baseURL: "https://api.deepseek.com/v1",
        apiKey: "sk-secret",
        modelId: "deepseek-chat",
        contextWindowTokens: 128000,
      },
      {
        id: "deepseek-reasoner",
        displayName: "DeepSeek Reasoner",
        protocol: "openai",
        baseURL: "https://api.deepseek.com/v1",
        apiKey: "sk-secret",
        modelId: "deepseek-reasoner",
        contextWindowTokens: 128000,
      },
    ]);

    expect(suppliers).toHaveLength(1);
    expect(suppliers[0]?.id).toBe("deepseek-chat");
    expect(suppliers[0]?.models.map((model) => model.id)).toEqual([
      "deepseek-chat",
      "deepseek-reasoner",
    ]);
  });

  it("does not merge connections that use different credentials", () => {
    const suppliers = migrateLegacyByokAdapters([
      {
        id: "first",
        displayName: "First",
        protocol: "openai",
        baseURL: "https://example.com/v1",
        apiKey: "sk-first",
        modelId: "model-a",
        contextWindowTokens: 32000,
      },
      {
        id: "second",
        displayName: "Second",
        protocol: "openai",
        baseURL: "https://example.com/v1",
        apiKey: "sk-second",
        modelId: "model-b",
        contextWindowTokens: 32000,
      },
    ]);

    expect(suppliers).toHaveLength(2);
  });
});
