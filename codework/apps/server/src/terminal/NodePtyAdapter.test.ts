import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessArchitecture, HostProcessPlatform } from "@codework/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { expect, vi } from "vite-plus/test";

import * as NodePtyAdapter from "./NodePtyAdapter.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

const nativeExitListeners = new Set<
  (event: { readonly exitCode: number; readonly signal?: number }) => void
>();
const nativeExitRegistrationFailures: unknown[] = [];
const nativeKill = vi.fn();

const spawn = vi.fn(() => ({
  pid: 42,
  write: vi.fn(),
  resize: vi.fn(),
  kill: nativeKill,
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onExit: vi.fn(
    (callback: (event: { readonly exitCode: number; readonly signal?: number }) => void) => {
      const failure = nativeExitRegistrationFailures.shift();
      if (failure !== undefined) {
        throw failure;
      }
      nativeExitListeners.add(callback);
      return {
        dispose: () => {
          nativeExitListeners.delete(callback);
        },
      };
    },
  ),
}));

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
    spawn.mockClear();
    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn({
      shell: "powershell.exe",
      args: ["-NoLogo"],
      cwd: "C:\\workspace",
      cols: 120,
      rows: 40,
      env: {},
    });

    assert.equal(process.pid, 42);
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
  }).pipe(Effect.provide(testLayer)),
);

it.effect("preserves a caller-provided TERM in the spawn env on win32", () =>
  Effect.gen(function* () {
    spawn.mockClear();
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

it.effect(
  "recovers a synchronous exit observer registration retry before exposing the handle",
  () =>
    Effect.gen(function* () {
      spawn.mockClear();
      nativeKill.mockClear();
      nativeExitListeners.clear();
      nativeExitRegistrationFailures.length = 0;
      nativeExitRegistrationFailures.push(new Error("native onExit registration failed"));
      const adapter = yield* PtyAdapter.PtyAdapter;
      const process = yield* adapter.spawn({
        shell: "powershell.exe",
        cwd: "C:\\workspace",
        cols: 80,
        rows: 24,
        env: {},
      });

      expect(process.exitObservation).toEqual({ status: "reliable" });
      expect(() => process.onData(() => undefined)).not.toThrow();

      const observed: PtyAdapter.PtyExitEvent[] = [];
      const unsubscribe = process.onExit((event) => observed.push(event));
      process.kill();
      for (const listener of nativeExitListeners) {
        listener({ exitCode: 0 });
      }

      expect(nativeKill).toHaveBeenCalledOnce();
      expect(observed).toEqual([{ exitCode: 0, signal: null }]);
      unsubscribe();
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "marks a sticky observation gap when native exit registration misses its sync window",
  () =>
    Effect.gen(function* () {
      spawn.mockClear();
      nativeKill.mockClear();
      nativeExitListeners.clear();
      nativeExitRegistrationFailures.length = 0;
      nativeExitRegistrationFailures.push(
        new Error("native onExit registration failed once"),
        new Error("native onExit registration failed twice"),
      );
      const adapter = yield* PtyAdapter.PtyAdapter;
      const process = yield* adapter.spawn({
        shell: "powershell.exe",
        cwd: "C:\\workspace",
        cols: 80,
        rows: 24,
        env: {},
      });

      assert.equal(process.exitObservation.status, "gap");
      expect(() => process.onData(() => undefined)).toThrow(
        PtyAdapter.PtyProcessListenerRegistrationError,
      );

      // Node-style EventEmitter 不会保存无人订阅期间的退出事件。
      for (const listener of nativeExitListeners) {
        listener({ exitCode: 19 });
      }
      const observed: PtyAdapter.PtyExitEvent[] = [];
      const unsubscribe = process.onExit((event) => observed.push(event));

      expect(observed).toEqual([]);
      assert.equal(process.exitObservation.status, "gap");
      unsubscribe();
    }).pipe(Effect.provide(testLayer)),
);

it.effect("retains the quarantined native handle until a future observed exit", () =>
  Effect.gen(function* () {
    spawn.mockClear();
    nativeKill.mockClear();
    nativeExitListeners.clear();
    nativeExitRegistrationFailures.length = 0;
    nativeExitRegistrationFailures.push(
      new Error("native onExit registration failed once"),
      new Error("native onExit registration failed twice"),
    );
    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn({
      shell: "powershell.exe",
      cwd: "C:\\workspace",
      cols: 80,
      rows: 24,
      env: {},
    });

    const observed: PtyAdapter.PtyExitEvent[] = [];
    const unsubscribe = process.onExit((event) => observed.push(event));
    process.kill();
    for (const listener of nativeExitListeners) {
      listener({ exitCode: 0 });
    }

    expect(nativeKill).toHaveBeenCalledOnce();
    expect(observed).toEqual([{ exitCode: 0, signal: null }]);
    expect(process.exitObservation).toEqual({ status: "reliable" });
    unsubscribe();
  }).pipe(Effect.provide(testLayer)),
);

it.effect("replays a native exit to late subscribers", () =>
  Effect.gen(function* () {
    spawn.mockClear();
    nativeExitListeners.clear();
    nativeExitRegistrationFailures.length = 0;
    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn({
      shell: "powershell.exe",
      cwd: "C:\\workspace",
      cols: 80,
      rows: 24,
      env: {},
    });

    for (const listener of nativeExitListeners) {
      listener({ exitCode: 23, signal: 15 });
    }
    const observed: PtyAdapter.PtyExitEvent[] = [];
    const unsubscribe = process.onExit((event) => observed.push(event));

    assert.deepEqual(observed, [{ exitCode: 23, signal: 15 }]);
    unsubscribe();
  }).pipe(Effect.provide(testLayer)),
);

it.effect("reports native module load failures as structured startup defects", () =>
  Effect.gen(function* () {
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
