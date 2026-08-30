import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessArchitecture, HostProcessPlatform } from "@codework/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { expect, vi } from "vite-plus/test";

import * as NodePtyAdapter from "./NodePtyAdapter.ts";
import * as PtyAdapter from "./PtyAdapter.ts";
import * as PtyExitObservationReaper from "./PtyExitObservationReaper.ts";
import * as PtyProcessTermination from "./PtyProcessTermination.ts";

const makeNativeProcess = () => ({
  pid: 42,
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onExit: vi.fn((_callback: (event: { exitCode: number; signal?: number }) => void) => ({
    dispose: vi.fn(),
  })),
});

const spawn = vi.fn(makeNativeProcess);

const resetSpawn = () => {
  spawn.mockReset();
  spawn.mockImplementation(makeNativeProcess);
};

vi.mock("node-pty", () => ({ spawn }));

const testLayer = NodePtyAdapter.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(HostProcessPlatform, "win32"),
      Layer.succeed(HostProcessArchitecture, "x64"),
    ),
  ),
);

it.effect("spawns through the public adapter with the provided host references", () =>
  Effect.gen(function* () {
    resetSpawn();
    const adapter = yield* PtyAdapter.PtyAdapter;
    const acquisition = yield* adapter.spawn({
      shell: "powershell.exe",
      args: ["-NoLogo"],
      cwd: "C:\\workspace",
      cols: 120,
      rows: 40,
      env: {},
    });

    assert.equal(acquisition.process.pid, 42);
    assert.equal(spawn.mock.calls.length, 1);
    assert.deepEqual(spawn.mock.calls[0], [
      "powershell.exe",
      ["-NoLogo"],
      {
        cwd: "C:\\workspace",
        cols: 120,
        rows: 40,
        env: { TERM: "xterm-256color" },
        name: "xterm-256color",
      },
    ]);
    const nativeProcess = spawn.mock.results[0]?.value;
    assert.isDefined(nativeProcess);
    assert.equal(nativeProcess?.onExit.mock.calls.length, 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("preserves a caller-provided TERM in the spawn env on win32", () =>
  Effect.gen(function* () {
    resetSpawn();
    const adapter = yield* PtyAdapter.PtyAdapter;
    yield* adapter.spawn({
      shell: "powershell.exe",
      cwd: "C:\\workspace",
      cols: 80,
      rows: 24,
      env: { TERM: "xterm-direct" },
    });

    assert.equal(spawn.mock.calls.length, 1);
    assert.deepEqual(spawn.mock.calls[0], [
      "powershell.exe",
      [],
      {
        cwd: "C:\\workspace",
        cols: 80,
        rows: 24,
        env: { TERM: "xterm-direct" },
        name: "xterm-256color",
      },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("exposes replayable exit state and releases the native observer", () =>
  Effect.gen(function* () {
    resetSpawn();
    const adapter = yield* PtyAdapter.PtyAdapter;
    const acquisition = yield* adapter.spawn({
      shell: "powershell.exe",
      cwd: "C:\\workspace",
      cols: 80,
      rows: 24,
      env: {},
    });
    const nativeProcess = spawn.mock.results[0]?.value;
    assert.isDefined(nativeProcess);
    const listener = nativeProcess?.onExit.mock.calls[0]?.[0];
    assert.isFunction(listener);

    listener?.({ exitCode: 7, signal: 9 });
    const observed = yield* PtyProcessTermination.awaitProcessExit(acquisition.processExit);
    assert.deepEqual(observed, { exitCode: 7, signal: 9 });

    const disposable = nativeProcess?.onExit.mock.results[0]?.value;
    acquisition.releaseProcessExit();
    assert.equal(disposable?.dispose.mock.calls.length, 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("fails spawn and kills the handle when native exit observation cannot be installed", () =>
  Effect.gen(function* () {
    resetSpawn();
    const observationFailure = new Error("expected native exit observer failure");
    const nativeProcess = makeNativeProcess();
    nativeProcess.onExit.mockImplementation(() => {
      throw observationFailure;
    });
    spawn.mockImplementationOnce(() => nativeProcess);
    const adapter = yield* PtyAdapter.PtyAdapter;

    const exit = yield* adapter
      .spawn({
        shell: "powershell.exe",
        cwd: "C:\\workspace",
        cols: 80,
        rows: 24,
        env: {},
      })
      .pipe(Effect.exit);

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, PtyAdapter.PtySpawnError);
      assert.instanceOf(error.cause, PtyExitObservationReaper.PtyExitObservationRetainedError);
      assert.equal(error.cause.processPid, 42);
      assert.equal(error.cause.reaperId, 1);
      expect(error.cause.cause).toMatchObject({
        _tag: "PtyExitObservationOperationError",
        adapter: "node-pty",
        operation: "register",
        processPid: 42,
      });
      expect((error.cause.cause as { cause: unknown }).cause).toBe(observationFailure);
    }
    assert.equal(nativeProcess.kill.mock.calls.length, 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("retains the same handle while exit observation keeps failing", () =>
  Effect.gen(function* () {
    resetSpawn();
    const observationFailure = new Error("expected persistent observer failure");
    const nativeProcess = makeNativeProcess();
    nativeProcess.onExit.mockImplementation(() => {
      throw observationFailure;
    });
    spawn.mockImplementationOnce(() => nativeProcess);
    const adapter = yield* PtyAdapter.PtyAdapter;

    yield* adapter
      .spawn({
        shell: "powershell.exe",
        cwd: "C:\\workspace",
        cols: 80,
        rows: 24,
        env: {},
      })
      .pipe(Effect.exit);
    assert.equal(nativeProcess.onExit.mock.calls.length, 1);
    assert.equal(nativeProcess.kill.mock.calls.length, 1);

    yield* TestClock.adjust("300 millis");

    assert.isAtLeast(nativeProcess.onExit.mock.calls.length, 3);
    assert.equal(nativeProcess.kill.mock.calls.length, 1);
  }).pipe(Effect.provide(Layer.merge(testLayer, TestClock.layer()))),
);

it.effect("retains the handle when both observation setup and the termination request fail", () =>
  Effect.gen(function* () {
    resetSpawn();
    const observationFailure = new Error("expected persistent observer failure");
    const terminationFailure = new Error("expected termination request failure");
    const nativeProcess = makeNativeProcess();
    nativeProcess.onExit.mockImplementation(() => {
      throw observationFailure;
    });
    nativeProcess.kill.mockImplementation(() => {
      throw terminationFailure;
    });
    spawn.mockImplementationOnce(() => nativeProcess);
    const adapter = yield* PtyAdapter.PtyAdapter;

    const exit = yield* adapter
      .spawn({
        shell: "powershell.exe",
        cwd: "C:\\workspace",
        cols: 80,
        rows: 24,
        env: {},
      })
      .pipe(Effect.exit);

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, PtyAdapter.PtySpawnError);
      assert.instanceOf(error.cause, PtyExitObservationReaper.PtyExitObservationRetainedError);
      expect(error.cause.cleanupCause).toMatchObject({
        _tag: "PtyExitObservationOperationError",
        adapter: "node-pty",
        operation: "terminate",
        processPid: 42,
      });
      expect((error.cause.cleanupCause as { cause: unknown }).cause).toBe(terminationFailure);
    }
    yield* TestClock.adjust("100 millis");
    assert.equal(nativeProcess.onExit.mock.calls.length, 2);
    assert.equal(nativeProcess.kill.mock.calls.length, 1);
  }).pipe(Effect.provide(Layer.merge(testLayer, TestClock.layer()))),
);

it.effect("reaper waits for a delayed real exit after restoring observation", () =>
  Effect.gen(function* () {
    resetSpawn();
    const observationFailure = new Error("expected first observer failure");
    const releaseObservation = vi.fn();
    const listenerRef: {
      current: ((event: { exitCode: number; signal?: number }) => void) | null;
    } = { current: null };
    const nativeProcess = makeNativeProcess();
    nativeProcess.onExit
      .mockImplementationOnce(() => {
        throw observationFailure;
      })
      .mockImplementationOnce((callback) => {
        listenerRef.current = callback;
        return { dispose: releaseObservation };
      });
    spawn.mockImplementationOnce(() => nativeProcess);
    const adapter = yield* PtyAdapter.PtyAdapter;

    yield* adapter
      .spawn({
        shell: "powershell.exe",
        cwd: "C:\\workspace",
        cols: 80,
        rows: 24,
        env: {},
      })
      .pipe(Effect.exit);
    yield* TestClock.adjust("100 millis");
    const listener = listenerRef.current;
    assert.isFunction(listener);
    assert.equal(releaseObservation.mock.calls.length, 0);

    listener!({ exitCode: 0, signal: 0 });
    yield* Effect.yieldNow;

    assert.equal(releaseObservation.mock.calls.length, 1);
    assert.equal(nativeProcess.kill.mock.calls.length, 1);
  }).pipe(Effect.provide(Layer.merge(testLayer, TestClock.layer()))),
);

it.effect("reports native module load failures as structured startup defects", () =>
  Effect.gen(function* () {
    resetSpawn();
    const cause = new Error("native binding could not be loaded");
    const exit = yield* NodePtyAdapter.make(() => Promise.reject(cause)).pipe(Effect.exit);

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.isTrue(Cause.hasDies(exit.cause));
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, NodePtyAdapter.NodePtyModuleLoadError);
      assert.deepInclude(error, {
        _tag: "NodePtyModuleLoadError",
        platform: "win32",
        architecture: "x64",
      });
      assert.equal(error.message, "Failed to load node-pty for win32-x64.");
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HostProcessPlatform, "win32"),
        Layer.succeed(HostProcessArchitecture, "x64"),
      ),
    ),
  ),
);
