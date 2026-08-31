import * as Schema from "effect/Schema";

import { CompositionRunStartState } from "../Services/CompositionRunStartStore.ts";

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
  createdAtUnixMs: Schema.Number,
  updatedAtUnixMs: Schema.Number,
});
export type RunStartRow = typeof RunStartRowSchema.Type;
