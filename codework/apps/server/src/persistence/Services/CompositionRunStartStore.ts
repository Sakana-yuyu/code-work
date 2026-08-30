import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const CompositionRunStartState = Schema.Literals([
  "prepared",
  "preparing",
  "dispatching",
  "accepted",
  "settled",
  "quarantined",
]);
export type CompositionRunStartState = typeof CompositionRunStartState.Type;

export const CompositionRunStartIdentity = Schema.Struct({
  taskId: Schema.String,
  runId: Schema.String,
  previousRunId: Schema.NullOr(Schema.String),
  agentId: Schema.String,
  runtimeId: Schema.String,
  attempt: Schema.Number,
  payloadDigest: Schema.String,
  capabilityDigest: Schema.String,
});
export type CompositionRunStartIdentity = typeof CompositionRunStartIdentity.Type;

export const CompositionRunStartIntent = Schema.Struct({
  ...CompositionRunStartIdentity.fields,
  state: CompositionRunStartState,
  revision: Schema.Number,
  claimId: Schema.NullOr(Schema.String),
  runtimeTaskId: Schema.NullOr(Schema.String),
  capabilityHandshakeId: Schema.NullOr(Schema.String),
  outcomeCode: Schema.NullOr(Schema.String),
  outcomeDetail: Schema.NullOr(Schema.String),
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
  "run_start_list_limit_invalid",
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
    actualState: Schema.optional(Schema.String),
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

export interface CompositionRunStartDispatchInput {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly claimId: string;
  readonly dispatchedAtUnixMs: number;
}

export interface CompositionRunStartAcceptedInput {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly claimId: string;
  readonly runtimeTaskId: string | null;
  readonly capabilityHandshakeId: string | null;
  readonly acceptedAtUnixMs: number;
}

export interface CompositionRunStartSettledInput {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly settledAtUnixMs: number;
}

export interface CompositionRunStartRejectedInput {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly claimId: string;
  readonly outcomeCode: string;
  readonly outcomeDetail: string | null;
  readonly settledAtUnixMs: number;
}

export interface CompositionRunStartQuarantineInput {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly outcomeCode: string;
  readonly outcomeDetail: string | null;
  readonly quarantinedAtUnixMs: number;
}

export interface CompositionRunStartRecoverableListInput {
  readonly limit: number;
}

export interface CompositionRunStartStoreShape {
  readonly prepareStart: (
    input: CompositionRunStartPrepareInput,
  ) => Effect.Effect<CompositionRunStartIntent, CompositionRunStartStoreError>;
  readonly getStart: (
    runId: string,
  ) => Effect.Effect<Option.Option<CompositionRunStartIntent>, CompositionRunStartStoreError>;
  readonly claimPrepared: (
    input: CompositionRunStartClaimInput,
  ) => Effect.Effect<CompositionRunStartClaimResult, CompositionRunStartStoreError>;
  readonly releasePreparation: (
    input: CompositionRunStartReleaseInput,
  ) => Effect.Effect<CompositionRunStartIntent, CompositionRunStartStoreError>;
  readonly resetPreparationForRecovery: (
    input: Omit<CompositionRunStartSettledInput, "settledAtUnixMs"> & {
      readonly resetAtUnixMs: number;
    },
  ) => Effect.Effect<CompositionRunStartIntent, CompositionRunStartStoreError>;
  readonly markDispatching: (
    input: CompositionRunStartDispatchInput,
  ) => Effect.Effect<CompositionRunStartIntent, CompositionRunStartStoreError>;
  readonly claimDispatchRecovery: (
    input: CompositionRunStartClaimInput,
  ) => Effect.Effect<CompositionRunStartClaimResult, CompositionRunStartStoreError>;
  readonly recordAccepted: (
    input: CompositionRunStartAcceptedInput,
  ) => Effect.Effect<CompositionRunStartIntent, CompositionRunStartStoreError>;
  readonly settleAccepted: (
    input: CompositionRunStartSettledInput,
  ) => Effect.Effect<CompositionRunStartIntent, CompositionRunStartStoreError>;
  readonly settleRejected: (
    input: CompositionRunStartRejectedInput,
  ) => Effect.Effect<CompositionRunStartIntent, CompositionRunStartStoreError>;
  readonly quarantine: (
    input: CompositionRunStartQuarantineInput,
  ) => Effect.Effect<CompositionRunStartIntent, CompositionRunStartStoreError>;
  readonly listRecoverable: (
    input: CompositionRunStartRecoverableListInput,
  ) => Effect.Effect<ReadonlyArray<CompositionRunStartIntent>, CompositionRunStartStoreError>;
}

export class CompositionRunStartStore extends Context.Service<
  CompositionRunStartStore,
  CompositionRunStartStoreShape
>()("codework/persistence/Services/CompositionRunStartStore") {}
