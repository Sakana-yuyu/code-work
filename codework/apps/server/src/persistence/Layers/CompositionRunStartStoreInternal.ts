import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CompositionRunStartIntent as CompositionRunStartIntentSchema,
  CompositionRunStartReplayPolicy,
  CompositionRunStartState,
  CompositionRunStartStoreDomainError,
  type CompositionRunStartAcceptedInput,
  type CompositionRunStartClaimInput,
  type CompositionRunStartIdentity,
  type CompositionRunStartIndeterminateInput,
  type CompositionRunStartIntent,
  type CompositionRunStartPrepareInput,
  type CompositionRunStartReleaseInput,
  type CompositionRunStartSettleInput,
  type CompositionRunStartStoreErrorCode,
} from "../Services/CompositionRunStartStore.ts";

export const RunStartRowSchema = Schema.Struct({
  runId: Schema.String,
  taskId: Schema.String,
  agentId: Schema.String,
  runtimeId: Schema.String,
  attempt: Schema.Number,
  replayPolicy: CompositionRunStartReplayPolicy,
  payloadDigest: Schema.String,
  capabilityDigest: Schema.String,
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
export type RunStartRow = typeof RunStartRowSchema.Type;

export const PrepareSchema = Schema.Struct({
  runId: Schema.String,
  taskId: Schema.String,
  agentId: Schema.String,
  runtimeId: Schema.String,
  attempt: Schema.Number,
  replayPolicy: CompositionRunStartReplayPolicy,
  payloadDigest: Schema.String,
  capabilityDigest: Schema.String,
  createdAtUnixMs: Schema.Number,
});
export const IdSchema = Schema.Struct({ runId: Schema.String });
export const TaskAttemptSchema = Schema.Struct({ taskId: Schema.String, attempt: Schema.Number });
export const ClaimIdSchema = Schema.Struct({ claimId: Schema.String });
export const RuntimeTaskSchema = Schema.Struct({
  runtimeId: Schema.String,
  runtimeTaskId: Schema.String,
});
export const ClaimSchema = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  claimId: Schema.String,
  claimedAtUnixMs: Schema.Number,
});
export const ReleaseSchema = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  claimId: Schema.String,
  releasedAtUnixMs: Schema.Number,
});
export const AcceptedSchema = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  claimId: Schema.String,
  runtimeTaskId: Schema.NullOr(Schema.String),
  capabilityHandshakeId: Schema.NullOr(Schema.String),
  acceptedAtUnixMs: Schema.Number,
});
export const IndeterminateSchema = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  claimId: Schema.String,
  outcomeCode: Schema.String,
  indeterminateAtUnixMs: Schema.Number,
});
export const SettleSchema = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  settledAtUnixMs: Schema.Number,
});

export const decodeRunStartIntent = Schema.decodeUnknownEffect(CompositionRunStartIntentSchema);

export const sameRunStartIdentity = (
  left: CompositionRunStartIdentity,
  right: CompositionRunStartIdentity,
): boolean =>
  left.runId === right.runId &&
  left.taskId === right.taskId &&
  left.agentId === right.agentId &&
  left.runtimeId === right.runtimeId &&
  left.attempt === right.attempt &&
  left.replayPolicy === right.replayPolicy &&
  left.payloadDigest === right.payloadDigest &&
  left.capabilityDigest === right.capabilityDigest;

export const runStartDomainError = (
  code: CompositionRunStartStoreErrorCode,
  detail: string,
  metadata: {
    readonly runId?: string;
    readonly expectedRevision?: number;
    readonly actualRevision?: number;
    readonly expectedState?: string;
    readonly actualState?: CompositionRunStartIntent["state"];
  } = {},
): CompositionRunStartStoreDomainError =>
  new CompositionRunStartStoreDomainError({ code, detail, ...metadata });

const hasTextWithin = (value: string, maxLength: number): boolean =>
  value.trim().length > 0 && value.length <= maxLength;
const validTimestamp = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const validRevision = (value: number): boolean => Number.isSafeInteger(value) && value >= 1;

export const validateRunStartPrepare = (input: CompositionRunStartPrepareInput) => {
  const valid =
    hasTextWithin(input.runId, 512) &&
    hasTextWithin(input.taskId, 512) &&
    hasTextWithin(input.agentId, 512) &&
    hasTextWithin(input.runtimeId, 512) &&
    Number.isSafeInteger(input.attempt) &&
    input.attempt > 0 &&
    hasTextWithin(input.payloadDigest, 512) &&
    hasTextWithin(input.capabilityDigest, 512) &&
    validTimestamp(input.createdAtUnixMs);
  return valid
    ? Effect.succeed(input)
    : Effect.fail(
        runStartDomainError("run_start_input_invalid", "Run Start 身份、摘要或创建时间无效。", {
          runId: input.runId,
        }),
      );
};

