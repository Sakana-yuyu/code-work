import { assert, it } from "@effect/vitest";
import type { TerminalEvent } from "@codework/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as TerminalEventHub from "./TerminalEventHub.ts";

const outputEvent = (sequence: number): TerminalEvent => ({
  type: "output",
  threadId: "thread-event-hub",
  terminalId: "terminal-event-hub",
  sequence,
  data: `output-${sequence}\n`,
});

const exitedEvent: TerminalEvent = {
  type: "exited",
  threadId: "thread-event-hub",
  terminalId: "terminal-event-hub",
  sequence: 10_001,
  exitCode: 0,
  exitSignal: null,
};

const overflow = {
  eventType: "attach-barrier" as const,
  threadId: "thread-event-hub",
  terminalId: "terminal-event-hub",
};

it.effect("Hub 作用域关闭后拒绝创建新订阅", () =>
  Effect.gen(function* () {
    const hubScope = yield* Scope.make("sequential");
    const hub = yield* TerminalEventHub.make(2).pipe(Scope.provide(hubScope));
    yield* Scope.close(hubScope, Exit.void);

    const subscribeExit = yield* hub
      .subscribe(() => Effect.void, { startPaused: true })
      .pipe(Effect.exit);

    assert.isTrue(Exit.isFailure(subscribeExit));
    if (Exit.isFailure(subscribeExit)) {
      assert.isTrue(Cause.hasInterruptsOnly(subscribeExit.cause));
    }
  }),
);

it.effect("入队前过滤使高频 output 不占用暂停生命周期订阅容量", () =>
  Effect.gen(function* () {
    const hub = yield* TerminalEventHub.make(2);
    const observed = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
    const subscription = yield* hub.subscribe(
      (event) => Ref.update(observed, (events) => [...events, event]),
      {
        acceptsEvent: (event) => event.type === "exited",
        startPaused: true,
      },
    );
    yield* Effect.addFinalizer(() => Effect.sync(subscription.unsubscribe));

    for (let sequence = 1; sequence <= 10_000; sequence += 1) {
      yield* hub.publish(outputEvent(sequence));
    }
    yield* hub.publish(exitedEvent);
    yield* subscription.runAfterPendingEvents(Effect.void, overflow);

    assert.deepEqual(yield* Ref.get(observed), [exitedEvent]);
  }),
);

it.effect("Hub 作用域关闭会完成已排队 barrier 的等待方", () =>
  Effect.gen(function* () {
    const hubScope = yield* Scope.make("sequential");
    const hub = yield* TerminalEventHub.make(2).pipe(Scope.provide(hubScope));
    const listenerStarted = yield* Deferred.make<void>();
    const subscription = yield* hub.subscribe(() =>
      Deferred.succeed(listenerStarted, undefined).pipe(Effect.andThen(Effect.never)),
    );
    yield* hub.publish(outputEvent(1));
    yield* Deferred.await(listenerStarted);

    const barrierFiber = yield* subscription
      .runAfterPendingEvents(Effect.void, overflow)
      .pipe(Effect.exit, Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Scope.close(hubScope, Exit.void);

    const barrierExit = yield* Fiber.join(barrierFiber).pipe(Effect.timeoutOption("500 millis"));
    assert.isTrue(Option.isSome(barrierExit));
    if (Option.isSome(barrierExit)) {
      assert.isTrue(Exit.isFailure(barrierExit.value));
      if (Exit.isFailure(barrierExit.value)) {
        assert.isTrue(Cause.hasInterruptsOnly(barrierExit.value.cause));
      }
    }
  }),
);

it.effect("Hub 作用域关闭会中断正在执行的 barrier 并完成等待方", () =>
  Effect.gen(function* () {
    const hubScope = yield* Scope.make("sequential");
    const hub = yield* TerminalEventHub.make(2).pipe(Scope.provide(hubScope));
    const barrierStarted = yield* Deferred.make<void>();
    const subscription = yield* hub.subscribe(() => Effect.void);
    const barrierFiber = yield* subscription
      .runAfterPendingEvents(
        Deferred.succeed(barrierStarted, undefined).pipe(Effect.andThen(Effect.never)),
        overflow,
      )
      .pipe(Effect.exit, Effect.forkChild);
    yield* Deferred.await(barrierStarted);

    yield* Scope.close(hubScope, Exit.void);

    const barrierExit = yield* Fiber.join(barrierFiber).pipe(Effect.timeoutOption("500 millis"));
    assert.isTrue(Option.isSome(barrierExit));
    if (Option.isSome(barrierExit)) {
      assert.isTrue(Exit.isFailure(barrierExit.value));
      if (Exit.isFailure(barrierExit.value)) {
        assert.isTrue(Cause.hasInterruptsOnly(barrierExit.value.cause));
      }
    }
  }),
);
