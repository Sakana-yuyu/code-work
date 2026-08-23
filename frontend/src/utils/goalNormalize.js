import { asBoolean, asPositiveInteger } from "./valueCast.js";

export function normalizeGoal(source) {
  const raw = source && typeof source === "object" ? source : {};
  const enabled = asBoolean(raw.enabled);
  const hasMaxProviderPasses = Object.prototype.hasOwnProperty.call(raw, "maxProviderPasses");
  const maxCostUsd = typeof raw.maxCostUsd === "number" && Number.isFinite(raw.maxCostUsd) && raw.maxCostUsd >= 0
    ? raw.maxCostUsd
    : 0;
  const rawMaxProviderPasses = raw.maxProviderPasses;
  const explicitUnlimited = rawMaxProviderPasses === 0 || String(rawMaxProviderPasses ?? "").trim() === "0";
  const normalizedMaxProviderPasses = asPositiveInteger(rawMaxProviderPasses);
  return {
    enabled,
    maxProviderPasses: !hasMaxProviderPasses ? 30 : (explicitUnlimited ? 0 : (normalizedMaxProviderPasses || 30)),
    maxDurationSeconds: asPositiveInteger(raw.maxDurationSeconds),
    maxCostUsd,
    selfCheckPasses: asPositiveInteger(raw.selfCheckPasses),
    verifyMaxRetries: asPositiveInteger(raw.verifyMaxRetries),
    errorMaxRetries: asPositiveInteger(raw.errorMaxRetries),
    progressInterval: asPositiveInteger(raw.progressInterval),
  };
}
