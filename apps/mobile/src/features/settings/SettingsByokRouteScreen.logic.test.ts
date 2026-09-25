import { describe, expect, it } from "vite-plus/test";

import {
  adapterFormFromAdapter,
  byokBenchmarkFingerprint,
  buildByokAdapter,
  createByokProviderInstance,
  normalizeByokInstanceId,
  readByokModelAdapters,
  supplierSelectionPatch,
} from "./SettingsByokRouteScreen.logic";

describe("移动端 BYOK 设置逻辑", () => {
  it("切换供应商时要求重新选模型，自定义渠道不写供应商 ID", () => {
    expect(
      supplierSelectionPatch({
        id: "openrouter",
        protocol: "openai",
        defaultBaseURL: "https://openrouter.ai/api/v1",
      }),
    ).toMatchObject({
      supplierID: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      modelId: "",
      displayName: "",
      contextWindowTokens: "128000",
      maxOutputTokens: "",
      apiKey: "",
    });
    expect(
      supplierSelectionPatch({
        id: "custom",
        protocol: "openai",
        defaultBaseURL: "",
      }).supplierID,
    ).toBe("");
  });

  it("读取服务端脱敏适配器且不把密钥伪装成可读值", () => {
    const adapters = readByokModelAdapters({
      adapters: [
        {
          id: "adapter-1",
          displayName: "主模型",
          protocol: "openai",
          baseURL: "https://example.com/v1",
          apiKey: "",
          apiKeyRedacted: true,
          modelId: "model-a",
          contextWindowTokens: 64_000,
        },
      ],
    });

    expect(adapters).toHaveLength(1);
    expect(adapters[0]).toMatchObject({
      id: "adapter-1",
      apiKey: "",
      apiKeyRedacted: true,
      contextWindowTokens: 64_000,
    });
  });

  it("编辑时留空密钥会保留服务端密钥标记", () => {
    const existing = readByokModelAdapters({
      adapters: [
        {
          id: "adapter-1",
          displayName: "主模型",
          protocol: "openai",
          baseURL: "https://example.com/v1",
          apiKey: "",
          apiKeyRedacted: true,
          modelId: "model-a",
          contextWindowTokens: 128_000,
        },
      ],
    })[0]!;
    const next = buildByokAdapter(
      { ...adapterFormFromAdapter(existing), displayName: "新名称" },
      existing.id,
      existing,
    );

    expect(next.apiKey).toBe("");
    expect(next.apiKeyRedacted).toBe(true);
    expect(next.displayName).toBe("新名称");
  });

  it("切换供应商时清除旧凭据标记和旧目录元数据", () => {
    const existing = readByokModelAdapters({
      adapters: [
        {
          id: "adapter-switch",
          displayName: "旧供应商",
          supplierID: "deepseek",
          protocol: "openai",
          baseURL: "https://api.deepseek.com/v1",
          apiKey: "",
          apiKeyRedacted: true,
          apiKeySourceAdapterId: "old-source",
          modelId: "deepseek-chat",
          contextWindowTokens: 128_000,
          modelCatalogURL: "https://api.deepseek.com/models",
          modelCatalogURLs: ["https://api.deepseek.com/v1/models"],
          modelCatalogStatus: "openai_models",
          appendModelCatalogCandidates: false,
          balanceProfile: "newapi",
          balanceAccessToken: "",
          balanceAccessTokenRedacted: true,
          balanceUserID: "42",
          customHeaders: "",
          customHeadersRedacted: true,
        },
      ],
    })[0]!;
    const next = buildByokAdapter(
      {
        ...adapterFormFromAdapter(existing),
        ...supplierSelectionPatch({
          id: "openrouter",
          protocol: "openai",
          defaultBaseURL: "https://openrouter.ai/api/v1",
        }),
        apiKey: "sk-new-provider",
        modelId: "openai/gpt-4.1",
      },
      existing.id,
      existing,
    );

    expect(next).toMatchObject({
      supplierID: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: "sk-new-provider",
      modelId: "openai/gpt-4.1",
    });
    for (const key of [
      "apiKeyRedacted",
      "apiKeySourceAdapterId",
      "balanceAccessTokenRedacted",
      "customHeadersRedacted",
      "modelCatalogURL",
      "modelCatalogURLs",
      "modelCatalogStatus",
      "appendModelCatalogCandidates",
      "balanceProfile",
      "balanceUserID",
    ]) {
      expect(next).not.toHaveProperty(key);
    }
  });

  it("读取并保真目录回填的最大输出，且清空输入会移除覆盖值", () => {
    const existing = readByokModelAdapters({
      adapters: [
        {
          id: "adapter-1",
          displayName: "主模型",
          protocol: "openai",
          baseURL: "https://example.com/v1",
          apiKey: "",
          modelId: "claude-sonnet-4-6",
          contextWindowTokens: 1_000_000,
          maxOutputTokens: 64_000,
        },
      ],
    })[0]!;

    expect(existing.maxOutputTokens).toBe(64_000);
    // 表单回填后不改直接保存：值保真。
    const unchanged = buildByokAdapter(adapterFormFromAdapter(existing), existing.id, existing);
    expect(unchanged.maxOutputTokens).toBe(64_000);
    // 清空最大输出再保存：覆盖值被移除，交给协议层兜底。
    const cleared = buildByokAdapter(
      { ...adapterFormFromAdapter(existing), maxOutputTokens: "" },
      existing.id,
      existing,
    );
    expect(cleared.maxOutputTokens).toBeUndefined();
  });

  it("拒绝不符合服务端实例 ID 规则的值并构造 BYOK 实例", () => {
    expect(normalizeByokInstanceId("-invalid")).toBeNull();
    expect(normalizeByokInstanceId("byok_main")).toBe("byok_main");
    expect(createByokProviderInstance("byok_main", "主模型")).toMatchObject({
      driver: "byok",
      displayName: "主模型",
      enabled: true,
    });
  });

  it("测速指纹区分协议、地址和模型并忽略地址两端空格", () => {
    expect(
      byokBenchmarkFingerprint({
        protocol: "openai",
        baseURL: " https://example.com/v1 ",
        modelId: "model-a",
      }),
    ).toBe("openai\u0000https://example.com/v1\u0000model-a");
    expect(
      byokBenchmarkFingerprint({
        protocol: "openai",
        baseURL: "https://example.com/v1",
        modelId: "model-b",
      }),
    ).not.toBe(
      byokBenchmarkFingerprint({
        protocol: "openai",
        baseURL: "https://example.com/v1",
        modelId: "model-a",
      }),
    );
  });
});
