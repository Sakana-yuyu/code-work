import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const CompositionRunStartReplayPolicy = Schema.Literals([
  "idempotent",
  "reconcile",
  "fail_closed",
]);
export type CompositionRunStartReplayPolicy = typeof CompositionRunStartReplayPolicy.Type;

export const CompositionRunStartState = Schema.Literals([
  "prepared",
  "dispatching",
  "accepted",
  "settled",
  "indeterminate",
]);
export type CompositionRunStartState = typeof CompositionRunStartState.Type;

export const CompositionRunStartIdentity = Schema.Struct({
  runId: Schema.String,
  taskId: Schema.String,
  agentId: Schema.String,
  runtimeId: Schema.String,
  attempt: Schema.Number,
  replayPolicy: CompositionRunStartReplayPolicy,
  payloadDigest: Schema.String,
  capabilityDigest: Schema.String,
});
export type CompositionRunStartIdentity = typeof CompositionRunStartIdentity.Type;

export const CompositionRunStartIntent = Schema.Struct({
  ...CompositionRunStartIdentity.fields,
  state: CompositionRunStartState,
  revision: Schema.Number,
  claimId: Schema.NullOr(Schema.String),
  claimedAtUnixMs: Schema.NullOr(Schema.Number),
  runtimeTaskId: Schema.NullOr(Schema.String),
  capabilityHandshakeId: Schema.NullOr(Schema.String),
  acceptedAtUnixMs: Schema.NullOr(Schema.Number),
  outcomeCode: Schema.NullOr(Schema.String),
  settledAtUnixMs: Schema.NullOr(Schema.Number),
  createdAtUnixMs: Schema.Number,
  updatedAtUnixMs: Schema.Number,
});
export type CompositionRunStartIntent = typeof CompositionRunStartIntent.Type;

export const CompositionRunStartStoreErrorCode = Schema.Literals([
  "run_start_not_found",
  "run_start_input_invalid",
  "run_start_identity_conflict",
  "run_start_revision_conflict",
  "run_start_state_conflict",
  "run_start_claim_conflict",
  "run_start_receipt_conflict",
  "run_start_timestamp_conflict",
]);
export type CompositionRunStartStoreErrorCode = typeof CompositionRunStartStoreErrorCode.Type;

export class CompositionRunStartStoreDomainError extends Schema.TaggedErrorClass<CompositionRunStartStoreDomainError>()(
  "CompositionRunStartStoreDomainError",
  {
    code: CompositionRunStartStoreErrorCode,
    detail: Schema.String,
    runId: Schema.optional(Schema.String),
    expectedRevision: Schema.optional(Schema.Number),
    actualRevision: Schema.optional(Schema.Number),
    expectedState: Schema.optional(Schema.String),
    actualState: Schema.optional(CompositionRunStartState),
  },
) {
  override get message(): string {
    return `Run Start 持久化失败：${this.code}: ${this.detail}`;
  }
}

export type CompositionRunStartStoreError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | CompositionRunStartStoreDomainError;

export interface CompositionRunStartPrepareInput extends CompositionRunStartIdentity {
  readonly createdAtUnixMs: number;
}

export interface CompositionRunStartClaimInput {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly claimId: string;
  readonly claimedAtUnixMs: number;
}

export interface CompositionRunStartClaimResult {
  readonly intent: CompositionRunStartIntent;
  readonly claimed: boolean;
}

export interface CompositionRunStartReleaseInput {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly claimId: string;
  readonly releasedAtUnixMs: number;
}

export interface CompositionRunStartAcceptedInput {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly claimId: string;
  readonly runtimeTaskId?: string;
  readonly capabilityHandshakeId?: string;
  readonly acceptedAtUnixMs: number;
}

export interface CompositionRunStartIndeterminateInput {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly claimId: string;
  readonly outcomeCode: string;
  readonly indeterminateAtUnixMs: number;
}

export interface CompositionRunStartSettleInput {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly settledAtUnixMs: number;
}

export interface CompositionRunStartStoreShape {
  readonly prepareStart: (
    input: CompositionRunStartPrepareInput,
  ) => Effect.Effect<CompositionRunStartIntent, CompositionRunStartStoreError>;
  readonly getStart: (
    runId: string,
  ) => Effect.Effect<Option.Option<CompositionRunStartIntent>, CompositionRunStartStoreError>;
  readonly claimStart: (
    input: CompositionRunStartClaimInput,
  ) => Effect.Effect<CompositionRunStartClaimResult, CompositionRunStartStoreError>;
  readonly releaseStart: (
    input: CompositionRunStartReleaseInput,
  ) => Effect.Effect<CompositionRunStartIntent, CompositionRunStartStoreError>;
  readonly markAccepted: (
    input: CompositionRunStartAcceptedInput,
  ) => Effect.Effect<CompositionRunStartIntent, CompositionRunStartStoreError>;
  readonly markIndeterminate: (
    input: CompositionRunStartIndeterminateInput,
  ) => Effect.Effect<CompositionRunStartIntent, CompositionRunStartStoreError>;
  readonly settleStart: (
    input: CompositionRunStartSettleInput,
  ) => Effect.Effect<CompositionRunStartIntent, CompositionRunStartStoreError>;
}

export class CompositionRunStartStore extends Context.Service<
  CompositionRunStartStore,
  CompositionRunStartStoreShape
>()("codework/persistence/Services/CompositionRunStartStore") {}
