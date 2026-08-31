import type {
  ThreadGoal,
  ThreadGoalClearInput,
  ThreadGoalEvent,
  ThreadGoalSetInput,
  ThreadGoalStatus,
} from "@codework/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const ThreadGoalStoreErrorCode = Schema.Literals([
  "thread-not-found",
  "goal-not-found",
  "invalid-input",
  "invalid-transition",
  "persistence-failed",
  "stale-version",
]);
export type ThreadGoalStoreErrorCode = typeof ThreadGoalStoreErrorCode.Type;

export class ThreadGoalStoreDomainError extends Schema.TaggedErrorClass<ThreadGoalStoreDomainError>()(
  "ThreadGoalStoreDomainError",
  {
    code: ThreadGoalStoreErrorCode,
    detail: Schema.String,
    threadId: Schema.String,
    goalId: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Thread Goal 持久化失败：${this.code}: ${this.detail}`;
  }
}

export type ThreadGoalStoreError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | ThreadGoalStoreDomainError;

export interface ThreadGoalStatusUpdateInput {
  readonly threadId: string;
  readonly status: ThreadGoalStatus;
  readonly timeUsedSeconds?: number;
  readonly tokensUsed?: number;
}

export interface ThreadGoalStoreShape {
  readonly get: (
    threadId: string,
  ) => Effect.Effect<Option.Option<ThreadGoal>, ThreadGoalStoreError>;
  readonly set: (input: ThreadGoalSetInput) => Effect.Effect<ThreadGoal, ThreadGoalStoreError>;
  readonly pause: (threadId: string) => Effect.Effect<ThreadGoal, ThreadGoalStoreError>;
  readonly resume: (threadId: string) => Effect.Effect<ThreadGoal, ThreadGoalStoreError>;
  readonly setStatus: (
    input: ThreadGoalStatusUpdateInput,
  ) => Effect.Effect<ThreadGoal, ThreadGoalStoreError>;
  readonly clear: (
    input: ThreadGoalClearInput | string,
  ) => Effect.Effect<Extract<ThreadGoalEvent, { readonly type: "cleared" }>, ThreadGoalStoreError>;
  readonly subscribe: (threadId: string) => Effect.Effect<Stream.Stream<ThreadGoalEvent>, never>;
}

export class ThreadGoalStore extends Context.Service<ThreadGoalStore, ThreadGoalStoreShape>()(
  "codework/persistence/Services/ThreadGoalStore",
) {}
