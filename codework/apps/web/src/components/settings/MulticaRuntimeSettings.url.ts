import { isMulticaSecretName } from "@codework/contracts";

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

const parseHttpUrl = (value: string): URL | null => {
  try {
    const url = new URL(value.trim());
    return HTTP_PROTOCOLS.has(url.protocol) ? url : null;
  } catch {
    return null;
  }
};

const hasEmbeddedCredentials = (url: URL): boolean =>
  url.username.length > 0 || url.password.length > 0;

export const isSafeMulticaRuntimeBaseUrl = (value: string): boolean => {
  const url = parseHttpUrl(value);
  return (
    url !== null && !hasEmbeddedCredentials(url) && url.search.length === 0 && url.hash.length === 0
  );
};

export const isSafeMulticaTaskMcpEndpoint = (value: string): boolean => {
  const url = parseHttpUrl(value);
  if (url === null || hasEmbeddedCredentials(url) || url.hash.length > 0) return false;
  return Array.from(url.searchParams.keys()).every((name) => !isMulticaSecretName(name));
};

export const safeMulticaRuntimeUrlLabel = (value: string): string | null => {
  const url = parseHttpUrl(value);
  if (url === null) return null;
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
};
