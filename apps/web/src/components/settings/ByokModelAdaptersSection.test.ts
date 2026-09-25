import { describe, expect, it } from "vite-plus/test";

import {
  BYOK_SUPPLIER_TEMPLATES,
  applyContextMatchDetails,
  applyRelayEdit,
  countContextMatchChanges,
  draftModelSelectionPatch,
  filterDiscoveredModels,
  filterSupplierTemplates,
  formStateFromAdapter,
  groupByokModelAdapters,
  isValidCustomHeadersJson,
  manualModelCapabilitiesPatch,
  readByokModelAdapters,
  relayEditFormFromAdapters,
  removeBenchmarkResult,
  retainCurrentContextMatches,
  retainCurrentBenchmarkResults,
} from "./ByokModelAdaptersSection";
import type { ByokContextWindowMatchResult, ByokModelAdapter } from "@codework/contracts";

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
      iconURL: "/supplier-icons/deepseek.svg",
      iconLight: false,
    },
    {
      id: "volcengine_agent",
      label: "火山Agent Plan",
      protocol: "openai",
      baseURL: "https://ark.cn-beijing.volces.com/api/v3",
      iconURL: "/supplier-icons/huoshan.png",
      iconLight: false,
    },
  ] as const;

  it("matches supplier cards by label, id, or URL without using a starter model", () => {
    expect(filterSupplierTemplates(templates, "火山")).toEqual([templates[1]]);
    expect(filterSupplierTemplates(templates, "volcengine")).toEqual([templates[1]]);
    expect(filterSupplierTemplates(templates, "deepseek.com")).toEqual([templates[0]]);
    expect(filterSupplierTemplates(templates, "deepseek-chat")).toEqual([]);
  });

  it("returns the original supplier order when the search box is empty", () => {
    expect(filterSupplierTemplates(templates, "   ")).toEqual(templates);
  });
});

describe("readByokModelAdapters", () => {
  it("保存后重读供应商和目录信息，编辑时保留供应商选择与路由字段", () => {
    const adapter = readByokModelAdapters({
      adapters: [
        {
          id: "openrouter-model",
          displayName: "OpenRouter Model",
          supplierID: "openrouter",
          protocol: "openai",
          baseURL: "https://openrouter.ai/api/v1",
          apiKey: "",
          apiKeyRedacted: true,
          modelId: "openai/gpt-4.1",
          contextWindowTokens: 128_000,
          modelCatalogURLs: ["https://openrouter.ai/api/v1/models"],
          modelCatalogStatus: "openai_models",
          appendModelCatalogCandidates: false,
        },
      ],
    })[0]!;

    expect(adapter).toMatchObject({
      supplierID: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      modelId: "openai/gpt-4.1",
      modelCatalogURLs: ["https://openrouter.ai/api/v1/models"],
      modelCatalogStatus: "openai_models",
      appendModelCatalogCandidates: false,
    });
    expect(formStateFromAdapter(adapter)).toMatchObject({
      supplier: "openrouter",
      baseURL: adapter.baseURL,
      modelId: adapter.modelId,
    });
  });

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
        customHeaders: "",
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
            customHeaders: "",
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
        customHeaders: "",
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

  it("infers the native protocol for claude and gemini models", () => {
    expect(draftModelSelectionPatch({ id: "claude-sonnet-4-6" }, "openai")).toMatchObject({
      protocol: "anthropic",
    });
    expect(draftModelSelectionPatch({ id: "gemini-3.5-flash" }, "openai")).toMatchObject({
      protocol: "gemini",
    });
    expect(draftModelSelectionPatch({ id: "deepseek-v4-pro" }, "openai")).not.toHaveProperty(
      "protocol",
    );
  });

  it("carries the catalog-enriched max output into the draft", () => {
    expect(
      draftModelSelectionPatch({ id: "claude-sonnet-4-6", maxOutputTokens: 64000 }, "openai"),
    ).toMatchObject({ maxOutputTokens: "64000" });
  });
});

