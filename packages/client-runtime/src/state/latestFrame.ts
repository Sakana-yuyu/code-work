import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

const waitForHostFrame = Effect.suspend(() => {
  if (typeof globalThis.requestAnimationFrame !== "function") return Effect.yieldNow;
  const frame = Effect.callback<void>((resume) => {
    const handle = globalThis.requestAnimationFrame(() => resume(Effect.void));
    return Effect.sync(() => globalThis.cancelAnimationFrame(handle));
  });
  // 后台浏览器可暂停 rAF；仅有待发布内容时启用兜底，通知与状态不会无限等待。
  return Effect.raceFirst(frame, Effect.sleep(100));
});

export class FrameClock extends Context.Reference<{ readonly wait: Effect.Effect<void> }>(
  "@codework/client-runtime/state/FrameClock",
  { defaultValue: () => ({ wait: waitForHostFrame }) },
) {}

/** 只合并已经完整累积的快照，不能直接用于独立 delta 或控制事件。 */
export const makeLatestFramePublisher = Effect.fn("makeLatestFramePublisher")(function* <
  A,
  E = never,
>() {
  const scope = yield* Scope.Scope;
  const clock = yield* FrameClock;
  const queue = yield* Effect.acquireRelease(Queue.sliding<A, E | Cause.Done>(1), Queue.shutdown);
  let pending = Option.none<A>();
  let frame: { readonly identity: object; fiber: Fiber.Fiber<void> | null } | null = null;
  let initialized = false;
  let closed = false;

  const emitPending = () => {
    if (Option.isSome(pending)) {
      Queue.offerUnsafe(queue, pending.value);
      pending = Option.none();
    }
  };

  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => {
      closed = true;
      pending = Option.none();
    }),
  );

  const publish = Effect.fn("LatestFramePublisher.publish")(function* (value: A) {
    if (closed) return;
    pending = Option.some(value);
    if (!initialized) {
      initialized = true;
      emitPending();
      return;
    }
    if (frame !== null) return;
    const identity = {};
    const scheduled = { identity, fiber: null as Fiber.Fiber<void> | null };
    frame = scheduled;
    scheduled.fiber = yield* clock.wait.pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (closed || frame?.identity !== identity) return;
          frame = null;
          emitPending();
        }),
      ),
      Effect.forkIn(scope),
    );
  });

  const flush = Effect.gen(function* () {
    const scheduled = frame;
    frame = null;
    if (scheduled?.fiber) yield* Fiber.interrupt(scheduled.fiber);
    if (!closed) emitPending();
  });

  const end = (exit: Exit.Exit<unknown, E>) =>
    flush.pipe(
      Effect.andThen(
        Effect.sync(() => {
          closed = true;
          if (Exit.isFailure(exit)) Queue.failCauseUnsafe(queue, exit.cause);
          else Queue.endUnsafe(queue);
        }),
      ),
    );

  return { publish, flush, end, queue };
});

/** 原事件先在完整状态机中处理，再每帧向 UI 发布最新快照；游标与缓存不经过限速。 */
export function publishLatestByFrame<A, E, R>(source: Stream.Stream<A, E, R>) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const publisher = yield* makeLatestFramePublisher<A, E>();
      yield* Stream.runForEach(source, publisher.publish).pipe(
        Effect.onExit(publisher.end),
        Effect.forkScoped,
      );
      return Stream.fromQueue(publisher.queue);
    }),
  );
}
