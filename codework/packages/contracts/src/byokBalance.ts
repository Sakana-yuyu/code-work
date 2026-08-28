import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedString } from "./baseSchemas.ts";

/**
 * Balance/usage query for one BYOK model adapter.
 *
 * Like model discovery, the request carries only identifiers — never API keys
 * or balance credentials. The server resolves the adapter's stored key and
 * queries the supplier's billing endpoint itself.
 */
export const ByokBalanceRequest = Schema.Struct({
  instanceId: TrimmedString,
  adapterId: TrimmedString,
  forceRefresh: Schema.optional(Schema.Boolean),
});
export type ByokBalanceRequest = typeof ByokBalanceRequest.Type;

export const ByokBalanceWindow = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  unit: Schema.String,
  used: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
  remaining: Schema.optional(Schema.Number),
  usedFraction: Schema.optional(Schema.Number),
  remainingFraction: Schema.optional(Schema.Number),
  resetsAt: Schema.optional(Schema.String),
  status: Schema.Literals(["ok", "warning", "exhausted", "unknown"]),
});
export type ByokBalanceWindow = typeof ByokBalanceWindow.Type;

/**
 * Normalized balance result. Numeric fields are in the currency named by
 * `currency`; no credential material ever appears here.
 */
export const ByokBalanceResult = Schema.Struct({
  instanceId: TrimmedString,
  adapterId: TrimmedString,
  supported: Schema.Boolean,
  source: Schema.String,
  currency: Schema.String,
  unlimited: Schema.Boolean,
  total: Schema.optional(Schema.Number),
  used: Schema.optional(Schema.Number),
  remaining: Schema.optional(Schema.Number),
  planName: Schema.optional(Schema.String),
  windows: Schema.Array(ByokBalanceWindow),
  fetchedAt: Schema.optional(Schema.String),
  message: Schema.String,
  transient: Schema.Boolean,
  cached: Schema.optional(Schema.Boolean),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.Literals([
        "missing_credentials",
        "unsupported_profile",
        "invalid_endpoint",
        "timeout",
        "response_too_large",
        "redirect_blocked",
        "upstream_http",
        "invalid_payload",
      ]),
      message: Schema.String,
    }),
  ),
});
export type ByokBalanceResult = typeof ByokBalanceResult.Type;

/**
 * Aggregated balance/usage/health dashboard across every configured BYOK
 * provider instance. Like the single-adapter query, the request carries only
 * flags — never credentials.
 */
export const ByokBalanceDashboardRequest = Schema.Struct({
  forceRefresh: Schema.optional(Schema.Boolean),
});
export type ByokBalanceDashboardRequest = typeof ByokBalanceDashboardRequest.Type;

/**
 * Per-adapter health classification. `empty` means the balance query
 * *succeeded* and reported an exhausted balance; `error` means the query
 * itself failed (the failure detail stays on `balance.error`). The two are
 * deliberately distinct states so a failed probe is never presented as an
 * empty wallet.
 */
export const ByokBalanceAdapterHealth = Schema.Literals(["ok", "empty", "unsupported", "error"]);
export type ByokBalanceAdapterHealth = typeof ByokBalanceAdapterHealth.Type;

export const ByokBalanceDashboardAdapter = Schema.Struct({
  adapterId: TrimmedString,
  displayName: Schema.optional(TrimmedString),
  health: ByokBalanceAdapterHealth,
  /** Full normalized balance result, including the error when health is `error`. */
  balance: ByokBalanceResult,
});
export type ByokBalanceDashboardAdapter = typeof ByokBalanceDashboardAdapter.Type;

/**
 * Per-instance aggregate health: `ok` (all queryable adapters healthy),
 * `degraded` (mixed), `failed` (every queryable adapter's query failed),
 * `unsupported` (no adapter supports balance queries), `empty` (no adapters).
 */
export const ByokBalanceInstanceHealth = Schema.Literals([
  "ok",
  "degraded",
  "failed",
  "unsupported",
  "empty",
]);
export type ByokBalanceInstanceHealth = typeof ByokBalanceInstanceHealth.Type;

export const ByokBalanceDashboardInstance = Schema.Struct({
  instanceId: TrimmedString,
  displayName: Schema.optional(TrimmedString),
  enabled: Schema.Boolean,
  health: ByokBalanceInstanceHealth,
  adapters: Schema.Array(ByokBalanceDashboardAdapter),
});
export type ByokBalanceDashboardInstance = typeof ByokBalanceDashboardInstance.Type;

export const ByokBalanceDashboardTotals = Schema.Struct({
  instanceCount: NonNegativeInt,
  adapterCount: NonNegativeInt,
  okCount: NonNegativeInt,
  emptyCount: NonNegativeInt,
  unsupportedCount: NonNegativeInt,
  errorCount: NonNegativeInt,
});
export type ByokBalanceDashboardTotals = typeof ByokBalanceDashboardTotals.Type;

export const ByokBalanceDashboardResult = Schema.Struct({
  generatedAtUnixMs: NonNegativeInt,
  totals: ByokBalanceDashboardTotals,
  instances: Schema.Array(ByokBalanceDashboardInstance),
});
export type ByokBalanceDashboardResult = typeof ByokBalanceDashboardResult.Type;
