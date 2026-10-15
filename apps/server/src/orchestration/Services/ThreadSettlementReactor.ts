/**
 * ThreadSettlementReactor - Settled-thread cleanup reactor service interface.
 *
 * Owns a background worker that reacts to thread.settled domain events and
 * performs best-effort cleanup: closing idle terminals and running the
 * project's settle script inside the thread's worktree.
 *
 * @module ThreadSettlementReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ThreadSettlementReactorShape {
  /**
   * Start reacting to thread.settled orchestration domain events.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

export class ThreadSettlementReactor extends Context.Service<
  ThreadSettlementReactor,
  ThreadSettlementReactorShape
>()("codework/orchestration/Services/ThreadSettlementReactor") {}
