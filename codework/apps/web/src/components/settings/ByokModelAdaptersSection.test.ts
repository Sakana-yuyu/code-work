import { describe, expect, it } from "vite-plus/test";

import {
  BYOK_SUPPLIER_TEMPLATES,
  draftModelSelectionPatch,
  filterDiscoveredModels,
  filterSupplierTemplates,
  groupByokModelAdapters,
  readByokModelAdapters,
} from "./ByokModelAdaptersSection";
import type { ByokModelAdapter } from "@codework/contracts";

describe("BYOK supplier templates", () => {
  it("keeps custom as the only local template", () => {
    expect(BYOK_SUPPLIER_TEMPLATES.map((template) => template.id)).toEqual(["custom"]);
    expect(BYOK_SUPPLIER_TEMPLATES[0]?.baseURL).toBe("");
  });
});

describe("filterSupplierTemplates", () => {
  const templates = [
    {
      id: "deepseek",
      label: "DeepSeek",
      protocol: "openai",
      baseURL: "https://api.deepseek.com/v1",
      modelId: "deepseek-chat",
      displayName: "DeepSeek Chat",
      iconURL: "/supplier-icons/deepseek.svg",
      iconLight: false,
    },
    {
      id: "volcengine_agent",
      label: "火山Agent Plan",
      protocol: "openai",
      baseURL: "https://ark.cn-beijing.volces.com/api/v3",
      modelId: "doubao-seed-code",
      displayName: "doubao-seed-code",
      iconURL: "/supplier-icons/huoshan.png",
      iconLight: false,
    },
  ] as const;

  it("matches supplier cards by label, id, URL, or starter model", () => {
    expect(filterSupplierTemplates(templates, "火山")).toEqual([templates[1]]);
    expect(filterSupplierTemplates(templates, "volcengine")).toEqual([templates[1]]);
    expect(filterSupplierTemplates(templates, "deepseek.com")).toEqual([templates[0]]);
    expect(filterSupplierTemplates(templates, "deepseek-chat")).toEqual([templates[0]]);
  });

  it("returns the original supplier order when the search box is empty", () => {
    expect(filterSupplierTemplates(templates, "   ")).toEqual(templates);
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
            groupName: "DeepSeek",
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
        groupName: "DeepSeek",
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

describe("draftModelSelectionPatch", () => {
  it("copies a discovered model into the draft fields and preserves its context-window metadata", () => {
    expect(draftModelSelectionPatch({ id: "provider/model", contextWindowTokens: 262144 })).toEqual(
      {
        modelId: "provider/model",
        displayName: "provider/model",
        contextWindowTokens: "262144",
      },
    );
  });

  it("does not replace the draft context window when the catalog omitted it", () => {
    expect(draftModelSelectionPatch({ id: "model-without-context" })).toEqual({
      modelId: "model-without-context",
      displayName: "model-without-context",
    });
  });
});

describe("filterDiscoveredModels", () => {
  const models = [
    { id: "gpt-5.6-luna", ownedBy: "OpenAI" },
    { id: "deepseek-v3", ownedBy: "DeepSeek" },
  ] as const;

  it("matches model ids and owners without changing the discovered-model order", () => {
    expect(filterDiscoveredModels(models, "deep")).toEqual([models[1]]);
    expect(filterDiscoveredModels(models, "openai")).toEqual([models[0]]);
  });

  it("returns the original model list when the search box is empty", () => {
    expect(filterDiscoveredModels(models, "   ")).toEqual(models);
  });
});

describe("groupByokModelAdapters", () => {
  const adapter = (
    id: string,
    baseURL: string,
    groupName?: string,
    protocol: ByokModelAdapter["protocol"] = "openai",
  ): ByokModelAdapter => ({
    id,
    displayName: id,
    ...(groupName ? { groupName } : {}),
    protocol,
    baseURL,
    apiKey: "",
    balanceAccessToken: "",
    modelId: id,
    contextWindowTokens: 128_000,
  });

  it("keeps input order while nesting models under their group and relay", () => {
    const first = adapter("gpt-5.6", "https://relay.example/v1", "Sakana");
    const second = adapter("deepseek-v3", "https://relay.example/v1", "Sakana");
    const third = adapter("claude-sonnet", "https://another.example/v1", "Sakana");
    const ungrouped = adapter("gemini-3", "https://gemini.example/v1");

    expect(groupByokModelAdapters([first, second, third, ungrouped])).toEqual([
      {
        groupName: "Sakana",
        relays: [
          {
            protocol: "openai",
            baseURL: "https://relay.example/v1",
            adapters: [first, second],
          },
          { protocol: "openai", baseURL: "https://another.example/v1", adapters: [third] },
        ],
      },
      {
        groupName: "",
        relays: [
          { protocol: "openai", baseURL: "https://gemini.example/v1", adapters: [ungrouped] },
        ],
      },
    ]);
  });

  it("keeps protocol-distinct connections separate even when their base URL matches", () => {
    const openai = adapter("openai-model", "https://relay.example/v1", "Sakana", "openai");
    const anthropic = adapter("anthropic-model", "https://relay.example/v1", "Sakana", "anthropic");

    expect(groupByokModelAdapters([openai, anthropic])[0]?.relays).toEqual([
      { protocol: "openai", baseURL: "https://relay.example/v1", adapters: [openai] },
      { protocol: "anthropic", baseURL: "https://relay.example/v1", adapters: [anthropic] },
    ]);
  });
});
