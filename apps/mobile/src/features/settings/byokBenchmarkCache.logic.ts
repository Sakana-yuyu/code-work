import type { ByokModelBenchmarkResult } from "@codework/contracts";

export type MobileByokBenchmarkEntry = {
  readonly fingerprint: string;
  readonly result: ByokModelBenchmarkResult;
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isBenchmarkResult = (value: unknown): value is ByokModelBenchmarkResult => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.adapterId === "string" &&
    typeof result.modelId === "string" &&
    isNonNegativeInteger(result.firstTokenMs) &&
    isNonNegativeInteger(result.firstResponseMs) &&
    isNonNegativeInteger(result.totalMs) &&
    isNonNegativeInteger(result.outputTokens) &&
    isFiniteNumber(result.visibleTokensPerSecond) &&
    isFiniteNumber(result.tokensPerSecond) &&
    (result.tokensEstimated === undefined || typeof result.tokensEstimated === "boolean")
  );
};

export const decodeByokBenchmarkCache = (
  raw: string,
): Readonly<Record<string, MobileByokBenchmarkEntry>> => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries: Record<string, MobileByokBenchmarkEntry> = {};
    for (const [adapterId, value] of Object.entries(parsed)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (typeof record.fingerprint !== "string" || !isBenchmarkResult(record.result)) continue;
      entries[adapterId] = { fingerprint: record.fingerprint, result: record.result };
    }
    return entries;
  } catch {
    return {};
  }
};
