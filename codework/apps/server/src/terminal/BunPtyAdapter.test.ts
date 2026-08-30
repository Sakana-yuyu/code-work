import { assert, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { vi } from "vite-plus/test";

import * as BunPtyAdapter from "./BunPtyAdapter.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

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

it.effect("replays a completed Bun subprocess exit to late subscribers", () =>
  Effect.gen(function* () {
    const { promise: exited, resolve: resolveExit } = Promise.withResolvers<number>();
    const subprocess = {
      pid: 43,
      exited,
      signalCode: null,
      terminal: {
        write: vi.fn(),
        resize: vi.fn(),
      },
      kill: vi.fn(),
    } as unknown as Bun.Subprocess;
    vi.stubGlobal("Bun", { spawn: vi.fn(() => subprocess) });

    const adapter = yield* BunPtyAdapter.make().pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
    );
    const process = yield* adapter.spawn({
      shell: "/bin/sh",
      cwd: "/workspace",
      cols: 80,
      rows: 24,
      env: {},
    });
    resolveExit(7);
    yield* Effect.promise(() => exited);
    yield* Effect.yieldNow;

    const observed: PtyAdapter.PtyExitEvent[] = [];
    const unsubscribe = process.onExit((event) => observed.push(event));
    expect(observed).toEqual([{ exitCode: 7, signal: null }]);
    unsubscribe();
  }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals()))),
);

it.effect("retains the Bun subprocess when initial exit observation cannot be acquired", () =>
  Effect.gen(function* () {
    const acquisitionFailure = new Error("subprocess.exited unavailable");
    const { promise: exited, resolve: resolveExit } = Promise.withResolvers<number>();
    let exitedReads = 0;
    const kill = vi.fn();
    const subprocess = {
      pid: 44,
      get exited() {
        exitedReads += 1;
        if (exitedReads <= 2) {
          throw acquisitionFailure;
        }
        return exited;
      },
      signalCode: null,
      terminal: {
        write: vi.fn(),
        resize: vi.fn(),
      },
      kill,
    } as unknown as Bun.Subprocess;
    vi.stubGlobal("Bun", { spawn: vi.fn(() => subprocess) });

    const adapter = yield* BunPtyAdapter.make().pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
    );
    const process = yield* adapter.spawn({
      shell: "/bin/sh",
      cwd: "/workspace",
      cols: 80,
      rows: 24,
      env: {},
    });

    expect(() => process.onData(() => undefined)).toThrow(
      PtyAdapter.PtyProcessListenerRegistrationError,
    );
    assert.equal(process.exitObservation.status, "gap");

    const observed: PtyAdapter.PtyExitEvent[] = [];
    expect(() => process.onExit((event) => observed.push(event))).toThrow(
      PtyAdapter.PtyProcessListenerRegistrationError,
    );
    assert.equal(process.exitObservation.status, "gap");
    const unsubscribe = process.onExit((event) => observed.push(event));
    assert.equal(process.exitObservation.status, "reliable");
    process.kill();
    resolveExit(0);
    yield* Effect.promise(() => exited);
    yield* Effect.yieldNow;

    expect(kill).toHaveBeenCalledOnce();
    expect(observed).toEqual([{ exitCode: 0, signal: null }]);
    unsubscribe();
  }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals()))),
);
