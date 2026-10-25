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
          maxOutputAfter: 128_000,
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
        maxOutputAfter: 128_000,
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

  // 2026-10 官方阵容：Opus 5.5/Sonnet 5.5/Haiku 5.5 均 1M/128K；5.5 规则
  // 必须压在 Sonnet 5（64K 输出）与 Opus 5 规则之前。保存后的匹配只收敛
  // 不抬升，窗口识别值由 catalogCapabilitiesForModel 直接核对。
  it("covers the 2026-10 Anthropic lineup (Opus/Sonnet/Haiku 5.5, Opus 5)", () => {
    const result = matchContextWindows([
      adapter({ modelId: "claude-opus-5-5", contextWindowTokens: 128_000 }),
      adapter({ modelId: "claude-sonnet-5-5", contextWindowTokens: 128_000 }),
      adapter({ modelId: "claude-haiku-5-5", contextWindowTokens: 2_000_000 }),
      adapter({ modelId: "claude-opus-5", contextWindowTokens: 128_000 }),
    ]);

    expect(result.details[0]).toMatchObject({
      modelId: "claude-opus-5-5",
      source: "catalog",
      maxOutputAfter: 128_000,
    });
    expect(result.details[1]).toMatchObject({
      modelId: "claude-sonnet-5-5",
      maxOutputAfter: 128_000,
    });
    // 过大窗口仍会被收敛到目录口径。
    expect(result.details[2]).toMatchObject({
      modelId: "claude-haiku-5-5",
      before: 2_000_000,
      after: 1_000_000,
      maxOutputAfter: 128_000,
    });
    expect(result.details[3]).toMatchObject({
      modelId: "claude-opus-5",
      maxOutputAfter: 128_000,
    });
    expect(catalogCapabilitiesForModel("claude-opus-5-5")).toMatchObject({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 128_000,
    });
    expect(catalogCapabilitiesForModel("claude-sonnet-5-5")).toMatchObject({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 128_000,
    });
    expect(catalogCapabilitiesForModel("claude-haiku-5-5")).toMatchObject({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 128_000,
    });
    expect(catalogCapabilitiesForModel("claude-opus-5")).toMatchObject({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 128_000,
    });
    expect(catalogCapabilitiesForModel("claude-opus-5-5")?.reasoningEfforts).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(catalogCapabilitiesForModel("claude-haiku-5-5")?.reasoningEfforts).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(catalogCapabilitiesForModel("claude-sonnet-5-5")?.reasoningEfforts).toBeUndefined();
    expect(hasCatalogContextWindow("claude-haiku-5-5")).toBe(true);
  });

  // platform.kimi.com 快速开始：K3 上下文 1M、默认最大输出 131072。
  it("corrects the Kimi K3 catalog to the official 1M context", () => {
    const result = matchContextWindows([
      adapter({ modelId: "kimi-k3", contextWindowTokens: 2_000_000 }),
      adapter({ modelId: "kimi-k3-thinking", contextWindowTokens: 256_000 }),
    ]);

    // 过大窗口收敛到 1M；更小的显式窗口保持，仅回填最大输出。
    expect(result.details[0]).toMatchObject({
      modelId: "kimi-k3",
      source: "catalog",
      before: 2_000_000,
      after: 1_000_000,
      maxOutputAfter: 131_072,
    });
    expect(result.details[1]).toMatchObject({
      modelId: "kimi-k3-thinking",
      before: 256_000,
      after: 256_000,
      maxOutputAfter: 131_072,
    });
    expect(catalogCapabilitiesForModel("kimi-k3")?.contextWindowTokens).toBe(1_000_000);
    expect(catalogCapabilitiesForModel("kimi-k3")?.supportsVision).toBe(true);
  });

  // 2026-10-09 官方核对：MiniMax M3 原生多模态（目录曾错标纯文本）、
  // M2.7 系窗口 204800（曾错写 1M）；阶跃 Step 5 Preview 1M/视觉，
  // free 变体 200K/32K 且必须排在通用 ^step-5 规则之前。
  it("covers the corrected MiniMax lineup and the StepFun 5/3.7/3.5 flash family", () => {
    expect(catalogCapabilitiesForModel("MiniMax-M3.1-Flash-Preview")).toMatchObject({
      contextWindowTokens: 1_000_000,
      supportsVision: true,
    });
    expect(catalogCapabilitiesForModel("minimax-m3")).toMatchObject({
      supportsVision: true,
    });
    expect(catalogCapabilitiesForModel("minimax-m2.7-highspeed")).toMatchObject({
      contextWindowTokens: 204_800,
      supportsVision: false,
    });
    // 存量用户按旧目录存了 1M 的 M2.7 会被收敛回官方口径。
    const minimax = matchContextWindows([
      adapter({ modelId: "MiniMax-M2.7", contextWindowTokens: 1_000_000 }),
    ]);
    expect(minimax.details[0]).toMatchObject({
      modelId: "MiniMax-M2.7",
      source: "catalog",
      before: 1_000_000,
      after: 204_800,
    });

    expect(catalogCapabilitiesForModel("step-5-preview")).toMatchObject({
      contextWindowTokens: 1_000_000,
      supportsVision: true,
    });
    expect(catalogCapabilitiesForModel("step-5-preview-free")).toMatchObject({
      contextWindowTokens: 200_000,
      maxOutputTokens: 32_768,
      supportsVision: true,
    });
    expect(catalogCapabilitiesForModel("step-3.7-flash")).toMatchObject({
      contextWindowTokens: 256_000,
      supportsVision: true,
    });
    expect(catalogCapabilitiesForModel("step-3.5-flash-2603")).toMatchObject({
      contextWindowTokens: 256_000,
      supportsVision: false,
    });
    expect(hasCatalogContextWindow("step-5-preview")).toBe(true);
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
