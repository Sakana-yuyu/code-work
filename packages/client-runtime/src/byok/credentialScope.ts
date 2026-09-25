import type { ByokModelAdapter } from "@codework/contracts";

type AdapterEndpoint = Pick<ByokModelAdapter, "protocol" | "baseURL" | "supplierID">;

const normalizedBaseURL = (value: string): string | null => {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}${url.pathname.replace(/\/+$/u, "")}${url.search}`;
  } catch {
    return null;
  }
};

/** 只有供应商、协议和目标地址均未变时，编辑表单才可复用服务端保存的密钥。 */
export const canRetainByokAdapterCredentials = (
  existing: AdapterEndpoint | undefined,
  next: AdapterEndpoint,
): boolean => {
  if (existing === undefined) return false;
  const existingURL = normalizedBaseURL(existing.baseURL);
  const nextURL = normalizedBaseURL(next.baseURL);
  return (
    existingURL !== null &&
    existingURL === nextURL &&
    existing.protocol === next.protocol &&
    (existing.supplierID || "custom") === (next.supplierID || "custom")
  );
};
