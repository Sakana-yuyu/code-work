import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { expect } from "vite-plus/test";

import type * as PtyAdapter from "./PtyAdapter.ts";
import * as PtyProcessTermination from "./PtyProcessTermination.ts";
import * as PtyProcessTerminationCoordinator from "./PtyProcessTerminationCoordinator.ts";

it.effect("record 发布后取消仍会启动并完整收口单飞 worker", () =>
  Effect.gen(function* () {
    const processExit = yield* PtyProcessTermination.makeProcessExitState();
    const signalSent = yield* Deferred.make<void>();
    const workerDrained = yield* Deferred.make<void>();
    const published = yield* Deferred.make<void>();
    const releasePublish = yield* Deferred.make<void>();
    const killSignals: Array<string | undefined> = [];
    const process: PtyAdapter.PtyProcess = {
      pid: 42_001,
      exitObservation: { status: "reliable" },
      write: () => undefined,
      resize: () => undefined,
      kill: (signal) => {
        killSignals.push(signal);
        Deferred.doneUnsafe(signalSent, Effect.void);
        PtyProcessTermination.signalProcessExit(processExit, { exitCode: 0, signal: null });
        PtyProcessTermination.completeProcessExitHandling(processExit);
      },
      onData: () => () => undefined,
      onExit: () => () => undefined,
    };
    const terminationScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(terminationScope, Exit.void));
    let recordRemoved = false;

    const terminationFiber = yield* PtyProcessTerminationCoordinator.terminate({
      process,
      processGeneration: 1,
      processExit,
      owner: null,
      platform: "win32",
      gracefulTimeoutMs: 10,
      forceExitTimeoutMs: 20,
      terminationScope,
      select: (candidate) => Effect.succeed({ type: "created", record: candidate } as const),
      remove: () =>
        Effect.sync(() => {
          recordRemoved = true;
        }),
      isCurrent: Effect.succeed(true),
      afterRecordPublished: Deferred.succeed(published, undefined).pipe(
        Effect.andThen(Deferred.await(releasePublish)),
        Effect.asVoid,
      ),
      onWorkerDrained: () => Deferred.doneUnsafe(workerDrained, Effect.void),
    }).pipe(Effect.exit, Effect.forkChild);

    yield* Deferred.await(published);
    const interruptFiber = yield* Fiber.interrupt(terminationFiber).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(releasePublish, undefined);
    yield* Deferred.await(signalSent);
    yield* Deferred.await(workerDrained);
    yield* Fiber.await(interruptFiber);

    expect(killSignals).toEqual([undefined]);
    assert.isTrue(recordRemoved);
  }),
);
