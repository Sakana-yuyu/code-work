const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const SENSITIVE_QUERY_SEGMENTS = new Set([
  "access",
  "auth",
  "authorization",
  "bearer",
  "credential",
  "key",
  "password",
  "passwd",
  "private",
  "secret",
  "sig",
  "signature",
  "token",
]);
const SENSITIVE_COMPACT_QUERY_NAME =
  /^(?:(?:access|api|auth|bearer|client|id|private|refresh|secret|session|x))*(?:accesskey|apikey|credential|key|password|passwd|secret|sig|signature|token)$/u;

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

const isSensitiveQueryName = (name: string): boolean => {
  const normalized = name.trim().toLowerCase();
  const segments = normalized.split(/[^a-z0-9]+/u).filter((segment) => segment.length > 0);
  return (
    segments.some((segment) => SENSITIVE_QUERY_SEGMENTS.has(segment)) ||
    SENSITIVE_COMPACT_QUERY_NAME.test(segments.join(""))
  );
};

export const isSafeMulticaRuntimeBaseUrl = (value: string): boolean => {
  const url = parseHttpUrl(value);
  return (
    url !== null && !hasEmbeddedCredentials(url) && url.search.length === 0 && url.hash.length === 0
  );
};

export const isSafeMulticaTaskMcpEndpoint = (value: string): boolean => {
  const url = parseHttpUrl(value);
  if (url === null || hasEmbeddedCredentials(url) || url.hash.length > 0) return false;
  return Array.from(url.searchParams.keys()).every((name) => !isSensitiveQueryName(name));
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
