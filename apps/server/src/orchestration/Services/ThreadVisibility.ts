/**
 * ThreadVisibility - Tracks which thread detail views are currently
 * subscribed by connected clients.
 *
 * A lease is held for the lifetime of a `thread.subscribe` stream. The
 * provider session reaper consults it to skip sessions for threads a user
 * is looking at, and the subscription handler uses it to decide when to
 * prewarm a recovered provider session.
 *
 * @module ThreadVisibility
 */
import { ThreadId } from "@codework/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

export interface ThreadVisibilityShape {
  /**
   * Mark a thread as visible for the duration of the ambient scope. Multiple
   * overlapping subscriptions are reference counted; the thread is invisible
   * again once the last lease releases.
   */
  readonly trackViewing: (threadId: ThreadId) => Effect.Effect<void, never, Scope.Scope>;

  readonly isVisible: (threadId: ThreadId) => Effect.Effect<boolean>;

  readonly listVisibleThreadIds: () => Effect.Effect<ReadonlySet<ThreadId>>;
}

export class ThreadVisibility extends Context.Service<ThreadVisibility, ThreadVisibilityShape>()(
  "codework/orchestration/Services/ThreadVisibility",
) {}

export const ThreadVisibilityLive = Layer.sync(ThreadVisibility, () => {
  const viewers = new Map<ThreadId, number>();

  return {
    trackViewing: (threadId) =>
      Effect.acquireRelease(
        Effect.sync(() => viewers.set(threadId, (viewers.get(threadId) ?? 0) + 1)),
        () =>
          Effect.sync(() => {
            const remaining = (viewers.get(threadId) ?? 0) - 1;
            if (remaining > 0) {
              viewers.set(threadId, remaining);
            } else {
              viewers.delete(threadId);
            }
          }),
      ),

    isVisible: (threadId) => Effect.sync(() => viewers.has(threadId)),

    listVisibleThreadIds: () => Effect.sync(() => new Set(viewers.keys())),
  } satisfies ThreadVisibilityShape;
});
