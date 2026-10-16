/**
 * One-click BYOK upstream import (port of BaoCode's `provider/import`
 * contract). A provider site's "Import" link carries only four safe fields —
 * `url`, `protocol`, `name`, `key` — so a link can never write environment
 * variables, an auth mode, or a model list. The website variant keeps the
 * fields after `#` so the browser never sends the key to the page's server;
 * the app deep link carries them as a query.
 *
 * Only these fields are ever read; anything else in the link is ignored.
 *
 * @module providerImport
 */

export type ProviderImportProtocol = "openai" | "anthropic" | "gemini";

export interface ProviderImportPayload {
  /** Cleaned single-line display name, at most 64 chars; defaults to the base URL's host. */
  readonly name: string;
  readonly protocol: ProviderImportProtocol;
  /** Normalized base URL: trimmed, http(s), no trailing slashes. */
  readonly baseURL: string;
  /** Cleaned API key, at most 512 chars; empty when the link has none. */
  readonly apiKey: string;
}

export type ProviderImportParseError =
  | "invalid-link"
  | "unsupported-version"
  | "unsupported-protocol"
  | "invalid-url";

export type ProviderImportParseResult =
  | { readonly ok: true; readonly payload: ProviderImportPayload }
  | { readonly ok: false; readonly error: ProviderImportParseError };

export const PROVIDER_IMPORT_VERSION = "1";
export const PROVIDER_IMPORT_MAX_NAME_LENGTH = 64;
export const PROVIDER_IMPORT_MAX_KEY_LENGTH = 512;

/** Import links address `provider/import` under the app's own URL scheme. */
export const PROVIDER_IMPORT_LINK_HOST = "provider";
export const PROVIDER_IMPORT_LINK_PATH = "/import";

const VERSIONED_PATH_SEGMENT = /^v\d+[a-z0-9.]*$/i;

const cleanLine = (text: string, max: number): string => {
  // One line, without control characters, at most `max` long.
  let line = "";
  for (const char of text.trim()) {
    const code = char.charCodeAt(0);
    line += code < 32 || code === 127 ? " " : char;
  }
  line = line.trim();
  return line.length > max ? line.slice(0, max).trim() : line;
};

/** `url` as a normalized base URL, or null when it is not http(s) with a host. */
export const parseProviderImportBaseUrl = (raw: string): string | null => {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.host) return null;
  return url.href.replace(/\/+$/, "");
};

const PROTOCOL_IDS: Readonly<Record<string, ProviderImportProtocol>> = {
  anthropic: "anthropic",
  openai: "openai",
  "openai-chat": "openai",
  "openai-responses": "openai",
  gemini: "gemini",
};

/**
 * The base a request actually goes to for duplicate detection: Anthropic
 * drops a trailing `/v1` (the client adds it), OpenAI gains `/v1` when the
 * path has no version segment, Gemini is compared as given.
 */
export const providerImportRequestBase = (
  protocol: ProviderImportProtocol,
  baseURL: string,
): string | null => {
  const normalized = parseProviderImportBaseUrl(baseURL);
  if (normalized === null) return null;
  if (protocol === "anthropic") {
    return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized;
  }
  if (protocol === "openai") {
    const versioned = normalized
      .split("/")
      .slice(3)
      .some((segment) => VERSIONED_PATH_SEGMENT.test(segment));
    return versioned ? normalized : `${normalized}/v1`;
  }
  return normalized;
};

/**
 * The first adapter a payload would duplicate: same protocol at the same
 * request base. The import then offers "update key" or "save as another".
 */
export const findProviderImportDuplicate = <T extends { protocol: string; baseURL: string }>(
  adapters: ReadonlyArray<T>,
  payload: ProviderImportPayload,
): T | undefined => {
  const base = providerImportRequestBase(payload.protocol, payload.baseURL);
  if (base === null) return undefined;
  return adapters.find(
    (adapter) =>
      adapter.protocol === payload.protocol &&
      providerImportRequestBase(payload.protocol, adapter.baseURL) === base,
  );
};

/**
 * The four accepted fields. Anything else (`env`, auth mode, model lists,
 * unknown keys) is ignored so a link cannot smuggle executable or
 * secret-shaped data into settings.
 */
export const parseProviderImportParams = (
  params: ReadonlyMap<string, string>,
): ProviderImportParseResult => {
  const version = params.get("v");
  if (version !== undefined && version !== PROVIDER_IMPORT_VERSION) {
    return { ok: false, error: "unsupported-version" };
  }
  const protocolId = (params.get("protocol") ?? "").trim();
  const protocol = protocolId === "" ? "anthropic" : PROTOCOL_IDS[protocolId];
  if (protocol === undefined) return { ok: false, error: "unsupported-protocol" };
  const baseURL = parseProviderImportBaseUrl(params.get("url") ?? "");
  if (baseURL === null) return { ok: false, error: "invalid-url" };
  const name = cleanLine(params.get("name") ?? "", PROVIDER_IMPORT_MAX_NAME_LENGTH);
  return {
    ok: true,
    payload: {
      name: name || new URL(baseURL).host,
      protocol,
      baseURL,
      apiKey: cleanLine(params.get("key") ?? "", PROVIDER_IMPORT_MAX_KEY_LENGTH),
    },
  };
};

/** Split `v=1&name=…` text (with a leading `#` or `?`) without form semantics — a `+` in a key stays a `+`. */
export const readProviderImportParamsText = (text: string): Map<string, string> => {
  const params = new Map<string, string>();
  for (const part of text.replace(/^[#?]/, "").split("&")) {
    if (!part) continue;
    const at = part.indexOf("=");
    const name = at < 0 ? part : part.slice(0, at);
    const value = at < 0 ? "" : part.slice(at + 1);
    try {
      params.set(decodeURIComponent(name), decodeURIComponent(value));
    } catch {
      // A malformed pair cannot affect the four fields we read.
    }
  }
  return params;
};

/**
 * The hosted-page variant: fields after `#` (falling back to `?` for a site
 * that put them there), which the browser never sends to the page's server.
 */
export const parseProviderImportFragment = (fragment: string): ProviderImportParseResult =>
  parseProviderImportParams(readProviderImportParamsText(fragment));

/**
 * The app deep-link variant: `<scheme>://provider/import?v=1&…`. The query
 * is read first, then the fragment, mirroring the site bridge which emits a
 * query for the app. Only the app's own schemes are accepted.
 */
export const parseProviderImportLink = (
  link: string,
  schemes: ReadonlyArray<string>,
): ProviderImportParseResult => {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return { ok: false, error: "invalid-link" };
  }
  const scheme = url.protocol.replace(/:$/, "");
  if (
    !schemes.includes(scheme) ||
    url.host !== PROVIDER_IMPORT_LINK_HOST ||
    url.pathname !== PROVIDER_IMPORT_LINK_PATH
  ) {
    return { ok: false, error: "invalid-link" };
  }
  const text = url.search.length > 1 ? url.search : url.hash;
  if (text.length <= 1) return { ok: false, error: "invalid-link" };
  return parseProviderImportFragment(text);
};

/** The payload as a confirmation shows it: the first and last few characters. */
export const maskProviderImportKey = (key: string): string => {
  if (!key) return "";
  if (key.length <= 12) return "•".repeat(Math.min(key.length, 8));
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
};
