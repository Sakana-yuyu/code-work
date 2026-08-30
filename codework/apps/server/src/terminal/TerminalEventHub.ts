import type { TerminalEvent } from "@codework/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";

type TerminalEventQueueItem =
  | { readonly type: "event"; readonly event: TerminalEvent }
  | {
      readonly type: "barrier";
      readonly run: Effect.Effect<void>;
      readonly completed: Deferred.Deferred<void>;
    };

export interface TerminalEventOverflow {
  readonly eventType:
    | TerminalEvent["type"]
    | "attach-barrier"
    | "lifecycle-barrier"
    | "metadata-barrier";
  readonly threadId: string | null;
  readonly terminalId: string | null;
}

export interface TerminalEventSubscriptionOptions {
  readonly acceptsEvent?: (event: TerminalEvent) => boolean;
  readonly queueCapacity?: number | "unbounded";
  readonly startPaused?: boolean;
}

export interface TerminalEventSubscription {
  readonly unsubscribe: () => void;
  readonly runAfterPendingEvents: (
    effect: Effect.Effect<void>,
    overflow: TerminalEventOverflow,
  ) => Effect.Effect<void>;
}

interface TerminalEventSubscriptionState {
  readonly queue: Queue.Queue<TerminalEventQueueItem>;
  readonly acceptsEvent: (event: TerminalEvent) => boolean;
  readonly queueCapacity: number | null;
  readonly startGate: Deferred.Deferred<void>;
  readonly pendingBarriers: Set<Deferred.Deferred<void>>;
  worker: Fiber.Fiber<void, never> | null;
  closed: boolean;
}

export const make = Effect.fn("TerminalEventHub.make")(function* (defaultQueueCapacity: number) {
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const workerScope = yield* Scope.make("sequential");
  const subscriptions = new Set<TerminalEventSubscriptionState>();
  let closed = false;

  const disconnect = (
    subscription: TerminalEventSubscriptionState,
    overflow?: TerminalEventOverflow,
  ) => {
    if (subscription.closed) return;
    subscription.closed = true;
    subscriptions.delete(subscription);
    for (const pendingBarrier of subscription.pendingBarriers) {
      Deferred.doneUnsafe(pendingBarrier, Effect.interrupt);
    }
    subscription.pendingBarriers.clear();

    const cleanup = Queue.shutdown(subscription.queue).pipe(
      Effect.andThen(subscription.worker ? Fiber.interrupt(subscription.worker) : Effect.void),
    );
    runFork(
      overflow
        ? Effect.logWarning("terminal event subscriber queue overflow", {
            eventType: overflow.eventType,
            threadId: overflow.threadId,
            terminalId: overflow.terminalId,
            capacity: subscription.queueCapacity,
          }).pipe(Effect.ensuring(cleanup))
        : cleanup,
    );
  };

  const publish = (event: TerminalEvent) =>
    Effect.sync(() => {
      if (closed) return;
      for (const subscription of subscriptions) {
        if (!subscription.acceptsEvent(event)) continue;
        if (!Queue.offerUnsafe(subscription.queue, { type: "event", event })) {
          disconnect(subscription, {
            eventType: event.type,
            threadId: event.threadId,
            terminalId: event.terminalId,
          });
        }
      }
    });

  const subscribe = Effect.fn("TerminalEventHub.subscribe")(function* (
    listener: (event: TerminalEvent) => Effect.Effect<void>,
    options: TerminalEventSubscriptionOptions = {},
  ): Effect.fn.Return<TerminalEventSubscription> {
    if (closed) return yield* Effect.interrupt;
    const queueCapacity = options.queueCapacity ?? defaultQueueCapacity;
    const queue =
      queueCapacity === "unbounded"
        ? yield* Queue.unbounded<TerminalEventQueueItem>()
        : yield* Queue.bounded<TerminalEventQueueItem>(queueCapacity);
    const startGate = yield* Deferred.make<void>();
    const subscription: TerminalEventSubscriptionState = {
      queue,
      acceptsEvent: options.acceptsEvent ?? (() => true),
      queueCapacity: queueCapacity === "unbounded" ? null : queueCapacity,
      startGate,
      pendingBarriers: new Set(),
      worker: null,
      closed: false,
    };

    const worker = yield* Deferred.await(startGate).pipe(
      Effect.andThen(
        Effect.forever(
          Queue.take(queue).pipe(
            Effect.flatMap((item) => {
              if (item.type === "barrier") {
                return Effect.uninterruptibleMask((restore) =>
                  restore(item.run).pipe(
                    Effect.exit,
                    Effect.flatMap((exit) =>
                      Deferred.done(item.completed, exit).pipe(
                        Effect.andThen(
                          Effect.sync(() => {
                            subscription.pendingBarriers.delete(item.completed);
                          }),
                        ),
                        Effect.andThen(
                          Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
                            ? Effect.failCause(exit.cause)
                            : Effect.void,
                        ),
                      ),
                    ),
                  ),
                );
              }

              return listener(item.event).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : Effect.logError("terminal event listener failed", {
                        cause,
                        eventType: item.event.type,
                        threadId: item.event.threadId,
                        terminalId: item.event.terminalId,
                      }),
                ),
              );
            }),
          ),
        ),
      ),
      Effect.forkIn(workerScope),
    );
    subscription.worker = worker;
    if (closed) {
      yield* Queue.shutdown(queue);
      yield* Fiber.interrupt(worker);
      return yield* Effect.interrupt;
    }
    subscriptions.add(subscription);
    if (options.startPaused !== true) {
      Deferred.doneUnsafe(startGate, Effect.void);
    }

    const runAfterPendingEvents = (effect: Effect.Effect<void>, overflow: TerminalEventOverflow) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const completed = yield* Deferred.make<void>();
          const offered = yield* Effect.sync(() => {
            if (subscription.closed) return false;
            subscription.pendingBarriers.add(completed);
            if (Queue.offerUnsafe(queue, { type: "barrier", run: effect, completed })) {
              return true;
            }
            subscription.pendingBarriers.delete(completed);
            return false;
          });
          if (!offered) {
            disconnect(subscription, overflow);
            return yield* Effect.interrupt;
          }

          Deferred.doneUnsafe(startGate, Effect.void);
          return yield* restore(Deferred.await(completed)).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                subscription.pendingBarriers.delete(completed);
              }),
            ),
          );
        }),
      );

    return {
      unsubscribe: () => disconnect(subscription),
      runAfterPendingEvents,
    };
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
      for (const subscription of subscriptions) {
        subscription.closed = true;
        for (const pendingBarrier of subscription.pendingBarriers) {
          Deferred.doneUnsafe(pendingBarrier, Effect.interrupt);
        }
        subscription.pendingBarriers.clear();
      }
      subscriptions.clear();
    }).pipe(Effect.andThen(Scope.close(workerScope, Exit.void))),
  );

  return { publish, subscribe };
});
