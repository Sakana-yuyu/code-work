import { describe, expect, it } from "vite-plus/test";

import { PRODUCT_IDENTITY } from "@codework/shared/productIdentity";

import { resolveMobileStageLabel } from "./mobileBranding";

describe("mobileBranding", () => {
  it("keeps the product base name as Code Work", () => {
    expect(PRODUCT_IDENTITY.baseName).toBe("Code Work");
    expect(PRODUCT_IDENTITY.baseName.toLowerCase()).not.toContain("t3");
  });

  it("maps app variants to stage labels", () => {
    expect(resolveMobileStageLabel("development")).toBe("Dev");
    expect(resolveMobileStageLabel("preview")).toBe("Nightly");
    expect(resolveMobileStageLabel("production")).toBe("Alpha");
    expect(resolveMobileStageLabel(undefined)).toBe("Alpha");
  });
});
