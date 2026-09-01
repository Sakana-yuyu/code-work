import { describe, expect, it } from "vite-plus/test";
import type { ByokModelAdapter } from "@codework/contracts";

import { hasCatalogContextWindow, matchContextWindows } from "./ContextWindowMatcher.ts";

const adapter = (overrides: Partial<ByokModelAdapter> = {}): ByokModelAdapter => ({
  id: "adapter-1",
  displayName: "Example model",
  protocol: "openai",
  baseURL: "https://relay.example.test/v1",
  apiKey: "sk-test-key",
  balanceAccessToken: "",
  modelId: "gpt-5.6-luna",
  contextWindowTokens: 1_000_000,
  ...overrides,
});

describe("ContextWindowMatcher", () => {
  it("uses the migrated catalog to correct overly large windows", () => {
    const result = matchContextWindows([adapter()]);

    expect(result).toMatchObject({
      total: 1,
      fromCatalog: 1,
      fromProbe: 0,
      unchanged: 0,
      details: [
        {
          adapterId: "adapter-1",
          modelId: "gpt-5.6-luna",
          source: "catalog",
          before: 1_000_000,
          after: 272_000,
        },
      ],
    });
  });

  it("converges a smaller stored window to the catalog value when explicitly matched", () => {
    const result = matchContextWindows([adapter({ contextWindowTokens: 200_000 })]);

    expect(result.details).toEqual([
      {
        adapterId: "adapter-1",
        modelId: "gpt-5.6-luna",
        source: "catalog",
        before: 200_000,
        after: 272_000,
      },
    ]);
    expect(result.fromCatalog).toBe(1);
    expect(result.unchanged).toBe(0);
  });

  it("corrects legacy DeepSeek aliases from 128K to 1M", () => {
    const result = matchContextWindows([
      adapter({ id: "deepseek-chat", modelId: "deepseek-chat", contextWindowTokens: 128_000 }),
      adapter({
        id: "deepseek-reasoner",
        modelId: "deepseek-reasoner",
        contextWindowTokens: 128_000,
      }),
    ]);

    expect(result).toMatchObject({
      fromCatalog: 2,
      unchanged: 0,
      details: [
        { adapterId: "deepseek-chat", source: "catalog", before: 128_000, after: 1_000_000 },
        {
          adapterId: "deepseek-reasoner",
          source: "catalog",
          before: 128_000,
          after: 1_000_000,
        },
      ],
    });
  });

  it("normalizes model ids before applying a relay catalog fallback", () => {
    const result = matchContextWindows(
      [adapter({ modelId: "models/Relay/Custom_Model", contextWindowTokens: 128_000 })],
      [{ id: "relay/custom-model", contextWindowTokens: 32_000 }],
    );

    expect(result.details).toEqual([
      {
        adapterId: "adapter-1",
        modelId: "models/Relay/Custom_Model",
        source: "probe",
        before: 128_000,
        after: 32_000,
      },
    ]);
    expect(result.fromProbe).toBe(1);
  });

  it("prefers an explicit relay context window over the built-in catalog", () => {
    const result = matchContextWindows(
      [adapter({ modelId: "deepseek-v3", contextWindowTokens: 128_000 })],
      [{ id: "deepseek-v3", contextWindowTokens: 1_000_000 }],
    );

    expect(result).toMatchObject({
      fromCatalog: 0,
      fromProbe: 1,
      unchanged: 0,
      details: [
        {
          adapterId: "adapter-1",
          modelId: "deepseek-v3",
          source: "probe",
          before: 128_000,
          after: 1_000_000,
        },
      ],
    });
  });

  it("keeps unknown models unchanged when the relay catalog has no window metadata", () => {
    const result = matchContextWindows(
      [adapter({ modelId: "private-model" })],
      [{ id: "private-model" }],
    );

    expect(result.fromCatalog).toBe(0);
    expect(result.fromProbe).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(result.details[0]?.source).toBe("unchanged");
  });

  it("distinguishes catalog-covered and provider-probe models", () => {
    expect(hasCatalogContextWindow("deepseek-chat")).toBe(true);
    expect(hasCatalogContextWindow("deepseek-v4-flash")).toBe(true);
    expect(hasCatalogContextWindow("private-model")).toBe(false);
  });
});
