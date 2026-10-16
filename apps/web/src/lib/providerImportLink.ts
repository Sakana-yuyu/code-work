import {
  parseProviderImportFragment,
  parseProviderImportLink,
  type ProviderImportParseError,
  type ProviderImportPayload,
} from "@codework/shared/providerImport";
import { PRODUCT_IDENTITY } from "@codework/shared/productIdentity";

/**
 * A BYOK provider import request waiting for confirmation. `error` carries
 * the parse failure for links that were addressed to us but malformed.
 */
export interface ProviderImportRequest {
  readonly payload?: ProviderImportPayload;
  readonly error?: ProviderImportParseError;
}

/**
 * App schemes a provider-import deep link may arrive under: the current
 * stage's canonical scheme, the sibling stage schemes (a link opened from a
 * site never knows which build is installed), and the legacy t3code aliases.
 */
export const PROVIDER_IMPORT_SCHEMES: ReadonlyArray<string> = [
  ...Object.values(PRODUCT_IDENTITY.schemes),
  ...PRODUCT_IDENTITY.legacySchemes,
];

let pendingRequest: ProviderImportRequest | null = null;
const listeners = new Set<(request: ProviderImportRequest) => void>();

const publish = (request: ProviderImportRequest) => {
  pendingRequest = request;
  for (const listener of listeners) listener(request);
};

export const subscribeProviderImportRequests = (
  listener: (request: ProviderImportRequest) => void,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The request a route mounts to, or null. Consuming clears it. */
export const consumeProviderImportRequest = (): ProviderImportRequest | null => {
  const request = pendingRequest;
  pendingRequest = null;
  return request;
};

/**
 * A `codework://provider/import?…` deep link from the desktop shell (or a
 * mobile handoff page). Returns true when the link was addressed to the
 * provider-import target — parse failures still publish so the dialog can
 * say the link was invalid instead of doing nothing.
 */
export const openProviderImportLink = (link: string): boolean => {
  const result = parseProviderImportLink(link, PROVIDER_IMPORT_SCHEMES);
  if (
    !result.ok &&
    result.error === "invalid-link" &&
    // Only provider/import links belong to us; other codework:// paths are
    // not import requests at all.
    !isProviderImportTarget(link)
  ) {
    return false;
  }
  publish(result.ok ? { payload: result.payload } : { error: result.error });
  return true;
};

const isProviderImportTarget = (link: string): boolean => {
  try {
    const url = new URL(link.trim());
    return (
      PROVIDER_IMPORT_SCHEMES.includes(url.protocol.replace(/:$/, "")) &&
      url.host === "provider" &&
      url.pathname === "/import"
    );
  } catch {
    return false;
  }
};

/**
 * The hosted-page variant: the import fields sit after `#` so the browser
 * never sends the key to the page's origin. Reading the fragment also
 * strips it from the address bar so the key does not linger there.
 */
export const openProviderImportFragment = (fragment: string): ProviderImportRequest => {
  const result = parseProviderImportFragment(fragment);
  const request: ProviderImportRequest = result.ok
    ? { payload: result.payload }
    : { error: result.error };
  publish(request);
  return request;
};
