import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const CompositionGoalLoopRetryPhase = Schema.Literals(["prepared", "settled", "dispatched"]);
export type CompositionGoalLoopRetryPhase = typeof CompositionGoalLoopRetryPhase.Type;

export const CompositionGoalLoopRetryIntent = Schema.Struct({
  taskId: Schema.String,
  previousRunId: Schema.String,
  newRunId: Schema.String,
  phase: CompositionGoalLoopRetryPhase,
  revision: Schema.Number,
  createdAtUnixMs: Schema.Number,
  updatedAtUnixMs: Schema.Number,
});
export type CompositionGoalLoopRetryIntent = typeof CompositionGoalLoopRetryIntent.Type;

export const CompositionGoalLoopRetryStoreErrorCode = Schema.Literals([
  "goal_loop_retry_input_invalid",
  "goal_loop_retry_intent_missing",
  "goal_loop_retry_identity_conflict",
  "goal_loop_retry_phase_conflict",
]);
export type CompositionGoalLoopRetryStoreErrorCode =
  typeof CompositionGoalLoopRetryStoreErrorCode.Type;

export class CompositionGoalLoopRetryStoreDomainError extends Schema.TaggedErrorClass<CompositionGoalLoopRetryStoreDomainError>()(
  "CompositionGoalLoopRetryStoreDomainError",
  {
    code: CompositionGoalLoopRetryStoreErrorCode,
    detail: Schema.String,
    previousRunId: Schema.optional(Schema.String),
    newRunId: Schema.optional(Schema.String),
    actualPhase: Schema.optional(CompositionGoalLoopRetryPhase),
  },
) {
  override get message(): string {
    return `Goal Loop retry 持久化失败：${this.code}: ${this.detail}`;
  }
}

export type CompositionGoalLoopRetryStoreError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | CompositionGoalLoopRetryStoreDomainError;

export interface CompositionGoalLoopRetryPrepareInput {
  readonly taskId: string;
  readonly previousRunId: string;
  readonly newRunId: string;
  readonly createdAtUnixMs: number;
}

export interface CompositionGoalLoopRetryAdvanceInput {
  readonly previousRunId: string;
  readonly updatedAtUnixMs: number;
}

export interface CompositionGoalLoopRetryStoreShape {
  readonly prepareIntent: (
    input: CompositionGoalLoopRetryPrepareInput,
  ) => Effect.Effect<CompositionGoalLoopRetryIntent, CompositionGoalLoopRetryStoreError>;
  readonly getIntent: (
    previousRunId: string,
  ) => Effect.Effect<
    Option.Option<CompositionGoalLoopRetryIntent>,
    CompositionGoalLoopRetryStoreError
  >;
  readonly markSettled: (
    input: CompositionGoalLoopRetryAdvanceInput,
  ) => Effect.Effect<CompositionGoalLoopRetryIntent, CompositionGoalLoopRetryStoreError>;
  readonly markDispatched: (
    input: CompositionGoalLoopRetryAdvanceInput,
  ) => Effect.Effect<CompositionGoalLoopRetryIntent, CompositionGoalLoopRetryStoreError>;
}

export class CompositionGoalLoopRetryStore extends Context.Service<
  CompositionGoalLoopRetryStore,
  CompositionGoalLoopRetryStoreShape
>()("codework/persistence/Services/CompositionGoalLoopRetryStore") {}