describe("manualModelCapabilitiesPatch", () => {
  it("raises the untouched default context window and fills an empty max output", () => {
    expect(
      manualModelCapabilitiesPatch(
        { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
        { contextWindowTokens: "128000", maxOutputTokens: "" },
      ),
    ).toEqual({ contextWindowTokens: "1000000", maxOutputTokens: "128000" });
  });

  it("keeps values the user already entered", () => {
    expect(
      manualModelCapabilitiesPatch(
        { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
        { contextWindowTokens: "256000", maxOutputTokens: "32000" },
      ),
    ).toEqual({});
  });

  it("returns an empty patch when the catalog has no entry for the model", () => {
    expect(
      manualModelCapabilitiesPatch({}, { contextWindowTokens: "128000", maxOutputTokens: "" }),
    ).toEqual({});
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
    customHeaders: "",
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

describe("retainCurrentBenchmarkResults", () => {
  const adapter = (modelId: string, baseURL = "https://relay.example/v1"): ByokModelAdapter => ({
    id: "adapter-1",
    displayName: modelId,
    protocol: "openai",
    baseURL,
    apiKey: "",
    balanceAccessToken: "",
    customHeaders: "",
    modelId,
    contextWindowTokens: 128_000,
  });

  it("drops results measured against a different model or relay", () => {
    const current = adapter("deepseek-v4");
    expect(
      retainCurrentBenchmarkResults(
        {
          "adapter-1": {
            tokensPerSecond: 120,
            totalMs: 1000,
            fingerprint: "openai\u0000https://relay.example/v1\u0000old-model",
          },
        },
        [current],
      ),
    ).toEqual({});
  });

  it("keeps a result when the adapter identity still matches", () => {
    const current = adapter("deepseek-v4");
    expect(
      retainCurrentBenchmarkResults(
        {
          "adapter-1": {
            tokensPerSecond: 120,
            totalMs: 1000,
            fingerprint: "openai\u0000https://relay.example/v1\u0000deepseek-v4",
          },
        },
        [current],
      ),
    ).toMatchObject({ "adapter-1": { tokensPerSecond: 120 } });
  });

  it("removes the previous result before a fresh measurement", () => {
    expect(
      removeBenchmarkResult(
        {
          "adapter-1": {
            tokensPerSecond: 120,
            totalMs: 1000,
            fingerprint: "openai\u0000https://relay.example/v1\u0000deepseek-v4",
          },
          "adapter-2": {
            tokensPerSecond: 80,
            totalMs: 1500,
            fingerprint: "openai\u0000https://relay.example/v1\u0000deepseek-v3",
          },
        },
        "adapter-1",
      ),
    ).toEqual({
      "adapter-2": {
        tokensPerSecond: 80,
        totalMs: 1500,
        fingerprint: "openai\u0000https://relay.example/v1\u0000deepseek-v3",
      },
    });
  });
});

describe("retainCurrentContextMatches", () => {
  const adapter = (
    id: string,
    modelId: string,
    contextWindowTokens = 128_000,
  ): ByokModelAdapter => ({
    id,
    displayName: modelId,
    protocol: "openai",
    baseURL: "https://relay.example/v1",
    apiKey: "",
    balanceAccessToken: "",
    customHeaders: "",
    modelId,
    contextWindowTokens,
  });

  const result = (before: number): ByokContextWindowMatchResult => ({
    adapterId: "adapter-1",
    total: 1,
    fromCatalog: 0,
    fromProbe: 1,
    unchanged: 0,
    details: [
      {
        adapterId: "adapter-1",
        modelId: "deepseek-v4",
        source: "probe",
        before,
        after: 256_000,
      },
    ],
  });

  it("drops a context diagnosis after the model or configured window changes", () => {
    expect(
      retainCurrentContextMatches({ "adapter-1": result(128_000) }, [
        adapter("adapter-1", "deepseek-v5"),
      ]),
    ).toEqual({});
    expect(
      retainCurrentContextMatches({ "adapter-1": result(128_000) }, [
        adapter("adapter-1", "deepseek-v4", 64_000),
      ]),
    ).toEqual({});
  });

  it("keeps a diagnosis when the complete relay model set still matches", () => {
    const current = [adapter("adapter-1", "deepseek-v4")];
    expect(retainCurrentContextMatches({ "adapter-1": result(128_000) }, current)).toMatchObject({
      "adapter-1": { total: 1 },
    });
  });
});

describe("applyContextMatchDetails", () => {
  const adapter = (
    id: string,
    modelId: string,
    contextWindowTokens = 128_000,
  ): ByokModelAdapter => ({
    id,
    displayName: modelId,
    protocol: "openai",
    baseURL: "https://relay.example/v1",
    apiKey: "",
    balanceAccessToken: "",
    customHeaders: "",
    modelId,
    contextWindowTokens,
  });

  it("applies context windows and max-output backfills together", () => {
    const first = adapter("adapter-1", "gpt-5.6-luna", 1_000_000);
    const second = adapter("adapter-2", "claude-sonnet-4-6", 200_000);
    const third = adapter("adapter-3", "private-model");

    const patched = applyContextMatchDetails(
      [first, second, third],
      [
        {
          adapterId: "adapter-1",
          modelId: "gpt-5.6-luna",
          source: "catalog",
          before: 1_000_000,
          after: 272_000,
          maxOutputAfter: 32_768,
        },
        {
          adapterId: "adapter-2",
          modelId: "claude-sonnet-4-6",
          source: "catalog",
          before: 200_000,
          after: 200_000,
          maxOutputAfter: 64_000,
        },
        {
          adapterId: "adapter-3",
          modelId: "private-model",
          source: "unchanged",
          before: 128_000,
          after: 128_000,
        },
      ],
    );

    expect(patched[0]).toMatchObject({ contextWindowTokens: 272_000, maxOutputTokens: 32_768 });
    expect(patched[1]).toMatchObject({ contextWindowTokens: 200_000, maxOutputTokens: 64_000 });
    expect(patched[2]).toBe(third);
  });

  it("counts every adapter whose context or max output changes", () => {
    expect(
      countContextMatchChanges([
        {
          adapterId: "adapter-1",
          modelId: "m",
          source: "catalog",
          before: 128_000,
          after: 128_000,
          maxOutputAfter: 32_768,
        },
        {
          adapterId: "adapter-2",
          modelId: "m",
          source: "unchanged",
          before: 128_000,
          after: 128_000,
        },
      ]),
    ).toBe(1);
  });
});

describe("applyRelayEdit", () => {
  const adapter = (id: string, overrides: Partial<ByokModelAdapter> = {}): ByokModelAdapter => ({
    id,
    displayName: id,
    protocol: "openai",
    baseURL: "https://old.example/v1",
    apiKey: "",
    balanceAccessToken: "",
    customHeaders: "",
    modelId: id,
    contextWindowTokens: 128_000,
    ...overrides,
  });

  const members: ByokModelAdapter[] = [
    adapter("model-a", { apiKeyRedacted: true, apiKeySourceAdapterId: "model-a" }),
    adapter("model-b", { apiKey: "sk-plain", balanceProfile: "newapi" }),
  ];
  const outsider = adapter("outsider");

  it("applies connection-level fields to every member and leaves others untouched", () => {
    const next = applyRelayEdit(
      [members[0]!, outsider, members[1]!],
      members,
      relayEditFormFromAdapters(members),
    );

    expect(next[1]).toBe(outsider);
    expect(next[0]).toMatchObject({
      protocol: "openai",
      baseURL: "https://old.example/v1",
      apiKeyRedacted: true,
      apiKeySourceAdapterId: "model-a",
    });
    // 预填值未改动时，各成员自己的余额档案保留，不被首个成员的配置洗掉。
    expect(next[2]).toMatchObject({ apiKey: "sk-plain", balanceProfile: "newapi" });
  });

  it("replaces keys and connection fields for all members when provided", () => {
    const next = applyRelayEdit([members[0]!, members[1]!], members, {
      ...relayEditFormFromAdapters(members),
      groupName: "Renamed",
      protocol: "anthropic",
      baseURL: "https://new.example",
      apiKey: "sk-fresh",
      balanceProfile: "auto",
      balanceAccessToken: "",
      customHeaders: "",
      balanceUserID: "",
    });

    expect(next).toHaveLength(2);
    for (const entry of next) {
      expect(entry).toMatchObject({
        groupName: "Renamed",
        protocol: "anthropic",
        baseURL: "https://new.example",
        apiKey: "sk-fresh",
      });
      expect(entry.apiKeyRedacted).toBeUndefined();
      expect(entry.apiKeySourceAdapterId).toBeUndefined();
    }
    // 目标地址和协议已变，旧供应商的余额档案不能沿用。
    expect(next[1]?.balanceProfile).toBeUndefined();
  });

  it("applies a changed balance profile to every member", () => {
    const next = applyRelayEdit([members[0]!, members[1]!], members, {
      ...relayEditFormFromAdapters(members),
      balanceProfile: "general",
      balanceAccessToken: "",
      customHeaders: "",
      balanceUserID: "",
    });

    expect(next[0]?.balanceProfile).toBe("general");
    expect(next[1]?.balanceProfile).toBe("general");
  });

  it("keeps each member's stored key when the draft key is blank", () => {
    const next = applyRelayEdit([members[0]!, members[1]!], members, {
      ...relayEditFormFromAdapters(members),
      apiKey: "   ",
    });

    expect(next[0]).toMatchObject({ apiKeyRedacted: true, apiKeySourceAdapterId: "model-a" });
    expect(next[1]).toMatchObject({ apiKey: "sk-plain" });
  });

  it("更换通道地址时不沿用密钥、目录和余额令牌", () => {
    const original = adapter("model-switch", {
      apiKeyRedacted: true,
      balanceAccessTokenRedacted: true,
      customHeadersRedacted: true,
      modelCatalogURLs: ["https://old.example/v1/models"],
      balanceProfile: "newapi",
      balanceUserID: "42",
    });
    const next = applyRelayEdit([original], [original], {
      ...relayEditFormFromAdapters([original]),
      baseURL: "https://new.example/v1",
    })[0]!;

    expect(next.baseURL).toBe("https://new.example/v1");
    expect(next.apiKey).toBe("");
    expect(next.balanceAccessToken).toBe("");
    expect(next.customHeaders).toBe("");
    for (const key of [
      "apiKeyRedacted",
      "balanceAccessTokenRedacted",
      "customHeadersRedacted",
      "modelCatalogURLs",
      "balanceProfile",
      "balanceUserID",
    ]) {
      expect(next).not.toHaveProperty(key);
    }
  });
});

describe("isValidCustomHeadersJson", () => {
  it("accepts empty input and string-valued JSON objects", () => {
    expect(isValidCustomHeadersJson("")).toBe(true);
    expect(isValidCustomHeadersJson("   ")).toBe(true);
    expect(isValidCustomHeadersJson('{"X-Custom":"value"}')).toBe(true);
  });

  it("rejects anything that is not a string-valued JSON object", () => {
    expect(isValidCustomHeadersJson("not json")).toBe(false);
    expect(isValidCustomHeadersJson('["array"]')).toBe(false);
    expect(isValidCustomHeadersJson('{"nested":{"a":1}}')).toBe(false);
    expect(isValidCustomHeadersJson('{"n":1}')).toBe(false);
  });
});

describe("applyRelayEdit custom headers", () => {
  const adapter = (id: string, overrides: Partial<ByokModelAdapter> = {}): ByokModelAdapter => ({
    id,
    displayName: id,
    protocol: "openai",
    baseURL: "https://old.example/v1",
    apiKey: "",
    customHeaders: "",
    balanceAccessToken: "",
    modelId: id,
    contextWindowTokens: 128_000,
    ...overrides,
  });

  it("keeps each member's stored headers when the draft is blank", () => {
    const members: ByokModelAdapter[] = [
      adapter("model-a", { customHeadersRedacted: true }),
      adapter("model-b"),
    ];
    const next = applyRelayEdit(
      [members[0]!, members[1]!],
      members,
      relayEditFormFromAdapters(members),
    );
    expect(next[0]?.customHeadersRedacted).toBe(true);
    expect(next[1]?.customHeadersRedacted).toBeUndefined();
  });

  it("replaces headers for every member when provided", () => {
    const members: ByokModelAdapter[] = [
      adapter("model-a", { customHeadersRedacted: true }),
      adapter("model-b"),
    ];
    const next = applyRelayEdit([members[0]!, members[1]!], members, {
      ...relayEditFormFromAdapters(members),
      customHeaders: '{"X-Custom":"value"}',
    });
    expect(next[0]).toMatchObject({ customHeaders: '{"X-Custom":"value"}' });
    expect(next[0]?.customHeadersRedacted).toBeUndefined();
    expect(next[1]).toMatchObject({ customHeaders: '{"X-Custom":"value"}' });
  });

  it("clears headers for every member when explicitly requested", () => {
    const members: ByokModelAdapter[] = [
      adapter("model-a", { customHeadersRedacted: true }),
      adapter("model-b", { customHeadersRedacted: true }),
    ];
    const next = applyRelayEdit([members[0]!, members[1]!], members, {
      ...relayEditFormFromAdapters(members),
      clearCustomHeaders: true,
    });
    expect(next[0]?.customHeadersRedacted).toBeUndefined();
    expect(next[1]?.customHeadersRedacted).toBeUndefined();
  });
});
