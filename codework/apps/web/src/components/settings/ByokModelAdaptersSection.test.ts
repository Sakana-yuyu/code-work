import { describe, expect, it } from "vite-plus/test";

import { BYOK_SUPPLIER_TEMPLATES, readByokModelAdapters } from "./ByokModelAdaptersSection";

describe("BYOK supplier templates", () => {
  it("keeps custom as the only local template", () => {
    expect(BYOK_SUPPLIER_TEMPLATES.map((template) => template.id)).toEqual(["custom"]);
    expect(BYOK_SUPPLIER_TEMPLATES[0]?.baseURL).toBe("");
  });
});

describe("readByokModelAdapters", () => {
  it("preserves the redacted API-key marker returned by settings", () => {
    expect(
      readByokModelAdapters({
        adapters: [
          {
            id: "adapter-1",
            displayName: "DeepSeek Chat",
            protocol: "openai",
            baseURL: "https://api.deepseek.com/v1",
            apiKey: "",
            apiKeyRedacted: true,
            modelId: "deepseek-chat",
            contextWindowTokens: 128_000,
          },
        ],
      }),
    ).toEqual([
      {
        id: "adapter-1",
        displayName: "DeepSeek Chat",
        protocol: "openai",
        baseURL: "https://api.deepseek.com/v1",
        apiKey: "",
        apiKeyRedacted: true,
        balanceAccessToken: "",
        modelId: "deepseek-chat",
        contextWindowTokens: 128_000,
      },
    ]);
  });

  it("preserves NewAPI balance credentials and the redacted token marker", () => {
    expect(
      readByokModelAdapters({
        adapters: [
          {
            id: "adapter-2",
            displayName: "NewAPI Model",
            protocol: "openai",
            baseURL: "https://newapi.example.com/v1",
            apiKey: "",
            apiKeyRedacted: true,
            balanceProfile: "newapi",
            balanceAccessToken: "",
            balanceAccessTokenRedacted: true,
            balanceUserID: "42",
            modelId: "newapi-model",
            contextWindowTokens: 128_000,
          },
        ],
      }),
    ).toEqual([
      {
        id: "adapter-2",
        displayName: "NewAPI Model",
        protocol: "openai",
        baseURL: "https://newapi.example.com/v1",
        apiKey: "",
        apiKeyRedacted: true,
        balanceProfile: "newapi",
        balanceAccessToken: "",
        balanceAccessTokenRedacted: true,
        balanceUserID: "42",
        modelId: "newapi-model",
        contextWindowTokens: 128_000,
      },
    ]);
  });
});
