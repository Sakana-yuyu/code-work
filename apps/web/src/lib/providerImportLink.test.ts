import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  consumeProviderImportRequest,
  openProviderImportFragment,
  openProviderImportLink,
  subscribeProviderImportRequests,
} from "./providerImportLink";

describe("openProviderImportLink", () => {
  beforeEach(() => {
    consumeProviderImportRequest();
  });

  it("publishes a payload for our provider/import deep link", () => {
    const seen: Array<unknown> = [];
    const unsubscribe = subscribeProviderImportRequests((request) => seen.push(request));
    const handled = openProviderImportLink(
      "codework://provider/import?v=1&protocol=openai-chat&url=https%3A%2F%2Frelay.example&key=sk-1",
    );
    unsubscribe();
    expect(handled).toBe(true);
    expect(seen).toEqual([
      {
        payload: {
          name: "relay.example",
          protocol: "openai",
          baseURL: "https://relay.example",
          apiKey: "sk-1",
        },
      },
    ]);
  });

  it("publishes the parse error for a malformed provider/import link", () => {
    const handled = openProviderImportLink(
      "codework://provider/import?protocol=bogus&url=https://x.example",
    );
    expect(handled).toBe(true);
    expect(consumeProviderImportRequest()).toEqual({ error: "unsupported-protocol" });
  });

  it("returns false for links that are not provider/import targets", () => {
    expect(openProviderImportLink("codework://settings/byok?x=1")).toBe(false);
    expect(openProviderImportLink("https://example.com/provider/import?x=1")).toBe(false);
    expect(consumeProviderImportRequest()).toBeNull();
  });
});

describe("openProviderImportFragment", () => {
  it("parses fragment-carried fields and publishes the request", () => {
    const request = openProviderImportFragment("#v=1&url=https%3A%2F%2Fx.example&key=k");
    expect(request).toEqual({
      payload: {
        name: "x.example",
        protocol: "anthropic",
        baseURL: "https://x.example",
        apiKey: "k",
      },
    });
    expect(consumeProviderImportRequest()).toEqual(request);
  });
});
