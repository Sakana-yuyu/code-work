import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ByokModelDiscoveryRequest,
  ByokModelDiscoveryResult,
  ByokSupplierCatalogEntry,
} from "./byokDiscovery.ts";

const decodeRequest = Schema.decodeUnknownSync(ByokModelDiscoveryRequest);
const decodeResult = Schema.decodeUnknownSync(ByokModelDiscoveryResult);
const decodeCatalog = Schema.decodeUnknownSync(ByokSupplierCatalogEntry);

describe("BYOK discovery contracts", () => {
  it("accepts only instance and adapter identifiers for discovery requests", () => {
    expect(
      decodeRequest({
        instanceId: "instance-1",
        adapterId: "adapter-1",
        forceRefresh: true,
      }),
    ).toEqual({
      instanceId: "instance-1",
      adapterId: "adapter-1",
      forceRefresh: true,
    });

    const decodedWithUnknownSecrets = decodeRequest({
      instanceId: "instance-1",
      adapterId: "adapter-1",
      apiKey: "sk-must-not-be-accepted",
      headers: { authorization: "Bearer secret" },
    });
    expect(decodedWithUnknownSecrets).toEqual({
      instanceId: "instance-1",
      adapterId: "adapter-1",
    });
    expect(JSON.stringify(decodedWithUnknownSecrets)).not.toContain("sk-");
  });

  it("decodes stale failures and keeps the result free of credential fields", () => {
    const result = decodeResult({
      instanceId: "instance-1",
      adapterId: "adapter-1",
      status: "cached",
      models: [{ id: "model-a", ownedBy: "provider-a" }],
      source: "https://provider.test",
      fetchedAt: "2026-08-25T00:00:00.000Z",
      stale: true,
      error: { code: "upstream_http", message: "The catalog request failed." },
    });
    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("cookie");
    expect(serialized).not.toContain("apiKey".toLowerCase());
    expect(result.stale).toBe(true);
  });

  it("allows public key-page metadata but not secret values in supplier catalog entries", () => {
    const catalog = decodeCatalog({
      id: "openrouter",
      label: "OpenRouter",
      protocol: "openai",
      defaultBaseURL: "https://openrouter.ai/api/v1",
      allowCustomURL: true,
      modelCatalogStatus: "openai_models",
      modelCatalogURLs: ["https://openrouter.ai/api/v1/models"],
      appendGeneratedCandidates: true,
      websiteURL: "https://openrouter.ai",
      apiKeyURL: "https://openrouter.ai/keys",
      iconLight: false,
      models: [{ modelId: "openai/gpt-4.1" }],
    });
    expect(catalog.apiKeyURL).toBe("https://openrouter.ai/keys");
    expect(JSON.stringify(catalog)).not.toContain("sk-");
  });
});
