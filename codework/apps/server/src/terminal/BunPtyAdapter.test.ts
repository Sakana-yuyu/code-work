import { assert, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as BunPtyAdapter from "./BunPtyAdapter.ts";
import * as PtyAdapter from "./PtyAdapter.ts";
import * as PtyExitObservationReaper from "./PtyExitObservationReaper.ts";
import * as PtyProcessTermination from "./PtyProcessTermination.ts";

const installBunGlobal = (value: unknown) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Bun");
      Object.defineProperty(globalThis, "Bun", {
        configurable: true,
        writable: true,
        value,
      });
      return descriptor;
    }),
    (descriptor) =>
      Effect.sync(() => {
        if (descriptor === undefined) {
          Reflect.deleteProperty(globalThis, "Bun");
          return;
        }
        Object.defineProperty(globalThis, "Bun", descriptor);
      }),
  );

it("describes unavailable Bun PTY operations structurally", () => {
  const error = new BunPtyAdapter.BunPtyOperationUnavailableError({
    operation: "resize",
    pid: 42,
  });

  expect(error).toMatchObject({
    _tag: "BunPtyOperationUnavailableError",
    operation: "resize",
    pid: 42,
  });
  expect(error.message).toBe("Bun PTY resize is unavailable for process 42.");
});

it.effect("reports unsupported platforms with a structured startup defect", () =>
  Effect.gen(function* () {
    const exit = yield* BunPtyAdapter.make().pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, BunPtyAdapter.BunPtyUnsupportedPlatformError);
      expect(error).toMatchObject({
        _tag: "BunPtyUnsupportedPlatformError",
        platform: "win32",
      });
      expect(error.message).toBe(
        "Bun PTY terminal support is unavailable on win32. Please use Node.js (e.g. by running `npx t3`) instead.",
      );
    }
  }),
);

it.effect("returns an acquisition after wiring the subprocess exit promise", () =>
  Effect.gen(function* () {
    const exit = Promise.withResolvers<number>();
    const subprocess = {
      pid: 42,
      exited: exit.promise,
      signalCode: null,
      terminal: {
        write: vi.fn(),
        resize: vi.fn(),
      },
      kill: vi.fn(),
    } as unknown as Bun.Subprocess;
    const spawn = vi.fn(() => subprocess);
    yield* installBunGlobal({ spawn });
    const adapter = yield* BunPtyAdapter.make().pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
    );

    const acquisition = yield* adapter.spawn({
      shell: "/bin/sh",
      args: ["-l"],
      cwd: "/workspace",
      cols: 100,
      rows: 30,
      env: {},
    });
    assert.equal(acquisition.process.pid, 42);
    assert.equal(spawn.mock.calls.length, 1);

    exit.resolve(7);
    const observed = yield* PtyProcessTermination.awaitProcessExit(acquisition.processExit);
    expect(observed).toEqual({ exitCode: 7, signal: null });
  }),
);

it.effect("fails spawn and kills the handle when the exit promise cannot be observed", () =>
  Effect.gen(function* () {
    const observationFailure = new Error("expected Bun exit observation failure");
    const kill = vi.fn();
    let observationAttempts = 0;
    const subprocess = {
      pid: 43,
      signalCode: null,
      terminal: {
        write: vi.fn(),
        resize: vi.fn(),
      },
      kill,
    };
    Object.defineProperty(subprocess, "exited", {
      get: () => {
        observationAttempts += 1;
        throw observationFailure;
      },
    });
    yield* installBunGlobal({ spawn: vi.fn(() => subprocess) });
    const adapter = yield* BunPtyAdapter.make().pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
    );

    const exit = yield* adapter
      .spawn({
        shell: "/bin/sh",
        cwd: "/workspace",
        cols: 80,
        rows: 24,
        env: {},
      })
      .pipe(Effect.exit);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, PtyAdapter.PtySpawnError);
      assert.instanceOf(error.cause, PtyExitObservationReaper.PtyExitObservationRetainedError);
      expect(error.cause).toMatchObject({
        adapter: "bun",
        processPid: 43,
        reaperId: 1,
      });
      expect((error.cause.cause as { cause: unknown }).cause).toBe(observationFailure);
    }
    expect(kill).toHaveBeenCalledTimes(1);
    yield* TestClock.adjust("300 millis");
    expect(observationAttempts).toBeGreaterThanOrEqual(3);
    expect(kill).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(TestClock.layer())),
);
