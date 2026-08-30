import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect } from "vite-plus/test";

import type * as PtyAdapter from "./PtyAdapter.ts";
import * as PtyProcessExitObserver from "./PtyProcessExitObserver.ts";

it.effect("observer 发布后取消仍会激活并排空同步 exit", () =>
  Effect.gen(function* () {
    const exitListener = {
      current: null as ((event: PtyAdapter.PtyExitEvent) => void) | null,
    };
    const process: PtyAdapter.PtyProcess = {
      pid: 43_001,
      exitObservation: { status: "reliable" },
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
      onData: () => () => undefined,
      onExit: (listener) => {
        exitListener.current = listener;
        return () => {
          exitListener.current = null;
        };
      },
    };
    const published = yield* Deferred.make<void>();
    const releasePublish = yield* Deferred.make<void>();
    const dispatched: PtyAdapter.PtyExitEvent[] = [];
    const observerFiber = yield* PtyProcessExitObserver.install({
      threadId: "observer-cancel",
      terminalId: "term-1",
      process,
      processGeneration: 1,
      publish: (processExit) => Effect.succeed(processExit),
      dispatch: (_processExit, event) => dispatched.push(event),
      afterPublished: Deferred.succeed(published, undefined).pipe(
        Effect.andThen(Deferred.await(releasePublish)),
        Effect.asVoid,
      ),
    }).pipe(Effect.exit, Effect.forkChild);

    yield* Deferred.await(published);
    const interruptFiber = yield* Fiber.interrupt(observerFiber).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    const exitEvent = { exitCode: 0, signal: null };
    assert.isNotNull(exitListener.current);
    exitListener.current?.(exitEvent);
    yield* Deferred.succeed(releasePublish, undefined);
    yield* Fiber.await(interruptFiber);

    expect(dispatched).toEqual([exitEvent]);
  }),
);
