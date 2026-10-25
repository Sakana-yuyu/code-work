import * as Schema from "effect/Schema";

import {
  ForwardCompatibleUnion,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const ThreadGoalStatus = Schema.Literals([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);
export type ThreadGoalStatus = typeof ThreadGoalStatus.Type;

export const ThreadGoalId = TrimmedNonEmptyString.pipe(Schema.brand("ThreadGoalId"));
export type ThreadGoalId = typeof ThreadGoalId.Type;

export const ThreadGoalObjective = TrimmedNonEmptyString.check(
  Schema.isMaxLength(4_000),
  Schema.makeFilter((value) => {
    for (const character of value) {
      const code = character.charCodeAt(0);
      if (code <= 31 || code === 127) return false;
    }
    return true;
  }),
);

export const ThreadGoal = Schema.Struct({
  threadId: ThreadId,
  goalId: ThreadGoalId,
  objective: ThreadGoalObjective,
  status: ThreadGoalStatus,
  createdAt: NonNegativeInt,
  updatedAt: NonNegativeInt,
  timeUsedSeconds: NonNegativeInt,
  tokenBudget: Schema.NullOr(NonNegativeInt),
  tokensUsed: NonNegativeInt,
  /**
   * True when a provider-native `/goal` (Codex/Claude) owns this goal's
   * state and Code Work only mirrors the provider's reports. Own-loop
   * mechanisms (goal marker instructions, send/interrupt status syncs) must
   * not drive these goals.
   */
  providerNative: Schema.optionalKey(Schema.Boolean),
});
export type ThreadGoal = typeof ThreadGoal.Type;

export const ThreadGoalSetInput = Schema.Struct({
  threadId: ThreadId,
  objective: ThreadGoalObjective,
  tokenBudget: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
});
export type ThreadGoalSetInput = typeof ThreadGoalSetInput.Type;

export const ThreadGoalGetInput = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadGoalGetInput = typeof ThreadGoalGetInput.Type;

export const ThreadGoalPauseInput = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadGoalPauseInput = typeof ThreadGoalPauseInput.Type;

export const ThreadGoalResumeInput = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadGoalResumeInput = typeof ThreadGoalResumeInput.Type;

export const ThreadGoalClearInput = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadGoalClearInput = typeof ThreadGoalClearInput.Type;

export const ThreadGoalClearedEvent = Schema.Struct({
  type: Schema.Literal("cleared"),
  threadId: ThreadId,
  goalId: ThreadGoalId,
  clearedAt: NonNegativeInt,
});
export type ThreadGoalClearedEvent = typeof ThreadGoalClearedEvent.Type;

export const ThreadGoalUpdatedEvent = Schema.Struct({
  type: Schema.Literal("updated"),
  goal: ThreadGoal,
});
export type ThreadGoalUpdatedEvent = typeof ThreadGoalUpdatedEvent.Type;

export const ThreadGoalEvent = Schema.Union([ThreadGoalUpdatedEvent, ThreadGoalClearedEvent]);
export type ThreadGoalEvent = typeof ThreadGoalEvent.Type;

// Server→client wire shape: a `type` member this build does not know decodes to
// UnknownUnionMember (skipped by the consumer) instead of failing the stream.
export const ThreadGoalEventWire = ForwardCompatibleUnion(ThreadGoalEvent.members, "type");
export type ThreadGoalEventWire = typeof ThreadGoalEventWire.Type;

export const ThreadGoalErrorCode = Schema.Literals([
  "thread-not-found",
  "goal-not-found",
  "invalid-input",
  "invalid-transition",
  "persistence-failed",
  "stale-version",
]);
export type ThreadGoalErrorCode = typeof ThreadGoalErrorCode.Type;

export class ThreadGoalRpcError extends Schema.TaggedError<ThreadGoalRpcError>()(
  "ThreadGoalRpcError",
  {
    code: ThreadGoalErrorCode,
    message: TrimmedNonEmptyString,
  },
) {}
