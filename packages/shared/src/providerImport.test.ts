import { describe, expect, it } from "vitest";

import {
  findProviderImportDuplicate,
  maskProviderImportKey,
  parseProviderImportFragment,
  parseProviderImportLink,
  providerImportRequestBase,
  readProviderImportParamsText,
} from "./providerImport";

const SCHEMES = ["codework", "codework-dev", "codework-preview", "t3code"];

describe("parseProviderImportFragment", () => {
  it("accepts the four fields after # and defaults the name to the host", () => {
    const result = parseProviderImportFragment(
      "#v=1&name=My%20Relay&protocol=anthropic&url=https%3A%2F%2Fapi.example.com&key=sk-abc",
    );
    expect(result).toEqual({
      ok: true,
      payload: {
        name: "My Relay",
        protocol: "anthropic",
        baseURL: "https://api.example.com",
        apiKey: "sk-abc",
      },
    });
  });

  it("defaults protocol to anthropic and name to host", () => {
    const result = parseProviderImportFragment("#url=https://relay.example.com/v1");
    expect(result).toEqual({
      ok: true,
      payload: {
        name: "relay.example.com",
        protocol: "anthropic",
        baseURL: "https://relay.example.com/v1",
        apiKey: "",
      },
    });
  });

  it("maps openai-chat/openai-responses onto the openai protocol", () => {
    for (const id of ["openai-chat", "openai-responses", "openai"]) {
      const result = parseProviderImportFragment(`#protocol=${id}&url=https://x.example`);
      expect(result.ok && result.payload.protocol).toBe("openai");
    }
  });

  it("rejects an unknown protocol and a non-1 version", () => {
    expect(parseProviderImportFragment("#protocol=weird&url=https://x.example")).toEqual({
      ok: false,
      error: "unsupported-protocol",
    });
    expect(parseProviderImportFragment("#v=2&url=https://x.example")).toEqual({
      ok: false,
      error: "unsupported-version",
    });
  });

  it("rejects non-http(s) and hostless urls", () => {
    expect(parseProviderImportFragment("#url=ftp://x.example")).toEqual({
      ok: false,
      error: "invalid-url",
    });
    expect(parseProviderImportFragment("#url=not-a-url")).toEqual({
      ok: false,
      error: "invalid-url",
    });
  });

  it("ignores fields outside the four accepted ones", () => {
    const result = parseProviderImportFragment(
      "#url=https://x.example&env=PATH%3D%2Fevil&auth=oauth&models=big&key=k",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).not.toHaveProperty("env");
      expect(result.payload.apiKey).toBe("k");
    }
  });

  it("strips control characters and caps the name", () => {
    const result = parseProviderImportFragment(
      `#url=https://x.example&name=${encodeURIComponent("a\nb".padEnd(200, "c"))}`,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.name).not.toMatch(/[\n\r]/);
      expect(result.payload.name.length).toBeLessThanOrEqual(64);
    }
  });

  it("keeps a literal plus inside a key", () => {
    const params = readProviderImportParamsText("#key=a%2Bb+c");
    expect(params.get("key")).toBe("a+b+c");
  });
});

describe("parseProviderImportLink", () => {
  it("accepts the app scheme, provider host and /import path with a query", () => {
    const result = parseProviderImportLink(
      "codework://provider/import?v=1&protocol=gemini&url=https%3A%2F%2Fg.example&key=k",
      SCHEMES,
    );
    expect(result).toEqual({
      ok: true,
      payload: {
        name: "g.example",
        protocol: "gemini",
        baseURL: "https://g.example",
        apiKey: "k",
      },
    });
  });

  it("accepts fields after # on the app link too", () => {
    const result = parseProviderImportLink(
      "codework-dev://provider/import#url=https%3A%2F%2Fx.example",
      SCHEMES,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects foreign schemes, wrong hosts and other paths", () => {
    expect(
      parseProviderImportLink("https://provider/import?url=https://x.example", SCHEMES),
    ).toEqual({ ok: false, error: "invalid-link" });
    expect(
      parseProviderImportLink("codework://settings/import?url=https://x.example", SCHEMES),
    ).toEqual({ ok: false, error: "invalid-link" });
    expect(
      parseProviderImportLink("codework://provider/other?url=https://x.example", SCHEMES),
    ).toEqual({ ok: false, error: "invalid-link" });
    expect(parseProviderImportLink("codework://provider/import", SCHEMES)).toEqual({
      ok: false,
      error: "invalid-link",
    });
  });
});

describe("providerImportRequestBase", () => {
  it("strips a trailing /v1 for anthropic and adds one for openai", () => {
    expect(providerImportRequestBase("anthropic", "https://x.example/v1")).toBe(
      "https://x.example",
    );
    expect(providerImportRequestBase("openai", "https://x.example")).toBe("https://x.example/v1");
    expect(providerImportRequestBase("openai", "https://x.example/v4")).toBe(
      "https://x.example/v4",
    );
  });
});

describe("findProviderImportDuplicate", () => {
  const adapters = [
    { id: "a1", protocol: "openai", baseURL: "https://x.example/v1" },
    { id: "a2", protocol: "anthropic", baseURL: "https://y.example" },
  ];

  it("matches the same protocol at the same request base across /v1 spellings", () => {
    const dup = findProviderImportDuplicate(adapters, {
      name: "x",
      protocol: "openai",
      baseURL: "https://x.example",
      apiKey: "",
    });
    expect(dup?.id).toBe("a1");
  });

  it("does not match a different protocol on the same host", () => {
    expect(
      findProviderImportDuplicate(adapters, {
        name: "x",
        protocol: "anthropic",
        baseURL: "https://x.example/v1",
        apiKey: "",
      }),
    ).toBeUndefined();
  });
});

describe("maskProviderImportKey", () => {
  it("masks short keys fully and long keys at both ends", () => {
    expect(maskProviderImportKey("")).toBe("");
    expect(maskProviderImportKey("short")).toBe("•••••");
    expect(maskProviderImportKey("sk-1234567890abcdef")).toBe("sk-123…cdef");
  });
});
