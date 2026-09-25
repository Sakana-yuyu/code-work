import { describe, expect, it } from "vite-plus/test";

import { publicSupplierCatalog, toPublicSupplierCatalogEntry } from "./SupplierCatalogTransport.ts";
import { supplierTemplate } from "./SupplierCatalog.ts";

describe("SupplierCatalogTransport", () => {
  it("projects only non-secret supplier metadata", () => {
    const entry = toPublicSupplierCatalogEntry(supplierTemplate("openrouter"));
    const serialized = JSON.stringify(entry).toLowerCase();
    expect(entry.apiKeyURL).toBe("https://openrouter.ai/keys");
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("cookie");
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("balanceaccesstoken");
    expect(serialized).not.toContain("balance");
    expect(entry.id).toBe("openrouter");
    expect(entry.models.length).toBeGreaterThan(0);
  });

  it("deduplicates and stably sorts the public catalog", () => {
    const catalog = publicSupplierCatalog();
    expect(new Set(catalog.map((entry) => entry.id)).size).toBe(catalog.length);
    expect(catalog.map((entry) => entry.label)).toEqual(
      [...catalog.map((entry) => entry.label)].sort((left, right) =>
        left.localeCompare(right, "zh-CN", { sensitivity: "base" }),
      ),
    );
  });

  it("publishes current DeepSeek presets with a 1M context window", () => {
    const entry = toPublicSupplierCatalogEntry(supplierTemplate("deepseek"));

    expect(entry.models).toEqual([
      {
        modelId: "deepseek-v4-flash",
        displayName: "deepseek-v4-flash",
        contextWindowTokens: 1_000_000,
      },
      {
        modelId: "deepseek-v4-pro",
        displayName: "deepseek-v4-pro",
        contextWindowTokens: 1_000_000,
      },
    ]);
  });

  it("公开目录将 Step Plan 与两个地区的开放平台 API 分开", () => {
    const entries = publicSupplierCatalog().filter((entry) => entry.id.startsWith("stepfun"));
    expect(entries.map((entry) => entry.id).sort()).toEqual([
      "stepfun",
      "stepfun_api",
      "stepfun_api_en",
      "stepfun_en",
    ]);
    expect(entries.find((entry) => entry.id === "stepfun")?.defaultBaseURL).toBe(
      "https://api.stepfun.com/step_plan",
    );
    expect(entries.find((entry) => entry.id === "stepfun_api")?.defaultBaseURL).toBe(
      "https://api.stepfun.com/v1",
    );
    expect(entries.find((entry) => entry.id === "stepfun_api_en")?.defaultBaseURL).toBe(
      "https://api.stepfun.ai/v1",
    );
  });
});
