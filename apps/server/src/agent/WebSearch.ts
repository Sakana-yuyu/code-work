import {
  DEFAULT_WEB_SEARCH_ENGINE,
  WEB_SEARCH_ENGINES,
  type WebSearchEngine,
  type WebSearchSettings,
} from "@codework/contracts";

export type WebSearchHit = {
  readonly title: string;
  readonly url: string;
  readonly snippet?: string;
};

export type WebSearchOutcome = {
  readonly ok: boolean;
  readonly engine: WebSearchEngine;
  readonly query: string;
  readonly hits: ReadonlyArray<WebSearchHit>;
  readonly error?: string;
};

const MAX_QUERY_CHARS = 500;
const MAX_HITS = 8;
const SEARCH_TIMEOUT_MS = 12_000;
const USER_AGENT = "CodeWork/1.0 (+https://t3.codes)";

export function isWebSearchEngine(value: string): value is WebSearchEngine {
  return (WEB_SEARCH_ENGINES as ReadonlyArray<string>).includes(value);
}

export function formatSearchEngineListing(settings: WebSearchSettings): string {
  if (!settings.enabled) {
    return [
      "Web search is off. Enable it in Settings → Integrations → Web search.",
      `Available engines: ${WEB_SEARCH_ENGINES.join(", ")}.`,
    ].join("\n");
  }
  const lines = [
    `Web search is on (engine: ${settings.engine}).`,
    settings.engine === "searxng"
      ? `SearXNG URL: ${settings.baseUrl.trim().length === 0 ? "(not set)" : settings.baseUrl}`
      : settings.engine === "duckduckgo"
        ? "DuckDuckGo does not need an API key."
        : settings.apiKeyRedacted === true || settings.apiKey.trim().length > 0
          ? "An API key is stored on the server."
          : "This engine needs an API key in Settings → Integrations → Web search.",
    "",
    `Change the engine in Settings, or type /search-engine ${WEB_SEARCH_ENGINES.join("|")}.`,
  ];
  return lines.join("\n");
}

