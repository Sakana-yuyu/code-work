import * as Schema from "effect/Schema";
import { TrimmedString } from "./baseSchemas.ts";

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
