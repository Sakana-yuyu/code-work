import {
  PROVIDER_IMPORT_LINK_HOST,
  PROVIDER_IMPORT_LINK_PATH,
  type ProviderImportPayload,
  type ProviderImportParseError,
  parseProviderImportFragment,
  parseProviderImportParams,
  readProviderImportParamsText,
} from "@codework/shared/providerImport";
import { PRODUCT_IDENTITY } from "@codework/shared/productIdentity";

/**
 * App schemes a provider-import deep link may arrive under: the current
 * stage's canonical scheme, the sibling stage schemes (a link opened from a
 * site never knows which build is installed), and the legacy t3code aliases.
 */
export const PROVIDER_IMPORT_SCHEMES: ReadonlyArray<string> = [
  ...Object.values(PRODUCT_IDENTITY.schemes),
  ...PRODUCT_IDENTITY.legacySchemes,
];

export interface ProviderImportRequest {
  readonly payload?: ProviderImportPayload;
  readonly error?: ProviderImportParseError;
}

const isProviderImportTarget = (link: string): boolean => {
  try {
    const url = new URL(link.trim());
    return (
      PROVIDER_IMPORT_SCHEMES.includes(url.protocol.replace(/:$/, "")) &&
      url.host === PROVIDER_IMPORT_LINK_HOST &&
      url.pathname === PROVIDER_IMPORT_LINK_PATH
    );
  } catch {
    return false;
  }
};

/**
 * React Navigation hands parsed `?` params to the route, but a fragment
 * (`#v=1&…`) is trimmed before the route sees it. Capture the raw link in
 * the linking filter — which always receives the full URL — so the import
 * screen can recover fragment-carried fields.
 */
let pendingLink: string | null = null;

export const captureProviderImportLink = (url: string): void => {
  if (isProviderImportTarget(url)) pendingLink = url;
};

export const consumeProviderImportLink = (): string | null => {
  const link = pendingLink;
  pendingLink = null;
  return link;
};

/**
 * Resolve the request for a screen: the raw captured link first (covers `#`
 * fragments), then the route's parsed params (covers `?` queries).
 */
export const resolveProviderImportRequest = (
  routeParams: Readonly<Record<string, unknown>> | undefined,
): ProviderImportRequest | null => {
  const captured = consumeProviderImportLink();
  if (captured !== null) {
    const url = new URL(captured);
    const text = url.hash.length > 1 ? url.hash : url.search;
    if (text.length > 1) {
      const result = parseProviderImportFragment(text);
      return result.ok ? { payload: result.payload } : { error: result.error };
    }
    return { error: "invalid-link" };
  }
  if (routeParams === undefined) return null;
  const params = new Map<string, string>();
  for (const [name, value] of Object.entries(routeParams)) {
    if (typeof value === "string") params.set(name, value);
  }
  if (params.size === 0) return null;
  const result = parseProviderImportParams(params);
  return result.ok ? { payload: result.payload } : { error: result.error };
};

/** Re-exported for the screen's params fallback. */
export { readProviderImportParamsText };
