import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const CompositionToolInvocationStatus = Schema.Literals([
  "prepared",
  "executing",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
]);
export type CompositionToolInvocationStatus = typeof CompositionToolInvocationStatus.Type;

export const CompositionToolInvocationTerminalStatus = Schema.Literals([
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
]);
export type CompositionToolInvocationTerminalStatus =
  typeof CompositionToolInvocationTerminalStatus.Type;

export const CompositionToolInvocationIdentity = Schema.Struct({
  idempotencyKey: Schema.String,
  taskId: Schema.String,
  runId: Schema.String,
  agentId: Schema.String,
  toolCallId: Schema.String,
  canonicalToolName: Schema.String,
  operation: Schema.String,
  argumentsDigest: Schema.String,
  scopeDigest: Schema.String,
});
export type CompositionToolInvocationIdentity = typeof CompositionToolInvocationIdentity.Type;

export const CompositionToolInvocation = Schema.Struct({
  ...CompositionToolInvocationIdentity.fields,
  status: CompositionToolInvocationStatus,
  revision: Schema.Number,
  outcomeCode: Schema.NullOr(Schema.String),
  createdAtUnixMs: Schema.Number,
  updatedAtUnixMs: Schema.Number,
  claimedAtUnixMs: Schema.NullOr(Schema.Number),
  finishedAtUnixMs: Schema.NullOr(Schema.Number),
});
export type CompositionToolInvocation = typeof CompositionToolInvocation.Type;

export const CompositionToolInvocationStoreErrorCode = Schema.Literals([
  "tool_invocation_not_found",
  "tool_invocation_input_invalid",
  "tool_invocation_identity_conflict",
  "tool_invocation_revision_conflict",
  "tool_invocation_status_conflict",
  "tool_invocation_terminal_conflict",
  "tool_invocation_list_limit_invalid",
]);
export type CompositionToolInvocationStoreErrorCode =
  typeof CompositionToolInvocationStoreErrorCode.Type;

export class CompositionToolInvocationStoreDomainError extends Schema.TaggedErrorClass<CompositionToolInvocationStoreDomainError>()(
  "CompositionToolInvocationStoreDomainError",
  {
    code: CompositionToolInvocationStoreErrorCode,
    detail: Schema.String,
    idempotencyKey: Schema.optional(Schema.String),
    expectedRevision: Schema.optional(Schema.Number),
    actualRevision: Schema.optional(Schema.Number),
    expectedStatus: Schema.optional(Schema.String),
    actualStatus: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Tool Invocation 持久化失败：${this.code}: ${this.detail}`;
  }
}

export type CompositionToolInvocationStoreError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | CompositionToolInvocationStoreDomainError;

export interface CompositionToolInvocationPrepareInput extends CompositionToolInvocationIdentity {
  readonly createdAtUnixMs: number;
}

export interface CompositionToolInvocationClaimInput {
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly claimedAtUnixMs: number;
}

export interface CompositionToolInvocationClaimResult {
  readonly invocation: CompositionToolInvocation;
  readonly claimed: boolean;
}

export interface CompositionToolInvocationTerminalInput {
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly status: CompositionToolInvocationTerminalStatus;
  readonly outcomeCode: string | null;
  readonly finishedAtUnixMs: number;
}

export interface CompositionToolInvocationUnknownListInput {
  readonly limit: number;
}

export interface CompositionToolInvocationStoreShape {
  readonly prepareInvocation: (
    input: CompositionToolInvocationPrepareInput,
  ) => Effect.Effect<CompositionToolInvocation, CompositionToolInvocationStoreError>;
  readonly claimPrepared: (
    input: CompositionToolInvocationClaimInput,
  ) => Effect.Effect<CompositionToolInvocationClaimResult, CompositionToolInvocationStoreError>;
  readonly saveTerminal: (
    input: CompositionToolInvocationTerminalInput,
  ) => Effect.Effect<CompositionToolInvocation, CompositionToolInvocationStoreError>;
  readonly getInvocation: (
    idempotencyKey: string,
  ) => Effect.Effect<Option.Option<CompositionToolInvocation>, CompositionToolInvocationStoreError>;
  readonly listUnknownInvocations: (
    input: CompositionToolInvocationUnknownListInput,
  ) => Effect.Effect<ReadonlyArray<CompositionToolInvocation>, CompositionToolInvocationStoreError>;
}

export class CompositionToolInvocationStore extends Context.Service<
  CompositionToolInvocationStore,
  CompositionToolInvocationStoreShape
>()("codework/persistence/Services/CompositionToolInvocationStore") {}
