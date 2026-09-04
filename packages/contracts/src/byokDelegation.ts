import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

export const ByokDelegationStatus = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "queue_timed_out",
  "execution_timed_out",
]);
export type ByokDelegationStatus = typeof ByokDelegationStatus.Type;

/**
 * Submit a delegated task to the configured executor. The task body is plain
 * user text; credentials never travel through this request — the executor
 * resolves its own allowlisted environment variables server-side. The
 * optional subagent type selects a configured role fragment (original
 * subagent_type semantics).
 */
export const ByokDelegationSubmitRequest = Schema.Struct({
  instanceId: TrimmedString,
  // New requests (not persisted state) reject oversized task bodies outright:
  // 50k chars is far beyond any sane delegated task and bounds executor spawn.
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(50_000)),
  subagentType: Schema.optional(TrimmedString),
});
export type ByokDelegationSubmitRequest = typeof ByokDelegationSubmitRequest.Type;

/** Bounded supervision counters surfaced with a snapshot (numbers only). */
export const ByokDelegationSupervisionSummary = Schema.Struct({
  round: Schema.Number,
  corrections: Schema.Number,
  retries: Schema.Number,
  reassigns: Schema.Number,
  escalates: Schema.Number,
});
export type ByokDelegationSupervisionSummary = typeof ByokDelegationSupervisionSummary.Type;

/** One failover attempt against an executor candidate, bounded previews only. */
export const ByokDelegationExecutorAttempt = Schema.Struct({
  executorId: Schema.String,
  status: Schema.Literals(["completed", "failed", "skipped"]),
  diagnosticPreview: Schema.optional(Schema.String),
});
export type ByokDelegationExecutorAttempt = typeof ByokDelegationExecutorAttempt.Type;

/** Result of probing one executor candidate's availability. */
export const ByokDelegationExecutorProbe = Schema.Struct({
  executorId: Schema.String,
  state: Schema.Literals(["ready", "not_installed", "unhealthy", "unknown"]),
  diagnosticCode: Schema.optional(Schema.String),
  diagnosticPreview: Schema.optional(Schema.String),
  probedAt: Schema.Number,
});
export type ByokDelegationExecutorProbe = typeof ByokDelegationExecutorProbe.Type;

/**
 * Public projection of a delegation run. The task preview and result are
 * truncated to bounded lengths; no environment values or credentials appear.
 */
export const ByokDelegationSnapshot = Schema.Struct({
  id: Schema.String,
  status: ByokDelegationStatus,
  taskPreview: Schema.String,
  resultPreview: Schema.optional(Schema.String),
  errorCode: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
  submittedAt: Schema.Number,
  startedAt: Schema.optional(Schema.Number),
  finishedAt: Schema.optional(Schema.Number),
  supervision: Schema.optional(ByokDelegationSupervisionSummary),
  // Failover attempt chain, bounded rows with bounded diagnostics.
  executorAttempts: Schema.optional(Schema.Array(ByokDelegationExecutorAttempt)),
});
export type ByokDelegationSnapshot = typeof ByokDelegationSnapshot.Type;

export const ByokDelegationListRequest = Schema.Struct({
  instanceId: TrimmedString,
});
export type ByokDelegationListRequest = typeof ByokDelegationListRequest.Type;

/**
 * Cancel one delegation run by id. Mirrors the original cursor-byok
 * per-task cancel: the scheduler aborts the executor and the ledger settles
 * into a terminal `cancelled` state.
 */
export const ByokDelegationCancelRequest = Schema.Struct({
  instanceId: TrimmedString,
  delegationId: TrimmedNonEmptyString,
});
export type ByokDelegationCancelRequest = typeof ByokDelegationCancelRequest.Type;

/**
 * YAML import of model adapters from a cursor-byok config export.
 *
 * The YAML text may contain API keys; it is parsed server-side and keys go
 * straight into the secret store via the normal settings write path. The
 * response contains only redacted adapter shells and non-sensitive counts.
 */
export const ByokAdaptersImportRequest = Schema.Struct({
  instanceId: TrimmedString,
  yaml: TrimmedNonEmptyString,
});
export type ByokAdaptersImportRequest = typeof ByokAdaptersImportRequest.Type;

export const ByokAdaptersImportResult = Schema.Struct({
  imported: Schema.Number,
  skipped: Schema.Number,
  skippedReasons: Schema.Array(Schema.String),
  adapters: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      displayName: Schema.String,
      protocol: Schema.Literals(["openai", "anthropic", "gemini"]),
      baseURL: Schema.String,
      modelId: Schema.String,
    }),
  ),
});
export type ByokAdaptersImportResult = typeof ByokAdaptersImportResult.Type;