export const validateRunStartClaim = (input: CompositionRunStartClaimInput) =>
  hasTextWithin(input.runId, 512) &&
  validRevision(input.expectedRevision) &&
  hasTextWithin(input.claimId, 512) &&
  validTimestamp(input.claimedAtUnixMs)
    ? Effect.succeed(input)
    : Effect.fail(
        runStartDomainError(
          "run_start_input_invalid",
          "Run Start claim 身份、revision 或时间无效。",
          { runId: input.runId, expectedRevision: input.expectedRevision },
        ),
      );

export const validateRunStartRelease = (input: CompositionRunStartReleaseInput) =>
  hasTextWithin(input.runId, 512) &&
  validRevision(input.expectedRevision) &&
  hasTextWithin(input.claimId, 512) &&
  validTimestamp(input.releasedAtUnixMs)
    ? Effect.succeed(input)
    : Effect.fail(
        runStartDomainError(
          "run_start_input_invalid",
          "Run Start release 身份、revision 或时间无效。",
          { runId: input.runId, expectedRevision: input.expectedRevision },
        ),
      );

export const validateRunStartAccepted = (input: CompositionRunStartAcceptedInput) =>
  hasTextWithin(input.runId, 512) &&
  validRevision(input.expectedRevision) &&
  hasTextWithin(input.claimId, 512) &&
  (input.runtimeTaskId === undefined || hasTextWithin(input.runtimeTaskId, 2048)) &&
  (input.capabilityHandshakeId === undefined || hasTextWithin(input.capabilityHandshakeId, 2048)) &&
  validTimestamp(input.acceptedAtUnixMs)
    ? Effect.succeed(input)
    : Effect.fail(
        runStartDomainError("run_start_input_invalid", "Run Start accepted receipt 无效。", {
          runId: input.runId,
          expectedRevision: input.expectedRevision,
        }),
      );

export const validateRunStartIndeterminate = (input: CompositionRunStartIndeterminateInput) =>
  hasTextWithin(input.runId, 512) &&
  validRevision(input.expectedRevision) &&
  hasTextWithin(input.claimId, 512) &&
  hasTextWithin(input.outcomeCode, 128) &&
  validTimestamp(input.indeterminateAtUnixMs)
    ? Effect.succeed(input)
    : Effect.fail(
        runStartDomainError(
          "run_start_input_invalid",
          "Run Start indeterminate 结果码或时间无效。",
          { runId: input.runId, expectedRevision: input.expectedRevision },
        ),
      );

export const validateRunStartSettle = (input: CompositionRunStartSettleInput) =>
  hasTextWithin(input.runId, 512) &&
  validRevision(input.expectedRevision) &&
  validTimestamp(input.settledAtUnixMs)
    ? Effect.succeed(input)
    : Effect.fail(
        runStartDomainError("run_start_input_invalid", "Run Start settle revision 或时间无效。", {
          runId: input.runId,
          expectedRevision: input.expectedRevision,
        }),
      );

export const runStartRevisionConflict = (
  intent: CompositionRunStartIntent,
  expectedRevision: number,
) =>
  runStartDomainError("run_start_revision_conflict", "Run Start revision 已被其他操作推进。", {
    runId: intent.runId,
    expectedRevision,
    actualRevision: intent.revision,
    actualState: intent.state,
  });

export const runStartStateConflict = (intent: CompositionRunStartIntent, expectedState: string) =>
  runStartDomainError("run_start_state_conflict", "Run Start 状态不允许当前操作。", {
    runId: intent.runId,
    expectedState,
    actualState: intent.state,
    actualRevision: intent.revision,
  });

export const runStartClaimConflict = (intent: CompositionRunStartIntent) =>
  runStartDomainError("run_start_claim_conflict", "Run Start claim 属于其他 owner。", {
    runId: intent.runId,
    actualState: intent.state,
    actualRevision: intent.revision,
  });

export const runStartTimestampConflict = (intent: CompositionRunStartIntent) =>
  runStartDomainError("run_start_timestamp_conflict", "Run Start 操作时间早于已持久化状态。", {
    runId: intent.runId,
    actualState: intent.state,
    actualRevision: intent.revision,
  });
