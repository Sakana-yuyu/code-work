import { describe, expect, it } from "vite-plus/test";

import { canRetainByokAdapterCredentials } from "./credentialScope.ts";

describe("BYOK 密钥复用范围", () => {
  const existing = {
    supplierID: "deepseek",
    protocol: "openai" as const,
    baseURL: "https://api.deepseek.com/v1/",
  };

  it("同一供应商、协议和地址允许保留脱敏密钥", () => {
    expect(
      canRetainByokAdapterCredentials(existing, {
        ...existing,
        baseURL: " https://api.deepseek.com/v1 ",
      }),
    ).toBe(true);
  });

  it("切换供应商、地址或协议后要求新密钥", () => {
    expect(
      canRetainByokAdapterCredentials(existing, { ...existing, supplierID: "openrouter" }),
    ).toBe(false);
    expect(
      canRetainByokAdapterCredentials(existing, {
        ...existing,
        baseURL: "https://openrouter.ai/api/v1",
      }),
    ).toBe(false);
    expect(canRetainByokAdapterCredentials(existing, { ...existing, protocol: "anthropic" })).toBe(
      false,
    );
    expect(canRetainByokAdapterCredentials(existing, { ...existing, baseURL: "not a URL" })).toBe(
      false,
    );
  });
});