const stripTags = (value: string): string =>
  value
    .replace(/<[^>]+>/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();

export function parseDuckDuckGoHtml(html: string): ReadonlyArray<WebSearchHit> {
  const hits: WebSearchHit[] = [];
  const seen = new Set<string>();
  const linkPattern =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/giu;
  for (const match of html.matchAll(linkPattern)) {
    const href = match[1] ?? "";
    const title = stripTags(match[2] ?? "");
    const url = unwrapDuckDuckGoHref(href);
    if (title.length === 0 || url.length === 0 || seen.has(url)) continue;
    seen.add(url);
    hits.push({ title, url });
    if (hits.length >= MAX_HITS) break;
  }
  return hits;
}

export function unwrapDuckDuckGoHref(href: string): string {
  try {
    const parsed = new URL(href, "https://html.duckduckgo.com/");
    const uddg = parsed.searchParams.get("uddg");
    if (uddg !== null && uddg.length > 0) {
      // 重定向目标与直链同一口径：只放行 http/https，挡掉 javascript: 等伪协议。
      try {
        const target = new URL(uddg);
        if (target.protocol === "http:" || target.protocol === "https:") return uddg;
      } catch {
        return "";
      }
      return "";
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
    return "";
  } catch {
    return "";
  }
}

const hitsFromUnknown = (
  value: unknown,
  pick: (entry: Record<string, unknown>) => WebSearchHit | undefined,
) => {
  if (!Array.isArray(value)) return [];
  const hits: WebSearchHit[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const hit = pick(entry as Record<string, unknown>);
    if (hit === undefined || hit.url.length === 0 || seen.has(hit.url)) continue;
    seen.add(hit.url);
    hits.push(hit);
    if (hits.length >= MAX_HITS) break;
  }
  return hits;
};

export function parseTavilyResults(payload: unknown): ReadonlyArray<WebSearchHit> {
  const record =
    payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  return hitsFromUnknown(record["results"], (entry) => {
    const title = typeof entry["title"] === "string" ? entry["title"].trim() : "";
    const url = typeof entry["url"] === "string" ? entry["url"].trim() : "";
    const snippet = typeof entry["content"] === "string" ? entry["content"].trim() : undefined;
    if (title.length === 0 || url.length === 0) return undefined;
    return snippet === undefined || snippet.length === 0 ? { title, url } : { title, url, snippet };
  });
}

export function parseBraveResults(payload: unknown): ReadonlyArray<WebSearchHit> {
  const record =
    payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const web =
    record["web"] !== null && typeof record["web"] === "object"
      ? (record["web"] as Record<string, unknown>)
      : {};
  return hitsFromUnknown(web["results"], (entry) => {
    const title = typeof entry["title"] === "string" ? entry["title"].trim() : "";
    const url = typeof entry["url"] === "string" ? entry["url"].trim() : "";
    const snippet =
      typeof entry["description"] === "string" ? entry["description"].trim() : undefined;
    if (title.length === 0 || url.length === 0) return undefined;
    return snippet === undefined || snippet.length === 0 ? { title, url } : { title, url, snippet };
  });
}

export function parseSearxngResults(payload: unknown): ReadonlyArray<WebSearchHit> {
  const record =
    payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  return hitsFromUnknown(record["results"], (entry) => {
    const title = typeof entry["title"] === "string" ? entry["title"].trim() : "";
    const url = typeof entry["url"] === "string" ? entry["url"].trim() : "";
    const snippet = typeof entry["content"] === "string" ? entry["content"].trim() : undefined;
    if (title.length === 0 || url.length === 0) return undefined;
    return snippet === undefined || snippet.length === 0 ? { title, url } : { title, url, snippet };
  });
}

type FetchLike = typeof fetch;

const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

export async function searchWeb(
  settings: WebSearchSettings,
  query: string,
  fetchImpl: FetchLike = fetch,
): Promise<WebSearchOutcome> {
  const engine = isWebSearchEngine(settings.engine) ? settings.engine : DEFAULT_WEB_SEARCH_ENGINE;
  const trimmed = query.trim().slice(0, MAX_QUERY_CHARS);
  if (!settings.enabled) {
    return {
      ok: false,
      engine,
      query: trimmed,
      hits: [],
      error: "Web search is turned off in Settings → Integrations → Web search.",
    };
  }
  if (trimmed.length === 0) {
    return { ok: false, engine, query: trimmed, hits: [], error: "query must not be empty." };
  }
  try {
    const hits = await runEngine(settings, engine, trimmed, fetchImpl);
    if (hits.length === 0) {
      return {
        ok: false,
        engine,
        query: trimmed,
        hits: [],
        error: "No search results. Check the engine, API key, or SearXNG URL in Settings.",
      };
    }
    return { ok: true, engine, query: trimmed, hits };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, engine, query: trimmed, hits: [], error: detail };
  }
}

const runEngine = async (
  settings: WebSearchSettings,
  engine: WebSearchEngine,
  query: string,
  fetchImpl: FetchLike,
): Promise<ReadonlyArray<WebSearchHit>> => {
  if (engine === "duckduckgo") {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetchWithTimeout(fetchImpl, url, {
      headers: { Accept: "text/html", "User-Agent": USER_AGENT },
    });
    if (!response.ok) throw new Error(`DuckDuckGo returned HTTP ${response.status}.`);
    return parseDuckDuckGoHtml(await response.text());
  }
  if (engine === "searxng") {
    const base = settings.baseUrl.trim().replace(/\/+$/u, "");
    if (base.length === 0) {
      throw new Error("SearXNG needs a base URL in Settings → Integrations → Web search.");
    }
    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
    const response = await fetchWithTimeout(fetchImpl, url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    });
    if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}.`);
    return parseSearxngResults(await readJson(response));
  }
  if (engine === "tavily") {
    if (settings.apiKey.trim().length === 0) {
      throw new Error("Tavily needs an API key in Settings → Integrations → Web search.");
    }
    const response = await fetchWithTimeout(fetchImpl, "https://api.tavily.com/search", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        api_key: settings.apiKey,
        query,
        max_results: MAX_HITS,
      }),
    });
    if (!response.ok) throw new Error(`Tavily returned HTTP ${response.status}.`);
    return parseTavilyResults(await readJson(response));
  }
  if (settings.apiKey.trim().length === 0) {
    throw new Error("Brave Search needs an API key in Settings → Integrations → Web search.");
  }
  const response = await fetchWithTimeout(
    fetchImpl,
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        "X-Subscription-Token": settings.apiKey,
      },
    },
  );
  if (!response.ok) throw new Error(`Brave Search returned HTTP ${response.status}.`);
  return parseBraveResults(await readJson(response));
};

const fetchWithTimeout = async (
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<Response> => {
  const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const signal =
    init.signal === null || init.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([init.signal, timeoutSignal]);
  return await fetchImpl(url, { ...init, signal });
};
