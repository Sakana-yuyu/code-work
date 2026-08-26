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
    expect(serialized).not.toContain("token");
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
});
