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
 * resolves its own allowlisted environment variables server-side.
 */
export const ByokDelegationSubmitRequest = Schema.Struct({
  instanceId: TrimmedString,
  task: TrimmedNonEmptyString,
});
export type ByokDelegationSubmitRequest = typeof ByokDelegationSubmitRequest.Type;

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
});
export type ByokDelegationSnapshot = typeof ByokDelegationSnapshot.Type;

export const ByokDelegationListRequest = Schema.Struct({
  instanceId: TrimmedString,
});
export type ByokDelegationListRequest = typeof ByokDelegationListRequest.Type;

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
