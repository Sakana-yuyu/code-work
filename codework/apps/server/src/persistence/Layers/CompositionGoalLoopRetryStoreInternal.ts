import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CompositionGoalLoopRetryIntent as CompositionGoalLoopRetryIntentSchema,
  CompositionGoalLoopRetryPhase,
  CompositionGoalLoopRetryStoreDomainError,
  type CompositionGoalLoopRetryAdvanceInput,
  type CompositionGoalLoopRetryIntent,
  type CompositionGoalLoopRetryPageInput,
  type CompositionGoalLoopRetryPrepareInput,
  type CompositionGoalLoopRetryQuarantineInput,
  type CompositionGoalLoopRetryStoreErrorCode,
} from "../Services/CompositionGoalLoopRetryStore.ts";

export const GoalLoopRetryIntentRowSchema = Schema.Struct({
  taskId: Schema.String,
  previousRunId: Schema.String,
  newRunId: Schema.String,
  phase: CompositionGoalLoopRetryPhase,
  revision: Schema.Number,
  createdAtUnixMs: Schema.Number,
  updatedAtUnixMs: Schema.Number,
  quarantineCode: Schema.NullOr(Schema.String),
  quarantinedAtUnixMs: Schema.NullOr(Schema.Number),
});
export type GoalLoopRetryIntentRow = typeof GoalLoopRetryIntentRowSchema.Type;

export const GoalLoopRetryQuarantineRowSchema = Schema.Struct({
  previousRunId: Schema.String,
  outcomeCode: Schema.String,
  quarantinedAtUnixMs: Schema.Number,
});
export type GoalLoopRetryQuarantineRow = typeof GoalLoopRetryQuarantineRowSchema.Type;

export const decodeGoalLoopRetryIntent = Schema.decodeUnknownEffect(
  CompositionGoalLoopRetryIntentSchema,
);

export const retryDomainError = (
  code: CompositionGoalLoopRetryStoreErrorCode,
  detail: string,
  metadata: {
    readonly previousRunId?: string;
    readonly newRunId?: string;
    readonly expectedRevision?: number;
    readonly actualRevision?: number;
    readonly actualPhase?: CompositionGoalLoopRetryIntent["phase"];
  } = {},
): CompositionGoalLoopRetryStoreDomainError =>
  new CompositionGoalLoopRetryStoreDomainError({ code, detail, ...metadata });

const validText = (value: string, maxLength = 512): boolean =>
  value.trim().length > 0 && value === value.trim() && value.length <= maxLength;

const validTimestamp = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const validRevision = (value: number): boolean => Number.isSafeInteger(value) && value >= 1;

const validOutcomeCode = (value: string): boolean =>
  validText(value, 128) && /^[a-z0-9_.:-]+$/.test(value);

export const validateGoalLoopRetryPrepare = (input: CompositionGoalLoopRetryPrepareInput) =>
  validText(input.taskId) &&
  validText(input.previousRunId) &&
  validText(input.newRunId) &&
  input.previousRunId !== input.newRunId &&
  validTimestamp(input.createdAtUnixMs)
    ? Effect.succeed(input)
    : Effect.fail(
        retryDomainError("goal_loop_retry_input_invalid", "retry 身份或创建时间无效。", {
          previousRunId: input.previousRunId,
          newRunId: input.newRunId,
        }),
      );

export const validateGoalLoopRetryAdvance = (input: CompositionGoalLoopRetryAdvanceInput) =>
  validText(input.previousRunId) &&
  validRevision(input.expectedRevision) &&
  validTimestamp(input.updatedAtUnixMs)
    ? Effect.succeed(input)
    : Effect.fail(
        retryDomainError("goal_loop_retry_input_invalid", "retry 阶段推进参数无效。", {
          previousRunId: input.previousRunId,
          expectedRevision: input.expectedRevision,
        }),
      );

export const validateGoalLoopRetryQuarantine = (input: CompositionGoalLoopRetryQuarantineInput) =>
  validText(input.previousRunId) &&
  validRevision(input.expectedRevision) &&
  validOutcomeCode(input.outcomeCode) &&
  validTimestamp(input.quarantinedAtUnixMs)
    ? Effect.succeed(input)
    : Effect.fail(
        retryDomainError("goal_loop_retry_input_invalid", "retry quarantine 参数无效。", {
          previousRunId: input.previousRunId,
          expectedRevision: input.expectedRevision,
        }),
      );

export const validateGoalLoopRetryPage = (input: CompositionGoalLoopRetryPageInput) => {
  const validAfter =
    input.after === undefined ||
    (validTimestamp(input.after.updatedAtUnixMs) && validText(input.after.previousRunId));
  return Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= 1_000 && validAfter
    ? Effect.succeed(input)
    : Effect.fail(retryDomainError("goal_loop_retry_input_invalid", "retry 恢复分页参数无效。"));
};

export const retryRevisionConflict = (
  intent: CompositionGoalLoopRetryIntent,
  expectedRevision: number,
) =>
  retryDomainError("goal_loop_retry_revision_conflict", "retry revision 已变化。", {
    previousRunId: intent.previousRunId,
    newRunId: intent.newRunId,
    expectedRevision,
    actualRevision: intent.revision,
    actualPhase: intent.phase,
  });

export const retryPhaseConflict = (intent: CompositionGoalLoopRetryIntent, expectedPhase: string) =>
  retryDomainError("goal_loop_retry_phase_conflict", `retry 阶段必须为 ${expectedPhase}。`, {
    previousRunId: intent.previousRunId,
    newRunId: intent.newRunId,
    actualRevision: intent.revision,
    actualPhase: intent.phase,
  });
