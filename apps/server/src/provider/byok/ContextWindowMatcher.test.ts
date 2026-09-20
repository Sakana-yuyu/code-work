import { describe, expect, it } from "vite-plus/test";
import type { ByokModelAdapter } from "@codework/contracts";

import { hasCatalogContextWindow, matchContextWindows } from "./ContextWindowMatcher.ts";
import { catalogCapabilitiesForModel } from "./ContextWindowCatalog.ts";

const adapter = (overrides: Partial<ByokModelAdapter> = {}): ByokModelAdapter => ({
  id: "adapter-1",
  displayName: "Example model",
  protocol: "openai",
  baseURL: "https://relay.example.test/v1",
  apiKey: "sk-test-key",
  balanceAccessToken: "",
  customHeaders: "",
  modelId: "gpt-5.6-luna",
  contextWindowTokens: 1_000_000,
  ...overrides,
});

describe("ContextWindowMatcher", () => {
  it("uses the migrated catalog to correct overly large windows and backfills max output", () => {
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
          maxOutputAfter: 32_768,
        },
      ],
    });
  });

  it("preserves a smaller stored window but still backfills max output (fill-if-missing)", () => {
    const result = matchContextWindows([adapter({ contextWindowTokens: 200_000 })]);

    expect(result.details).toEqual([
      {
        adapterId: "adapter-1",
        modelId: "gpt-5.6-luna",
        source: "catalog",
        before: 200_000,
        after: 200_000,
        maxOutputAfter: 32_768,
      },
    ]);
    expect(result.fromCatalog).toBe(1);
    expect(result.unchanged).toBe(0);
  });

  it("never overwrites an explicitly configured max output", () => {
    const result = matchContextWindows([adapter({ maxOutputTokens: 4_096 })]);

    expect(result.details[0]).toMatchObject({
      source: "catalog",
      before: 1_000_000,
      after: 272_000,
      maxOutputBefore: 4_096,
    });
    expect(result.details[0]?.maxOutputAfter).toBeUndefined();
  });

  it("does not shrink a DeepSeek window below the dedicated alias rule", () => {
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
        {
          adapterId: "deepseek-chat",
          source: "catalog",
          before: 128_000,
          after: 128_000,
          maxOutputAfter: 384_000,
        },
        {
          adapterId: "deepseek-reasoner",
          source: "catalog",
          before: 128_000,
          after: 128_000,
          maxOutputAfter: 384_000,
        },
      ],
    });
  });

  it("covers the freshly synced GLM-5.3 family", () => {
    const result = matchContextWindows([
      adapter({ modelId: "glm-5.3-flash", contextWindowTokens: 128_000 }),
    ]);

    expect(result.details[0]).toMatchObject({
      source: "catalog",
      before: 128_000,
      after: 128_000,
    });
    expect(result.details[0]?.maxOutputAfter).toBe(128_000);
    expect(result.unchanged).toBe(0);
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
          maxOutputAfter: 8_192,
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
    expect(hasCatalogContextWindow("deepseek-flash")).toBe(true);
    expect(hasCatalogContextWindow("glm-5.3")).toBe(true);
    expect(hasCatalogContextWindow("private-model")).toBe(false);
  });

  it("resolves the deepseek-flash relay alias to V4.1-Flash specs", () => {
    const result = matchContextWindows([
      adapter({ modelId: "deepseek-flash", contextWindowTokens: 2_000_000 }),
    ]);

    expect(result.details[0]).toMatchObject({
      modelId: "deepseek-flash",
      source: "catalog",
      before: 2_000_000,
      after: 1_000_000,
      maxOutputAfter: 384_000,
    });
  });

  it("falls back to V3-era floors instead of pre-2025 specs for unknown deepseek names", () => {
    const result = matchContextWindows([
      adapter({ modelId: "deepseek-custom-thing", contextWindowTokens: 256_000 }),
    ]);

    expect(result.details[0]).toMatchObject({
      modelId: "deepseek-custom-thing",
      source: "catalog",
      before: 256_000,
      after: 128_000,
      maxOutputAfter: 8_192,
    });
  });

  // 2026-09 官方口径：V4 系列 384K 输出，V4-Flash 已并入 V4.1-Flash（获得视觉）。
  it("brings deepseek v4-pro and retired v4-flash ids to the official 384K output", () => {
    const result = matchContextWindows([
      adapter({ modelId: "deepseek-v4-pro", contextWindowTokens: 2_000_000 }),
      adapter({ modelId: "deepseek-v4-flash", contextWindowTokens: 2_000_000 }),
    ]);

    expect(result.details[0]).toMatchObject({
      modelId: "deepseek-v4-pro",
      after: 1_000_000,
      maxOutputAfter: 384_000,
    });
    expect(result.details[1]).toMatchObject({
      modelId: "deepseek-v4-flash",
      after: 1_000_000,
      maxOutputAfter: 384_000,
    });
    expect(catalogCapabilitiesForModel("deepseek-v4-flash")?.supportsVision).toBe(true);
    expect(catalogCapabilitiesForModel("deepseek-v4-pro")?.supportsVision).toBe(false);
  });
});
