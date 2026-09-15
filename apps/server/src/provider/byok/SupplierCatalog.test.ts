import { describe, expect, it } from "vite-plus/test";

import {
  SUPPLIER_TEMPLATES,
  createTemplate,
  supplierModelCatalog,
  supplierSelectOptions,
  supplierTemplate,
  supplierUsageRequest,
  supplierUsageStatus,
} from "./SupplierCatalog.ts";

describe("SupplierCatalog", () => {
  it("normalizes template defaults", () => {
    const template = createTemplate({
      id: "  EXAMPLE  ",
      type: "openai",
      baseURL: "  https://example.com/v1  ",
      modelCatalogURLs: ["https://example.com/v1/models", "", null],
    });

    expect(template).toMatchObject({
      id: "example",
      supplierID: "example",
      label: "example",
      type: "openai",
      baseURL: "https://example.com/v1",
      endpoint: "/v1/chat/completions",
      requestGroup: "chat_completions",
      modelCatalog: {
        status: "openai_models",
        urls: ["https://example.com/v1/models"],
        appendCandidates: true,
      },
      usage: { status: "none", provider: "" },
    });
  });

  it("includes core suppliers and the complete source catalog", () => {
    expect(SUPPLIER_TEMPLATES).toHaveLength(73);
    expect(SUPPLIER_TEMPLATES.slice(0, 3).map(({ id }) => id)).toEqual([
      "custom",
      "openai",
      "anthropic",
    ]);
    expect(supplierTemplate("gemini")).toMatchObject({
      type: "gemini",
      requestGroup: "gemini_native",
    });
    expect(supplierTemplate("openrouter").baseURL).toBe("https://openrouter.ai/api/v1");
    expect(supplierTemplate("zhipu_glm").models).toEqual(["glm-5.1"]);
  });

  it("declares endpoint model catalogs for the zhipu anthropic templates", () => {
    // anthropic 类型没有显式目录 URL 时会推断成 manual_only，发现模型会被门禁拦下。
    expect(supplierTemplate("zhipu_glm").modelCatalog).toMatchObject({
      status: "openai_models",
      urls: ["https://open.bigmodel.cn/api/anthropic/v1/models"],
    });
    expect(supplierTemplate("zhipu_glm_en").modelCatalog).toMatchObject({
      status: "openai_models",
      urls: ["https://api.z.ai/api/anthropic/v1/models"],
    });
  });

  it("keeps catalog suppliers sorted after the core templates", () => {
    const labels = SUPPLIER_TEMPLATES.slice(4).map(({ label }) => label);
    const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
    expect(labels).toEqual([...labels].sort(collator.compare));
  });

  it("resolves compatibility aliases without listing them by default", () => {
    expect(supplierTemplate(" MOONSHOT ")).toMatchObject({
      id: "moonshot",
      type: "openai",
      baseURL: "https://api.moonshot.cn/v1",
    });
    expect(supplierTemplate("missing").id).toBe("custom");
    expect(supplierSelectOptions().some(({ value }) => value === "moonshot")).toBe(false);
    expect(supplierSelectOptions("moonshot").at(-1)).toMatchObject({ value: "moonshot" });
  });

  it("exposes model catalog and usage lookup helpers", () => {
    expect(supplierModelCatalog("gemini_native")).toMatchObject({
      status: "gemini_models",
      urls: ["https://generativelanguage.googleapis.com/v1beta/models"],
    });
    expect(supplierUsageStatus("openrouter")).toMatchObject({
      status: "fixed",
      provider: "openrouter",
    });
  });

  it("derives usage requests from adapter overrides", () => {
    expect(supplierUsageRequest("openrouter")).toEqual({ status: "fixed", provider: "openrouter" });
    expect(
      supplierUsageRequest({
        supplierID: "openrouter",
        balanceProfile: "custom",
      }),
    ).toEqual({ status: "custom_only", provider: "" });
    expect(
      supplierUsageRequest({
        supplierID: "zhipu_glm",
        balanceProfile: "token_plan",
        balanceCodingPlanProvider: "override",
      }),
    ).toEqual({ status: "token_plan", provider: "override" });
    expect(
      supplierUsageRequest({
        supplierID: "custom",
        balanceProfile: "auto",
        balanceQueryURL: "https://example.com/usage",
        balanceQueryField: "data.balance",
      }),
    ).toEqual({ status: "custom_only", provider: "" });
  });
});
