import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_TERMINAL_ID } from "@codework/contracts";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import { expect } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "./Manager.ts";
import type * as PtyAdapter from "./PtyAdapter.ts";
import * as PtyProcessTermination from "./PtyProcessTermination.ts";

class ShutdownRecoveryPtyProcess implements PtyAdapter.PtyProcess {
  readonly killSignals: Array<string | undefined> = [];
  readonly killFailures = new Map<string | undefined, unknown>();
  readonly pid: number;
  readonly processExit: PtyProcessTermination.PtyProcessExitState;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly killListeners = new Set<(signal: string | undefined) => void>();

  constructor(pid: number, processExit: PtyProcessTermination.PtyProcessExitState) {
    this.pid = pid;
    this.processExit = processExit;
  }

  write(): void {}

  resize(): void {}

  kill(signal?: string): void {
    this.killSignals.push(signal);
    for (const listener of this.killListeners) {
      listener(signal);
    }
    const failure = this.killFailures.get(signal);
    if (failure !== undefined) {
      throw failure;
    }
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onKill(callback: (signal: string | undefined) => void): () => void {
    this.killListeners.add(callback);
    return () => {
      this.killListeners.delete(callback);
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(event: PtyAdapter.PtyExitEvent): void {
    PtyProcessTermination.signalProcessExit(this.processExit, event);
  }
}

class ShutdownRecoveryPtyAdapter {
  readonly processes: ShutdownRecoveryPtyProcess[] = [];
  private nextPid = 12_000;

  spawn(): Effect.Effect<PtyAdapter.PtyProcessAcquisition, PtyAdapter.PtySpawnError> {
    return PtyProcessTermination.makeProcessExitState().pipe(
      Effect.map((processExit) => {
        const process = new ShutdownRecoveryPtyProcess(this.nextPid++, processExit);
        this.processes.push(process);
        return {
          process,
          processExit,
          releaseProcessExit: () => {},
        } satisfies PtyAdapter.PtyProcessAcquisition;
      }),
    );
  }
}

const withHostPlatform = (platform: NodeJS.Platform) =>
  Layer.succeed(HostProcessPlatform, platform);

const failWindowsFallback = ({ terminalPid }: { readonly terminalPid: number }) =>
  Effect.fail(
    new TerminalManager.TerminalWindowsProcessTreeTerminationError({
      cause: "expected host fallback failure",
      terminalPid,
    }),
  );

const createManager = (options: {
  readonly managerScope: Scope.Scope;
  readonly forceTerminateWindowsProcessTree?: (input: {
    readonly terminalPid: number;
    readonly processIds: ReadonlyArray<number>;
  }) => Effect.Effect<void, TerminalManager.TerminalWindowsProcessTreeTerminationError>;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "codework-terminal-shutdown-recovery-",
    });
    const ptyAdapter = new ShutdownRecoveryPtyAdapter();
    const manager = yield* TerminalManager.makeWithOptions({
      logsDir: path.join(baseDir, "userdata", "logs", "terminals"),
      historyLineLimit: 5,
      ptyAdapter,
      processKillGraceMs: 20,
      processExitTimeoutMs: 20,
      ...(options.forceTerminateWindowsProcessTree
        ? { forceTerminateWindowsProcessTree: options.forceTerminateWindowsProcessTree }
        : {}),
    }).pipe(Effect.provideService(Scope.Scope, options.managerScope));
    return { manager, ptyAdapter };
  });

const openTerminal = (manager: TerminalManager.TerminalManager["Service"], threadId: string) =>
  manager.open({
    threadId,
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
  });

const watchNextKill = (process: ShutdownRecoveryPtyProcess) =>
  Effect.gen(function* () {
    const observed = yield* Deferred.make<string | undefined>();
    const unsubscribe = process.onKill((signal) => {
      Deferred.doneUnsafe(observed, Effect.succeed(signal));
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    return observed;
  });

it.layer(
  Layer.merge(NodeServices.layer, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
  { excludeTestServices: true },
)("TerminalManager shutdown recovery", (it) => {
  it.effect("scope 关闭后失败 session 的并发 kill 仅重试一次信号", () =>
    Effect.gen(function* () {
      const managerScope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* createManager({
        managerScope,
        forceTerminateWindowsProcessTree: failWindowsFallback,
      });
      yield* openTerminal(manager, "shutdown-retry-kill");
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.killFailures.set(undefined, new Error("expected shutdown signal failure"));
      yield* Scope.close(managerScope, Exit.void);
      process.killFailures.delete(undefined);

      const nextKill = yield* watchNextKill(process);
      const firstKill = yield* manager
        .kill({ threadId: "shutdown-retry-kill", terminalId: DEFAULT_TERMINAL_ID })
        .pipe(Effect.forkChild);
      const secondKill = yield* manager
        .kill({ threadId: "shutdown-retry-kill", terminalId: DEFAULT_TERMINAL_ID })
        .pipe(Effect.forkChild);
      const retriedSignal = yield* Deferred.await(nextKill).pipe(
        Effect.timeoutOption("500 millis"),
      );
      let firstCompletion: Option.Option<void> = Option.none();
      let secondCompletion: Option.Option<void> = Option.none();

      if (Option.isSome(retriedSignal)) {
        process.emitData("late shutdown output\n");
        process.emitExit({ exitCode: 1, signal: null });
        firstCompletion = yield* Fiber.join(firstKill).pipe(Effect.timeoutOption("500 millis"));
        secondCompletion = yield* Fiber.join(secondKill).pipe(Effect.timeoutOption("500 millis"));
      }

      assert.isTrue(Option.isSome(retriedSignal));
      assert.isTrue(Option.isSome(firstCompletion));
      assert.isTrue(Option.isSome(secondCompletion));
      expect(process.killSignals).toEqual([undefined, undefined]);
      assert.equal(
        yield* manager.getHistory({
          threadId: "shutdown-retry-kill",
          terminalId: DEFAULT_TERMINAL_ID,
        }),
        "late shutdown output\n",
      );
      assert.equal(
        yield* manager.inspectSession({
          threadId: "shutdown-retry-kill",
          terminalId: DEFAULT_TERMINAL_ID,
        }),
        "inactive",
      );
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("scope cleanup 与并发 kill 共享同一 handle 终止记录", () =>
    Effect.gen(function* () {
      const managerScope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* createManager({ managerScope });
      yield* openTerminal(manager, "shutdown-concurrent-kill");
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const nextKill = yield* watchNextKill(process);
      const closeScope = yield* Scope.close(managerScope, Exit.void).pipe(Effect.forkChild);
      assert.isUndefined(yield* Deferred.await(nextKill));
      const concurrentKill = yield* manager
        .kill({ threadId: "shutdown-concurrent-kill", terminalId: DEFAULT_TERMINAL_ID })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      expect(process.killSignals).toEqual([undefined]);
      process.emitExit({ exitCode: 0, signal: null });
      const killCompletion = yield* Fiber.join(concurrentKill).pipe(
        Effect.timeoutOption("500 millis"),
      );
      const scopeCompletion = yield* Fiber.join(closeScope).pipe(
        Effect.timeoutOption("500 millis"),
      );

      assert.isTrue(Option.isSome(killCompletion));
      assert.isTrue(Option.isSome(scopeCompletion));
      expect(process.killSignals).toEqual([undefined]);
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("scope 关闭后 close 与 restart 的终止失败不会永久等待", () =>
    Effect.gen(function* () {
      const managerScope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* createManager({
        managerScope,
        forceTerminateWindowsProcessTree: failWindowsFallback,
      });
      yield* openTerminal(manager, "shutdown-retry-close");
      yield* openTerminal(manager, "shutdown-retry-restart");
      const closeProcess = ptyAdapter.processes[0];
      const restartProcess = ptyAdapter.processes[1];
      expect(closeProcess).toBeDefined();
      expect(restartProcess).toBeDefined();
      if (!closeProcess || !restartProcess) return;

      closeProcess.killFailures.set(undefined, new Error("expected close signal failure"));
      restartProcess.killFailures.set(undefined, new Error("expected restart signal failure"));
      yield* Scope.close(managerScope, Exit.void);

      const closeResult = yield* manager
        .close({ threadId: "shutdown-retry-close", terminalId: DEFAULT_TERMINAL_ID })
        .pipe(Effect.exit, Effect.timeoutOption("500 millis"));
      const restartResult = yield* manager
        .restart({
          threadId: "shutdown-retry-restart",
          terminalId: DEFAULT_TERMINAL_ID,
          cwd: process.cwd(),
          cols: 100,
          rows: 24,
        })
        .pipe(Effect.exit, Effect.timeoutOption("500 millis"));

      assert.isTrue(Option.isSome(closeResult));
      assert.isTrue(Option.isSome(restartResult));
      if (Option.isSome(closeResult) && Exit.isFailure(closeResult.value)) {
        expect(Option.getOrUndefined(Cause.findErrorOption(closeResult.value.cause))).toMatchObject(
          {
            reason: "signal-failed",
          },
        );
      } else {
        assert.fail("close 应返回类型化终止失败");
      }
      if (Option.isSome(restartResult) && Exit.isFailure(restartResult.value)) {
        expect(
          Option.getOrUndefined(Cause.findErrorOption(restartResult.value.cause)),
        ).toMatchObject({ reason: "signal-failed" });
      } else {
        assert.fail("restart 应返回类型化终止失败");
      }
      expect(closeProcess.killSignals).toEqual([undefined, undefined]);
      expect(restartProcess.killSignals).toEqual([undefined, undefined]);
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );
});
