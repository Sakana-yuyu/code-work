import { DEFAULT_SERVER_SETTINGS } from "@codework/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  formatSearchEngineListing,
  isWebSearchEngine,
  parseBraveResults,
  parseDuckDuckGoHtml,
  parseSearxngResults,
  parseTavilyResults,
  searchWeb,
  unwrapDuckDuckGoHref,
} from "./WebSearch.ts";

describe("WebSearch", () => {
  it("recognizes configured engines", () => {
    expect(isWebSearchEngine("tavily")).toBe(true);
    expect(isWebSearchEngine("bing")).toBe(false);
  });

  it("unwraps DuckDuckGo redirect hrefs", () => {
    expect(unwrapDuckDuckGoHref("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs")).toBe(
      "https://example.com/docs",
    );
  });

  it("rejects non-http redirect targets", () => {
    expect(unwrapDuckDuckGoHref("//duckduckgo.com/l/?uddg=javascript%3Aalert(1)")).toBe("");
    expect(unwrapDuckDuckGoHref("//duckduckgo.com/l/?uddg=file%3A%2F%2F%2Fetc%2Fpasswd")).toBe("");
    expect(unwrapDuckDuckGoHref("javascript:alert(1)")).toBe("");
  });

  it("parses DuckDuckGo HTML result anchors", () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Example</a>
      <a class="result__a" href="https://other.test/page">Other</a>
    `;
    expect(parseDuckDuckGoHtml(html)).toEqual([
      { title: "Example", url: "https://example.com" },
      { title: "Other", url: "https://other.test/page" },
    ]);
  });

  it("parses Tavily, Brave, and SearXNG JSON payloads", () => {
    expect(
      parseTavilyResults({
        results: [{ title: "Tavily", url: "https://tavily.example", content: "snippet" }],
      }),
    ).toEqual([{ title: "Tavily", url: "https://tavily.example", snippet: "snippet" }]);
    expect(
      parseBraveResults({
        web: { results: [{ title: "Brave", url: "https://brave.example", description: "d" }] },
      }),
    ).toEqual([{ title: "Brave", url: "https://brave.example", snippet: "d" }]);
    expect(
      parseSearxngResults({
        results: [{ title: "SearX", url: "https://searx.example", content: "hit" }],
      }),
    ).toEqual([{ title: "SearX", url: "https://searx.example", snippet: "hit" }]);
  });

  it("does not call the network when search is disabled", async () => {
    const outcome = await searchWeb(DEFAULT_SERVER_SETTINGS.webSearch, "code work", (() => {
      throw new Error("should not fetch");
    }) as unknown as typeof fetch);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("turned off");
  });

  it("lists the current engine from Settings copy", () => {
    expect(formatSearchEngineListing(DEFAULT_SERVER_SETTINGS.webSearch)).toContain(
      "Settings → Integrations → Web search",
    );
    expect(
      formatSearchEngineListing({
        ...DEFAULT_SERVER_SETTINGS.webSearch,
        enabled: true,
        engine: "duckduckgo",
      }),
    ).toContain("engine: duckduckgo");
  });
});
