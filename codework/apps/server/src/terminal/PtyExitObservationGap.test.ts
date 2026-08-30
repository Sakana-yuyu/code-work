import { TerminalProcessTerminationError } from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect } from "vite-plus/test";

import type * as PtyAdapter from "./PtyAdapter.ts";
import * as PtyExitObservationGap from "./PtyExitObservationGap.ts";

function makeProcess(killSignals: Array<string | undefined>): PtyAdapter.PtyProcess {
  return {
    pid: 41_001,
    exitObservation: { status: "gap", cause: new Error("observer gap") },
    write: () => undefined,
    resize: () => undefined,
    kill: (signal) => killSignals.push(signal),
    onData: () => () => undefined,
    onExit: () => () => undefined,
  };
}

it.effect("领取后外部取消仍会完成同一 handle 的同步 signal", () =>
  Effect.gen(function* () {
    const killSignals: Array<string | undefined> = [];
    const process = makeProcess(killSignals);
    const claimed = yield* Deferred.make<void>();
    const releaseClaim = yield* Deferred.make<void>();
    const gapFiber = yield* PtyExitObservationGap.failIfPresent({
      threadId: "gap-cancel",
      terminalId: "term-1",
      process,
      processGeneration: 1,
      claim: Effect.succeed({
        observationCause: new Error("observer gap"),
        shouldSignal: true,
        signal: "platform-default",
      }),
      afterClaimed: Deferred.succeed(claimed, undefined).pipe(
        Effect.andThen(Deferred.await(releaseClaim)),
        Effect.asVoid,
      ),
      signalIfCurrent: () =>
        Effect.sync(() => {
          process.kill();
          return { signalAttempted: true, signalFailure: undefined };
        }),
    }).pipe(Effect.exit, Effect.forkChild);

    yield* Deferred.await(claimed);
    const interruptFiber = yield* Fiber.interrupt(gapFiber).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(releaseClaim, undefined);
    yield* Fiber.await(interruptFiber);

    expect(killSignals).toEqual([undefined]);
  }),
);

it.effect("无安全 handle 级信号能力时只隔离而不调用 signal", () =>
  Effect.gen(function* () {
    const killSignals: Array<string | undefined> = [];
    const process = makeProcess(killSignals);
    let signalCallbackCalled = false;
    const error = yield* PtyExitObservationGap.failIfPresent({
      threadId: "gap-no-signal",
      terminalId: "term-1",
      process,
      processGeneration: 1,
      claim: Effect.succeed({
        observationCause: new Error("observer gap"),
        shouldSignal: false,
        signal: null,
      }),
      afterClaimed: Effect.void,
      signalIfCurrent: () =>
        Effect.sync(() => {
          signalCallbackCalled = true;
          return { signalAttempted: true, signalFailure: undefined };
        }),
    }).pipe(Effect.flip);

    assert.instanceOf(error, TerminalProcessTerminationError);
    assert.equal(error.reason, "exit-observation-gap");
    assert.equal(error.signal, null);
    assert.isFalse(signalCallbackCalled);
    expect(killSignals).toEqual([]);
  }),
);
