import { describe, expect, it } from "vite-plus/test";

import {
  buildModelCatalogCandidates,
  decodeModelCatalog,
  filterModelCatalogByType,
  matchModelContext,
  normalizeModelID,
} from "./ModelCatalog.ts";

describe("normalizeModelID", () => {
  it("normalizes provider prefixes, paths, case, spaces, and underscores", () => {
    expect(normalizeModelID(" models/Publisher/Claude_Sonnet 4 ")).toBe("claude-sonnet-4");
    expect(normalizeModelID("openai/gpt-5")).toBe("gpt-5");
    expect(normalizeModelID("models/gemini-2.5-pro")).toBe("gemini-2.5-pro");
  });
});

describe("buildModelCatalogCandidates", () => {
  it("keeps explicit URLs first, dedupes, then appends OpenAI-compatible fallbacks", () => {
    expect(
      buildModelCatalogCandidates({
        type: "anthropic",
        baseURL: "https://example.test/gateway/api/anthropic",
        modelCatalogURL: "https://catalog.test/models",
        modelCatalogURLs: [
          "https://catalog.test/models",
          "invalid",
          "https://backup.test/v1/models",
        ],
      }),
    ).toEqual([
      "https://catalog.test/models",
      "https://backup.test/v1/models",
      "https://example.test/gateway/api/anthropic/v1/models",
      "https://example.test/gateway/v1/models",
      "https://example.test/gateway/models",
    ]);
  });

  it("handles version suffixes and Gemini v1beta without duplicating them", () => {
    expect(buildModelCatalogCandidates({ type: "openai", baseURL: "https://api.test/v4" })).toEqual(
      ["https://api.test/v4/models", "https://api.test/v4/v1/models"],
    );
    expect(
      buildModelCatalogCandidates({ type: "gemini", baseURL: "https://google.test/v1beta" }),
    ).toEqual(["https://google.test/v1beta/models"]);
    expect(
      buildModelCatalogCandidates({ type: "gemini", baseURL: "https://proxy.test/gemini" }),
    ).toEqual(["https://proxy.test/gemini/v1beta/models"]);
  });
});

describe("decodeModelCatalog", () => {
  it("decodes aliases and metadata, strips Gemini prefixes, dedupes, and sorts", () => {
    expect(
      decodeModelCatalog({
        data: [
          "z-model",
          {
            name: "models/Gemini-2.5-Pro",
            type: "model",
            provider: "google",
            inputTokenLimit: 1_048_576,
            pricing: {
              prompt_price: 1.25,
              completion: 10,
              cache_read: 0,
              currency: "USD",
            },
            capabilities: { vision: true },
          },
          { id: "z-model", owned_by: "duplicate" },
          { model: "alpha", context_window_tokens: 128_000, input_price: 0.5 },
          { ignored: true },
        ],
      }),
    ).toEqual([
      {
        id: "alpha",
        contextWindowTokens: 128_000,
        pricing: { input: 0.5, known: true, source: "catalog" },
      },
      {
        id: "Gemini-2.5-Pro",
        object: "model",
        ownedBy: "google",
        contextWindowTokens: 1_048_576,
        pricing: {
          input: 1.25,
          output: 10,
          cacheRead: 0,
          currency: "USD",
          known: true,
          source: "catalog",
        },
        capabilities: { vision: true },
      },
      { id: "z-model", object: "model" },
    ]);
  });

  it("accepts models and items envelopes and rejects empty responses", () => {
    expect(decodeModelCatalog({ models: [{ id: "one" }] })).toEqual([{ id: "one" }]);
    expect(decodeModelCatalog({ items: ["two"] })).toEqual([{ id: "two", object: "model" }]);
    expect(() => decodeModelCatalog({ data: [{ nope: true }] })).toThrow(/no usable models/i);
    expect(() => decodeModelCatalog("{")).toThrow(/valid JSON/i);
  });
});

describe("filterModelCatalogByType", () => {
  const models = [
    { id: "claude", ownedBy: "anthropic" },
    { id: "proxy-unknown" },
    { id: "watermark", ownedBy: "openai" },
  ];

  it("filters non-Anthropic owners only for Anthropic adapters", () => {
    expect(filterModelCatalogByType(models, "anthropic").map(({ id }) => id)).toEqual([
      "claude",
      "proxy-unknown",
    ]);
    expect(filterModelCatalogByType(models, "openai")).toEqual(models);
  });

  it("falls back to the original list if every model would be removed", () => {
    const unlabelledProxy = [{ id: "gpt", ownedBy: "openai" }];
    expect(filterModelCatalogByType(unlabelledProxy, "anthropic")).toEqual(unlabelledProxy);
  });
});

describe("matchModelContext", () => {
  it("normalizes once and returns the first matching rule", () => {
    const result = matchModelContext("models/OpenAI/GPT_5 Pro", [
      { pattern: /^gpt-5/, value: { tokens: 400_000 } },
      { pattern: /pro$/, value: { tokens: 1 } },
    ]);
    expect(result).toEqual({
      covered: true,
      normalizedID: "gpt-5-pro",
      value: { tokens: 400_000 },
    });
  });

  it("reports normalized unknown and empty IDs without a match", () => {
    expect(matchModelContext(" Vendor/Unknown_Model ", [])).toEqual({
      covered: false,
      normalizedID: "unknown-model",
    });
    expect(matchModelContext(" ", [{ pattern: /.*/, value: true }])).toEqual({
      covered: false,
      normalizedID: "",
    });
  });
});
