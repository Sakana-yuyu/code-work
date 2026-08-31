import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const CompositionRunStartReplayPolicy = Schema.Literals(["idempotent", "fail_closed"]);
export type CompositionRunStartReplayPolicy = typeof CompositionRunStartReplayPolicy.Type;

export const CompositionRunStartState = Schema.Literals([
  "prepared",
  "dispatching",
  "accepted",
  "completed",
  "indeterminate",
]);
export type CompositionRunStartState = typeof CompositionRunStartState.Type;

export const CompositionRunStartIntent = Schema.Struct({
  runId: Schema.String,
  taskId: Schema.String,
  agentId: Schema.String,
  runtimeId: Schema.String,
  attempt: Schema.Number,
  replayPolicy: CompositionRunStartReplayPolicy,
  state: CompositionRunStartState,
  runtimeTaskId: Schema.optional(Schema.String),
  capabilityHandshakeId: Schema.optional(Schema.String),
  createdAtUnixMs: Schema.Number,
  updatedAtUnixMs: Schema.Number,
});
export type CompositionRunStartIntent = typeof CompositionRunStartIntent.Type;

export const CompositionRunStartStoreErrorCode = Schema.Literals([
  "run_start_input_invalid",
  "run_start_missing",
  "run_start_identity_conflict",
  "run_start_phase_conflict",
  "run_start_in_progress",
]);
export type CompositionRunStartStoreErrorCode = typeof CompositionRunStartStoreErrorCode.Type;

export class CompositionRunStartStoreDomainError extends Schema.TaggedErrorClass<CompositionRunStartStoreDomainError>()(
  "CompositionRunStartStoreDomainError",
  {
    code: CompositionRunStartStoreErrorCode,
    detail: Schema.String,
    runId: Schema.optional(Schema.String),
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

export interface CompositionRunStartPrepareInput {
  readonly runId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly runtimeId: string;
  readonly attempt: number;
  readonly replayPolicy: CompositionRunStartReplayPolicy;
  readonly createdAtUnixMs: number;
}

export interface CompositionRunStartClaimInput {
  readonly runId: string;
  readonly claimId: string;
  readonly claimedAtUnixMs: number;
}

export interface CompositionRunStartReleaseInput {
  readonly runId: string;
  readonly claimId: string;
}

export interface CompositionRunStartAcceptedInput extends CompositionRunStartReleaseInput {
  readonly runtimeTaskId?: string;
  readonly capabilityHandshakeId?: string;
  readonly acceptedAtUnixMs: number;
}

export interface CompositionRunStartCompleteInput {
  readonly runId: string;
  readonly completedAtUnixMs: number;
}

export interface CompositionRunStartRecoveryReceipt {
  readonly type: "composition.run_starts.recovered";
  readonly recoveredAtUnixMs: number;
  readonly recoveredRunIds: ReadonlyArray<string>;
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
  ) => Effect.Effect<CompositionRunStartIntent, CompositionRunStartStoreError>;
  readonly releaseStart: (
    input: CompositionRunStartReleaseInput,
  ) => Effect.Effect<void, CompositionRunStartStoreError>;
  readonly markAccepted: (
    input: CompositionRunStartAcceptedInput,
  ) => Effect.Effect<CompositionRunStartIntent, CompositionRunStartStoreError>;
  readonly markCompleted: (
    input: CompositionRunStartCompleteInput,
  ) => Effect.Effect<CompositionRunStartIntent, CompositionRunStartStoreError>;
  readonly recoverInterruptedStarts: (input: {
    readonly recoveredAtUnixMs: number;
  }) => Effect.Effect<CompositionRunStartRecoveryReceipt, CompositionRunStartStoreError>;
}

export class CompositionRunStartStore extends Context.Service<
  CompositionRunStartStore,
  CompositionRunStartStoreShape
>()("codework/persistence/Services/CompositionRunStartStore") {}
