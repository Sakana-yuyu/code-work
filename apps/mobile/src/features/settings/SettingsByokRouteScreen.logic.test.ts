import { describe, expect, it } from "vite-plus/test";

import {
  adapterFormFromAdapter,
  buildByokAdapter,
  createByokProviderInstance,
  normalizeByokInstanceId,
  readByokModelAdapters,
} from "./SettingsByokRouteScreen.logic";

describe("移动端 BYOK 设置逻辑", () => {
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

  it("拒绝不符合服务端实例 ID 规则的值并构造 BYOK 实例", () => {
    expect(normalizeByokInstanceId("-invalid")).toBeNull();
    expect(normalizeByokInstanceId("byok_main")).toBe("byok_main");
    expect(createByokProviderInstance("byok_main", "主模型")).toMatchObject({
      driver: "byok",
      displayName: "主模型",
      enabled: true,
    });
  });
});
