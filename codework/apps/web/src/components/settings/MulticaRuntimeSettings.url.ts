import {
  isSafeMulticaRuntimeBaseUrl,
  isSafeMulticaTaskMcpEndpoint,
} from "@codework/contracts";

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

const parseHttpUrl = (value: string): URL | null => {
  try {
    const url = new URL(value.trim());
    return HTTP_PROTOCOLS.has(url.protocol) ? url : null;
  } catch {
    return null;
  }
};

export { isSafeMulticaRuntimeBaseUrl, isSafeMulticaTaskMcpEndpoint };

export const safeMulticaRuntimeUrlLabel = (value: string): string | null => {
  const url = parseHttpUrl(value);
  if (url === null) return null;
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
};
