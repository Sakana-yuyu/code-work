import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * First-party subscription quota as pushed by the provider CLIs themselves
 * (Codex `account/rateLimits/updated`, Claude `rate_limit_event`) and relayed
 * through `account.rate-limits.updated` runtime events. Read-only projection:
 * no credentials are read and no billing API is called — the result is exactly
 * what the CLI reported while a thread was running, so it is absent until a
 * provider that publishes limits has run at least one turn.
 */
export const AccountQuotaWindowStatus = Schema.Literals(["ok", "warning", "exhausted", "unknown"]);
export type AccountQuotaWindowStatus = typeof AccountQuotaWindowStatus.Type;

export const AccountQuotaWindow = Schema.Struct({
  /** Stable window key, e.g. `primary`/`secondary` or `five_hour`/`seven_day`. */
  id: Schema.String,
  /** Human label resolved server-side, e.g. "5 小时"/"7 天". */
  label: Schema.String,
  usedFraction: Schema.optional(Schema.Number),
  resetsAt: Schema.optional(Schema.String),
  /**
   * Length of the rolling window in minutes when the provider reports it
   * (Codex does, Claude does not). Clients derive the "even pace" marker from
   * `resetsAt - windowDurationMins`; absent means no pace hint.
   */
  windowDurationMins: Schema.optional(NonNegativeInt),
  status: AccountQuotaWindowStatus,
});
export type AccountQuotaWindow = typeof AccountQuotaWindow.Type;

export const AccountQuotaProviderState = Schema.Struct({
  provider: ProviderDriverKind,
  /**
   * Configured instance whose account produced these windows when the runtime
   * event carried one. Two instances of one driver are two accounts; absent
   * on older payloads means "the driver's default account".
   */
  providerInstanceId: Schema.optional(ProviderInstanceId),
  planName: Schema.optional(Schema.String),
  windows: Schema.Array(AccountQuotaWindow),
  updatedAtUnixMs: NonNegativeInt,
});
export type AccountQuotaProviderState = typeof AccountQuotaProviderState.Type;

export const AccountQuotaRequest = Schema.Struct({});
export type AccountQuotaRequest = typeof AccountQuotaRequest.Type;

export const AccountQuotaResult = Schema.Struct({
  generatedAtUnixMs: NonNegativeInt,
  providers: Schema.Array(AccountQuotaProviderState),
});
export type AccountQuotaResult = typeof AccountQuotaResult.Type;
