import type { CompositionTaskRun } from "@codework/contracts";

export type CompositionFailureCategory =
  | "cancelled"
  | "permission"
  | "configuration"
  | "capacity"
  | "transport"
  | "runtime_offline"
  | "agent"
  | "unknown";

export type CompositionFailureRecovery = "none" | "retry" | "reconnect" | "manual";

export type CompositionFailureDisposition = {
  readonly code: string;
  readonly category: CompositionFailureCategory;
  readonly recovery: CompositionFailureRecovery;
  readonly retryable: boolean;
};

const retryableCapacityCodes: ReadonlySet<string> = new Set([
  "rate_limit",
  "rate_limited",
  "capacity_exceeded",
]);

const retryableTransportCodes: ReadonlySet<string> = new Set([
  "temporary_model_failure",
  "provider_network",
  "provider_server_error",
  "transport_error",
]);

const runtimeOfflineCodes: ReadonlySet<string> = new Set([
  "runtime_offline",
  "provider_offline",
  "runtime_probe_failed",
  "runtime_agent_list_failed",
]);

const normalizeCode = (code: string): string =>
  code
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const containsAny = (code: string, fragments: ReadonlyArray<string>): boolean =>
  fragments.some((fragment) => code.includes(fragment));

const categoryOf = (
  run: Pick<CompositionTaskRun, "status">,
  normalizedCode: string,
): CompositionFailureCategory => {
  if (
    run.status === "cancelled" ||
    containsAny(normalizedCode, ["cancelled", "canceled", "aborted"])
  ) {
    return "cancelled";
  }
  if (runtimeOfflineCodes.has(normalizedCode)) return "runtime_offline";
  if (
    containsAny(normalizedCode, [
      "permission",
      "authorization",
      "unauthorized",
      "unauthenticated",
      "forbidden",
      "insufficient_scope",
      "access_denied",
      "capability_rejected",
      "tool_denied",
    ])
  ) {
    return "permission";
  }
  if (
    normalizedCode.startsWith("agent_") ||
    normalizedCode.startsWith("assignee_") ||
    normalizedCode.startsWith("member_") ||
    normalizedCode.includes("_agent_")
  ) {
    return "agent";
  }
  if (
    containsAny(normalizedCode, [
      "rate_limit",
      "capacity",
      "overloaded",
      "concurrency_limit",
      "thread_busy",
      "quota",
    ])
  ) {
    return "capacity";
  }
  if (
    run.status === "timed_out" ||
    containsAny(normalizedCode, [
      "temporary",
      "network",
      "transport",
      "server_error",
      "socket",
      "connection",
      "timeout",
      "timed_out",
      "rpc_error",
      "http_error",
      "stream_unavailable",
    ])
  ) {
    return "transport";
  }
  if (
    containsAny(normalizedCode, [
      "configuration",
      "config",
      "validation",
      "invalid",
      "missing",
      "required",
      "unsupported",
      "untrusted",
      "disabled",
      "not_found",
      "mismatch",
      "conflict",
      "credential",
    ])
  ) {
    return "configuration";
  }
  return "unknown";
};

export const classifyCompositionFailure = (
  run: Pick<CompositionTaskRun, "status" | "failureCode">,
): CompositionFailureDisposition => {
  const code = run.failureCode?.trim() || run.status;
  const normalizedCode = normalizeCode(code);
  const category = categoryOf(run, normalizedCode);
  const retryable =
    (category === "capacity" && retryableCapacityCodes.has(normalizedCode)) ||
    (category === "transport" && retryableTransportCodes.has(normalizedCode));
  const recovery: CompositionFailureRecovery = retryable
    ? "retry"
    : category === "runtime_offline"
      ? "reconnect"
      : category === "cancelled"
        ? "none"
        : "manual";
  return { code, category, recovery, retryable };
};
