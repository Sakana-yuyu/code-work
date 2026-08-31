import * as Schema from "effect/Schema";

import {
  CompositionRunStartCancellationSourceState,
  CompositionRunStartCancellationStartOutcome,
  CompositionRunStartCancellationTerminalStatus,
  CompositionRunStartState,
  type CompositionRunStartIntent,
} from "../Services/CompositionRunStartStore.ts";

export const RunStartRowSchema = Schema.Struct({
  runId: Schema.String,
  taskId: Schema.String,
  previousRunId: Schema.NullOr(Schema.String),
  agentId: Schema.String,
  runtimeId: Schema.String,
  attempt: Schema.Number,
  payloadDigest: Schema.String,
  capabilityDigest: Schema.String,
  state: CompositionRunStartState,
  revision: Schema.Number,
  claimId: Schema.NullOr(Schema.String),
  ownerEpoch: Schema.Number,
  ownerLeaseExpiresAtUnixMs: Schema.NullOr(Schema.Number),
  runtimeTaskId: Schema.NullOr(Schema.String),
  capabilityHandshakeId: Schema.NullOr(Schema.String),
  outcomeCode: Schema.NullOr(Schema.String),
  outcomeDetail: Schema.NullOr(Schema.String),
  cancelRequestedAtUnixMs: Schema.optional(Schema.NullOr(Schema.Number)),
  cancelReason: Schema.optional(Schema.NullOr(Schema.String)),
  cancelSourceState: Schema.optional(Schema.NullOr(CompositionRunStartCancellationSourceState)),
  cancelSourceRevision: Schema.optional(Schema.NullOr(Schema.Number)),
  cancelSourceClaimId: Schema.optional(Schema.NullOr(Schema.String)),
  cancelSourceOwnerEpoch: Schema.optional(Schema.NullOr(Schema.Number)),
  cancelStartOutcome: Schema.optional(Schema.NullOr(CompositionRunStartCancellationStartOutcome)),
  cancelTerminalStatus: Schema.optional(
    Schema.NullOr(CompositionRunStartCancellationTerminalStatus),
  ),
  cancelTerminalSourceEventId: Schema.optional(Schema.NullOr(Schema.String)),
  cancelTerminalObservedAtUnixMs: Schema.optional(Schema.NullOr(Schema.Number)),
  createdAtUnixMs: Schema.Number,
  updatedAtUnixMs: Schema.Number,
});
export type RunStartRow = typeof RunStartRowSchema.Type;

export const toCompositionRunStartIntent = (row: RunStartRow): CompositionRunStartIntent => ({
  ...row,
  cancelRequestedAtUnixMs: row.cancelRequestedAtUnixMs ?? null,
  cancelReason: row.cancelReason ?? null,
  cancelSourceState: row.cancelSourceState ?? null,
  cancelSourceRevision: row.cancelSourceRevision ?? null,
  cancelSourceClaimId: row.cancelSourceClaimId ?? null,
  cancelSourceOwnerEpoch: row.cancelSourceOwnerEpoch ?? null,
  cancelStartOutcome: row.cancelStartOutcome ?? null,
  cancelTerminalStatus: row.cancelTerminalStatus ?? null,
  cancelTerminalSourceEventId: row.cancelTerminalSourceEventId ?? null,
  cancelTerminalObservedAtUnixMs: row.cancelTerminalObservedAtUnixMs ?? null,
});
