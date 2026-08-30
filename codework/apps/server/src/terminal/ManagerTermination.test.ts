import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_TERMINAL_ID, type TerminalEvent } from "@codework/contracts";
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
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "./Manager.ts";
import type * as PtyAdapter from "./PtyAdapter.ts";
import { makeWorkspaceScriptTerminalOwner } from "./TerminalSessionOwnership.ts";

class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly writes: string[] = [];
  readonly killSignals: Array<string | undefined> = [];
  readonly killFailures = new Map<string | undefined, unknown>();
  readonly pid: number;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  private readonly killListeners = new Set<(signal: string | undefined) => void>();
  private readonly retainExitListenersOnUnsubscribe: boolean;

  constructor(pid: number, retainExitListenersOnUnsubscribe = false) {
    this.pid = pid;
    this.retainExitListenersOnUnsubscribe = retainExitListenersOnUnsubscribe;
  }

  write(data: string): void {
    this.writes.push(data);
  }

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

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      if (!this.retainExitListenersOnUnsubscribe) {
        this.exitListeners.delete(callback);
      }
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
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }

  get dataListenerCount(): number {
    return this.dataListeners.size;
  }

  get exitListenerCount(): number {
    return this.exitListeners.size;
  }
}

class FakePtyAdapter {
  readonly processes: FakePtyProcess[] = [];
  private nextPid = 9_000;
  private readonly options: {
    readonly fixedPid?: number;
    readonly retainExitListenersOnUnsubscribe?: boolean;
  };

  constructor(
    options: {
      readonly fixedPid?: number;
      readonly retainExitListenersOnUnsubscribe?: boolean;
    } = {},
  ) {
    this.options = options;
  }

  spawn(): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    const process = new FakePtyProcess(
      this.options.fixedPid ?? this.nextPid++,
      this.options.retainExitListenersOnUnsubscribe === true,
    );
    this.processes.push(process);
    return Effect.succeed(process);
  }
}

const withHostPlatform = (platform: NodeJS.Platform) =>
  Layer.succeed(HostProcessPlatform, platform);

const createManager = (
  ptyAdapter = new FakePtyAdapter(),
  options: {
    readonly processKillGraceMs?: number;
    readonly processExitTimeoutMs?: number;
    readonly terminalEventSubscriberQueueCapacity?: number;
    readonly maxRetainedInactiveSessions?: number;
    readonly unregisterTerminal?: (input: {
      readonly threadId: string;
      readonly terminalId: string;
    }) => Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "codework-terminal-stop-" });
    const manager = yield* TerminalManager.makeWithOptions({
      logsDir: path.join(baseDir, "userdata", "logs", "terminals"),
      historyLineLimit: 5,
      ptyAdapter,
      processKillGraceMs: options.processKillGraceMs ?? 1_000,
      processExitTimeoutMs: options.processExitTimeoutMs ?? 1_000,
      ...(options.terminalEventSubscriberQueueCapacity !== undefined
        ? { terminalEventSubscriberQueueCapacity: options.terminalEventSubscriberQueueCapacity }
        : {}),
      ...(options.maxRetainedInactiveSessions !== undefined
        ? { maxRetainedInactiveSessions: options.maxRetainedInactiveSessions }
        : {}),
      ...(options.unregisterTerminal ? { unregisterTerminal: options.unregisterTerminal } : {}),
    });
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

const emitExitAndWait = (
  manager: TerminalManager.TerminalManager["Service"],
  process: FakePtyProcess,
  threadId: string,
  event: PtyAdapter.PtyExitEvent,
) =>
  Effect.gen(function* () {
    const handled = yield* Deferred.make<void>();
    const unsubscribe = yield* manager.subscribe((terminalEvent) =>
      terminalEvent.type === "exited" &&
      terminalEvent.threadId === threadId &&
      terminalEvent.terminalId === DEFAULT_TERMINAL_ID
        ? Deferred.succeed(handled, undefined).pipe(Effect.asVoid)
        : Effect.void,
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    process.emitExit(event);
    yield* Deferred.await(handled);
  });

const watchNextKill = (process: FakePtyProcess) =>
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
)("TerminalManager termination", (it) => {
  it.effect("win32 使用无参数 kill 且在真实 onExit 前不返回", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* openTerminal(manager, "win32-stop");
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      const completed = yield* Ref.make(false);
      const nextKill = yield* watchNextKill(process);
      const killFiber = yield* manager
        .kill({ threadId: "win32-stop", terminalId: DEFAULT_TERMINAL_ID })
        .pipe(Effect.ensuring(Ref.set(completed, true)), Effect.forkChild);

      assert.isUndefined(yield* Deferred.await(nextKill));
      expect(process.killSignals).toEqual([undefined]);
      assert.isFalse(yield* Ref.get(completed));

      process.emitExit({ exitCode: 0, signal: null });
      yield* Fiber.join(killFiber);
      assert.isTrue(yield* Ref.get(completed));
      assert.equal(
        yield* manager.inspectSession({
          threadId: "win32-stop",
          terminalId: DEFAULT_TERMINAL_ID,
        }),
        "inactive",
      );
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("Unix TERM 后自然退出会取消强杀并等待事件处理完成", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(new FakePtyAdapter(), {
        processKillGraceMs: 10,
        processExitTimeoutMs: 20,
      });
      yield* openTerminal(manager, "unix-graceful-stop");
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      const nextKill = yield* watchNextKill(process);
      const killFiber = yield* manager
        .kill({ threadId: "unix-graceful-stop", terminalId: DEFAULT_TERMINAL_ID })
        .pipe(Effect.forkChild);

      assert.equal(yield* Deferred.await(nextKill), "SIGTERM");
      expect(process.killSignals).toEqual(["SIGTERM"]);
      process.emitExit({ exitCode: 0, signal: 15 });
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(killFiber);

      expect(process.killSignals).toEqual(["SIGTERM"]);
      assert.equal(
        yield* manager.inspectSession({
          threadId: "unix-graceful-stop",
          terminalId: DEFAULT_TERMINAL_ID,
        }),
        "inactive",
      );
    }).pipe(Effect.provide(Layer.merge(withHostPlatform("linux"), TestClock.layer()))),
  );

  it.effect("Unix grace 到期后仅强杀当前 handle 并继续等待 onExit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(new FakePtyAdapter(), {
        processKillGraceMs: 10,
        processExitTimeoutMs: 20,
      });
      yield* openTerminal(manager, "unix-forced-stop");
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      const completed = yield* Ref.make(false);
      const firstKill = yield* watchNextKill(process);
      const killFiber = yield* manager
        .kill({ threadId: "unix-forced-stop", terminalId: DEFAULT_TERMINAL_ID })
        .pipe(Effect.ensuring(Ref.set(completed, true)), Effect.forkChild);

      assert.equal(yield* Deferred.await(firstKill), "SIGTERM");
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 millis");
      expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
      assert.isFalse(yield* Ref.get(completed));

      process.emitExit({ exitCode: 137, signal: 9 });
      yield* Fiber.join(killFiber);
      assert.isTrue(yield* Ref.get(completed));
    }).pipe(Effect.provide(Layer.merge(withHostPlatform("linux"), TestClock.layer()))),
  );

  it.effect("signal 抛错返回 typed failure 且保留 supervision", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* openTerminal(manager, "signal-failure");
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.killFailures.set(undefined, new Error("signal unsupported"));

      const error = yield* manager
        .kill({ threadId: "signal-failure", terminalId: DEFAULT_TERMINAL_ID })
        .pipe(Effect.flip);

      assert.equal(error._tag, "TerminalProcessTerminationError");
      expect(error).toMatchObject({
        threadId: "signal-failure",
        terminalId: DEFAULT_TERMINAL_ID,
        terminalPid: process.pid,
        reason: "signal-failed",
      });
      assert.equal(
        yield* manager.inspectSession({
          threadId: "signal-failure",
          terminalId: DEFAULT_TERMINAL_ID,
        }),
        "active",
      );

      process.killFailures.delete(undefined);
      yield* emitExitAndWait(manager, process, "signal-failure", { exitCode: 1, signal: null });
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("强杀后无 onExit 返回 typed timeout 且不清 supervision", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(new FakePtyAdapter(), {
        processKillGraceMs: 10,
        processExitTimeoutMs: 20,
      });
      yield* openTerminal(manager, "exit-timeout");
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      const firstKill = yield* watchNextKill(process);
      const killFiber = yield* manager
        .kill({ threadId: "exit-timeout", terminalId: DEFAULT_TERMINAL_ID })
        .pipe(Effect.forkChild);

      assert.equal(yield* Deferred.await(firstKill), "SIGTERM");
      yield* TestClock.adjust("30 millis");
      const error = yield* Fiber.join(killFiber).pipe(Effect.flip);

      assert.equal(error._tag, "TerminalProcessTerminationError");
      expect(error).toMatchObject({ reason: "force-exit-timeout", terminalPid: process.pid });
      assert.equal(
        yield* manager.inspectSession({
          threadId: "exit-timeout",
          terminalId: DEFAULT_TERMINAL_ID,
        }),
        "active",
      );

      yield* emitExitAndWait(manager, process, "exit-timeout", { exitCode: 137, signal: 9 });
    }).pipe(Effect.provide(Layer.merge(withHostPlatform("linux"), TestClock.layer()))),
  );

  it.effect("相同 PID 的旧 handle 迟到退出不得结束新 generation", () =>
    Effect.gen(function* () {
      const adapter = new FakePtyAdapter({
        fixedPid: 4_242,
        retainExitListenersOnUnsubscribe: true,
      });
      const { manager } = yield* createManager(adapter);
      yield* openTerminal(manager, "same-pid-generation");
      const firstProcess = adapter.processes[0];
      expect(firstProcess).toBeDefined();
      if (!firstProcess) return;
      yield* emitExitAndWait(manager, firstProcess, "same-pid-generation", {
        exitCode: 0,
        signal: null,
      });

      yield* manager.restart({
        threadId: "same-pid-generation",
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: process.cwd(),
        cols: 100,
        rows: 24,
      });
      const secondProcess = adapter.processes[1];
      expect(secondProcess).toBeDefined();
      if (!secondProcess) return;
      assert.equal(secondProcess.pid, firstProcess.pid);
      const outputHandled = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.subscribe((event: TerminalEvent) =>
        event.type === "output" &&
        event.threadId === "same-pid-generation" &&
        event.data === "new-generation-output\n"
          ? Deferred.succeed(outputHandled, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      firstProcess.emitExit({ exitCode: 99, signal: 9 });
      secondProcess.emitData("new-generation-output\n");
      const observedOutput = yield* Deferred.await(outputHandled).pipe(
        Effect.timeoutOption("500 millis"),
      );

      assert.isTrue(Option.isSome(observedOutput));
      assert.equal(
        yield* manager.inspectSession({
          threadId: "same-pid-generation",
          terminalId: DEFAULT_TERMINAL_ID,
        }),
        "active",
      );

      yield* emitExitAndWait(manager, secondProcess, "same-pid-generation", {
        exitCode: 0,
        signal: null,
      });
    }),
  );

  it.effect("重复 terminate 共享同一次信号并确定性收敛", () =>
    Effect.gen(function* () {
      const managerScope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* createManager().pipe(
        Effect.provideService(Scope.Scope, managerScope),
      );
      yield* openTerminal(manager, "duplicate-terminate");
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      const nextKill = yield* watchNextKill(process);
      const killFiber = yield* manager
        .kill({ threadId: "duplicate-terminate", terminalId: DEFAULT_TERMINAL_ID })
        .pipe(Effect.forkChild);

      assert.isUndefined(yield* Deferred.await(nextKill));
      const closeScopeFiber = yield* Scope.close(managerScope, Exit.void).pipe(Effect.forkChild);
      const earlyScopeClose = yield* Fiber.join(closeScopeFiber).pipe(
        Effect.timeoutOption("50 millis"),
      );
      assert.isTrue(Option.isNone(earlyScopeClose));
      expect(process.killSignals).toEqual([undefined]);

      process.emitExit({ exitCode: 0, signal: null });
      yield* Fiber.join(killFiber);
      yield* Fiber.join(closeScopeFiber);
      expect(process.killSignals).toEqual([undefined]);
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("Manager scope 关闭会尝试全部会话并在单个终止失败后清空状态", () =>
    Effect.gen(function* () {
      const managerScope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* createManager().pipe(
        Effect.provideService(Scope.Scope, managerScope),
      );
      yield* openTerminal(manager, "shutdown-failure");
      yield* openTerminal(manager, "shutdown-success");
      const failingProcess = ptyAdapter.processes[0];
      const successfulProcess = ptyAdapter.processes[1];
      expect(failingProcess).toBeDefined();
      expect(successfulProcess).toBeDefined();
      if (!failingProcess || !successfulProcess) return;

      failingProcess.killFailures.set(undefined, new Error("expected shutdown signal failure"));
      const unsubscribeKill = successfulProcess.onKill(() => {
        successfulProcess.emitExit({ exitCode: 0, signal: null });
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribeKill));

      yield* Scope.close(managerScope, Exit.void);

      expect(failingProcess.killSignals).toEqual([undefined]);
      expect(successfulProcess.killSignals).toEqual([undefined]);
      assert.equal(failingProcess.dataListenerCount, 0);
      assert.equal(failingProcess.exitListenerCount, 0);
      assert.equal(successfulProcess.dataListenerCount, 0);
      assert.equal(successfulProcess.exitListenerCount, 0);
      assert.equal(
        yield* manager.inspectSession({
          threadId: "shutdown-failure",
          terminalId: DEFAULT_TERMINAL_ID,
        }),
        "missing",
      );
      assert.equal(
        yield* manager.inspectSession({
          threadId: "shutdown-success",
          terminalId: DEFAULT_TERMINAL_ID,
        }),
        "missing",
      );
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("阻塞订阅者不得阻塞退出收口或其他观察者", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* openTerminal(manager, "exit-handling-race");
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const exitPublishStarted = yield* Deferred.make<void>();
      const releaseExitPublish = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(releaseExitPublish, undefined).pipe(Effect.ignore),
      );
      const observedEvents = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const closedObserved = yield* Deferred.make<void>();
      const unsubscribeBlocker = yield* manager.subscribe((event) =>
        event.type === "exited" && event.threadId === "exit-handling-race"
          ? Deferred.succeed(exitPublishStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseExitPublish)),
            )
          : Effect.void,
      );
      const unsubscribeObserver = yield* manager.subscribe((event) =>
        event.threadId === "exit-handling-race"
          ? Ref.update(observedEvents, (events) => [...events, event]).pipe(
              Effect.andThen(
                event.type === "closed"
                  ? Deferred.succeed(closedObserved, undefined).pipe(Effect.asVoid)
                  : Effect.void,
              ),
            )
          : Effect.void,
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsubscribeBlocker();
          unsubscribeObserver();
        }),
      );

      process.emitExit({ exitCode: 0, signal: null });
      yield* Deferred.await(exitPublishStarted);
      const closeFiber = yield* manager
        .close({ threadId: "exit-handling-race", terminalId: DEFAULT_TERMINAL_ID })
        .pipe(Effect.forkChild);

      const earlyClose = yield* Fiber.join(closeFiber).pipe(Effect.timeoutOption("200 millis"));
      assert.isTrue(Option.isSome(earlyClose));
      const healthyObserverCompleted = yield* Deferred.await(closedObserved).pipe(
        Effect.timeoutOption("500 millis"),
      );
      assert.isTrue(Option.isSome(healthyObserverCompleted));

      yield* Deferred.succeed(releaseExitPublish, undefined);
      yield* Fiber.join(closeFiber);
      expect(
        (yield* Ref.get(observedEvents))
          .filter((event) => event.type === "exited" || event.type === "closed")
          .map((event) => [event.type, event.sequence]),
      ).toEqual([
        ["exited", 2],
        ["closed", 3],
      ]);
    }),
  );

  it.effect("阻塞订阅者队列溢出后断开且不影响健康观察者和终止收口", () =>
    Effect.gen(function* () {
      const managerScope = yield* Scope.make("sequential");
      yield* Effect.addFinalizer(() => Scope.close(managerScope, Exit.void));
      const { manager, ptyAdapter } = yield* createManager(new FakePtyAdapter(), {
        terminalEventSubscriberQueueCapacity: 2,
      }).pipe(Effect.provideService(Scope.Scope, managerScope));
      yield* openTerminal(manager, "subscriber-overflow");
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => process.emitExit({ exitCode: 0, signal: null })),
      );

      const blockerStarted = yield* Deferred.make<void>();
      const blockerInterrupted = yield* Deferred.make<void>();
      const blockerCalls = yield* Ref.make(0);
      const healthyEvents = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const healthySecondObserved = yield* Deferred.make<void>();
      const healthyThirdObserved = yield* Deferred.make<void>();
      const healthyOverflowObserved = yield* Deferred.make<void>();
      const healthyAfterOverflowObserved = yield* Deferred.make<void>();
      const closedObserved = yield* Deferred.make<void>();
      const unsubscribeBlocker = yield* manager.subscribe((event) =>
        event.type === "output" && event.threadId === "subscriber-overflow"
          ? Ref.updateAndGet(blockerCalls, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Deferred.succeed(blockerStarted, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.onInterrupt(() =>
                        Deferred.succeed(blockerInterrupted, undefined).pipe(Effect.asVoid),
                      ),
                    )
                  : Effect.void,
              ),
            )
          : Effect.void,
      );
      const unsubscribeHealthy = yield* manager.subscribe((event) =>
        event.threadId === "subscriber-overflow"
          ? Effect.gen(function* () {
              yield* Ref.update(healthyEvents, (events) => [...events, event]);
              if (event.type === "output") {
                if (event.data === "second\n") {
                  yield* Deferred.succeed(healthySecondObserved, undefined);
                } else if (event.data === "third\n") {
                  yield* Deferred.succeed(healthyThirdObserved, undefined);
                } else if (event.data === "overflow\n") {
                  yield* Deferred.succeed(healthyOverflowObserved, undefined);
                } else if (event.data === "after-overflow\n") {
                  yield* Deferred.succeed(healthyAfterOverflowObserved, undefined);
                }
              } else if (event.type === "closed") {
                yield* Deferred.succeed(closedObserved, undefined);
              }
            })
          : Effect.void,
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsubscribeBlocker();
          unsubscribeHealthy();
        }),
      );

      process.emitData("first\n");
      yield* Deferred.await(blockerStarted);
      process.emitData("second\n");
      yield* Deferred.await(healthySecondObserved);
      process.emitData("third\n");
      yield* Deferred.await(healthyThirdObserved);
      process.emitData("overflow\n");
      yield* Deferred.await(healthyOverflowObserved);

      const overflowDisconnected = yield* Deferred.await(blockerInterrupted).pipe(
        Effect.timeoutOption("500 millis"),
      );
      assert.isTrue(Option.isSome(overflowDisconnected));

      process.emitData("after-overflow\n");
      yield* Deferred.await(healthyAfterOverflowObserved);
      process.emitExit({ exitCode: 0, signal: null });
      yield* manager.close({
        threadId: "subscriber-overflow",
        terminalId: DEFAULT_TERMINAL_ID,
      });
      const healthyClosed = yield* Deferred.await(closedObserved).pipe(
        Effect.timeoutOption("500 millis"),
      );
      assert.isTrue(Option.isSome(healthyClosed));

      assert.equal(yield* Ref.get(blockerCalls), 1);
      expect(
        (yield* Ref.get(healthyEvents))
          .filter((event) => event.type === "exited" || event.type === "closed")
          .map((event) => event.type),
      ).toEqual(["exited", "closed"]);

      const scopeClosed = yield* Scope.close(managerScope, Exit.void).pipe(
        Effect.timeoutOption("500 millis"),
      );
      assert.isTrue(Option.isSome(scopeClosed));
    }),
  );

  it.effect("生命周期订阅在 output 洪峰和慢 listener 后仍交付 exited", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(new FakePtyAdapter(), {
        terminalEventSubscriberQueueCapacity: 2,
      });
      const startedObserved = yield* Deferred.make<void>();
      const releaseStarted = yield* Deferred.make<void>();
      const exitedObserved = yield* Deferred.make<void>();
      const subscription = yield* manager.subscribeLifecycle((event) => {
        if (event.threadId !== "lifecycle-output-flood") return Effect.void;
        if (event.type === "started") {
          return Deferred.succeed(startedObserved, undefined).pipe(
            Effect.andThen(Deferred.await(releaseStarted)),
          );
        }
        return event.type === "exited"
          ? Deferred.succeed(exitedObserved, undefined).pipe(Effect.asVoid)
          : Effect.void;
      });
      yield* Effect.addFinalizer(() => Effect.sync(subscription.unsubscribe));

      yield* openTerminal(manager, "lifecycle-output-flood");
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      yield* Deferred.await(startedObserved);

      for (let index = 0; index < 10_000; index += 1) {
        process.emitData(`output-${index}\n`);
      }
      process.emitExit({ exitCode: 0, signal: null });
      const pendingCompleted = yield* Deferred.make<void>();
      const pendingFiber = yield* subscription.awaitPending().pipe(
        Effect.tap(() => Deferred.succeed(pendingCompleted, undefined)),
        Effect.exit,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      assert.isFalse(yield* Deferred.isDone(pendingCompleted));
      yield* Deferred.succeed(releaseStarted, undefined);

      const delivered = yield* Deferred.await(exitedObserved).pipe(
        Effect.timeoutOption("1 second"),
      );
      assert.isTrue(Option.isSome(delivered));
      const pendingExit = yield* Fiber.join(pendingFiber).pipe(Effect.timeoutOption("1 second"));
      assert.isTrue(Option.isSome(pendingExit));
      if (Option.isSome(pendingExit)) {
        assert.isTrue(Exit.isSuccess(pendingExit.value));
      }
    }),
  );

  it.effect("disposeThread 终止失败后在真实 onExit 自动完成 session 与历史清理", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(new FakePtyAdapter(), {
        processExitTimeoutMs: 100,
        maxRetainedInactiveSessions: 0,
      });
      const threadId = "dispose-thread-partial-failure";
      const ownedTerminalId = "workspace-script-dispose-partial";
      const ordinaryTerminalId = "ordinary-dispose-partial";
      const owner = makeWorkspaceScriptTerminalOwner({
        workspaceScriptRunId: "workspace-script-run:dispose-partial",
        generation: 31,
      });
      yield* manager.runCommand({
        threadId,
        terminalId: ownedTerminalId,
        cwd: process.cwd(),
        command: "workspace-script-command",
        owner,
      });
      yield* manager.open({
        threadId,
        terminalId: ordinaryTerminalId,
        cwd: process.cwd(),
      });
      const ownedProcess = ptyAdapter.processes[0];
      const ordinaryProcess = ptyAdapter.processes[1];
      expect(ownedProcess).toBeDefined();
      expect(ordinaryProcess).toBeDefined();
      if (!ownedProcess || !ordinaryProcess) return;
      const ownedOutputObserved = yield* Deferred.make<void>();
      const ownedClosedObserved = yield* Deferred.make<void>();
      const unsubscribeEvents = yield* manager.subscribe((event) => {
        if (event.threadId !== threadId || event.terminalId !== ownedTerminalId) {
          return Effect.void;
        }
        if (event.type === "output") {
          return Deferred.succeed(ownedOutputObserved, undefined).pipe(Effect.asVoid);
        }
        if (event.type === "closed") {
          return Deferred.succeed(ownedClosedObserved, undefined).pipe(Effect.asVoid);
        }
        return Effect.void;
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribeEvents));
      ownedProcess.emitData("owned-private-log\n");
      yield* Deferred.await(ownedOutputObserved);
      ownedProcess.killFailures.set(undefined, new Error("owned kill failed"));
      const unsubscribeOrdinaryKill = ordinaryProcess.onKill(() => {
        ordinaryProcess.emitExit({ exitCode: 0, signal: null });
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribeOrdinaryKill));

      const failures = yield* manager.disposeThread({ threadId, deleteHistory: true });

      assert.equal(failures.length, 1);
      assert.equal(failures[0]?.terminalId, ownedTerminalId);
      assert.isFalse(Cause.hasInterruptsOnly(failures[0]!.cause));
      assert.equal(
        yield* manager.inspectSession({
          threadId,
          terminalId: ownedTerminalId,
          expectedOwner: owner,
        }),
        "active",
      );
      assert.equal(
        yield* manager.inspectSession({ threadId, terminalId: ordinaryTerminalId }),
        "missing",
      );

      ownedProcess.killFailures.delete(undefined);
      ownedProcess.emitExit({ exitCode: 0, signal: null });
      const closed = yield* Deferred.await(ownedClosedObserved).pipe(
        Effect.timeoutOption("1 second"),
      );
      assert.isTrue(Option.isSome(closed));
      assert.equal(
        yield* manager.inspectSession({
          threadId,
          terminalId: ownedTerminalId,
        }),
        "missing",
      );
      assert.equal(yield* manager.getHistory({ threadId, terminalId: ownedTerminalId }), "");
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("disposeThread 将历史删除失败纳入 receipt 且保留可重试清理状态", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      let failRemove = false;
      const fixture = yield* createManager(new FakePtyAdapter(), {
        processExitTimeoutMs: 100,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          remove: (path, options) =>
            failRemove
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "remove",
                    pathOrDescriptor: String(path),
                    description: "terminal history removal denied in test",
                  }),
                )
              : fileSystem.remove(path, options),
        }),
      );
      const { manager, ptyAdapter } = fixture;
      const threadId = "dispose-thread-history-failure";
      yield* openTerminal(manager, threadId);
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      const outputObserved = yield* Deferred.make<void>();
      const unsubscribeEvents = yield* manager.subscribe((event) =>
        event.type === "output" && event.threadId === threadId
          ? Deferred.succeed(outputObserved, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribeEvents));
      const unsubscribeKill = process.onKill(() => {
        process.emitExit({ exitCode: 0, signal: null });
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribeKill));
      process.emitData("private-history\n");
      yield* Deferred.await(outputObserved);
      failRemove = true;

      const failures = yield* manager.disposeThread({ threadId, deleteHistory: true });

      assert.equal(failures.length, 1);
      assert.equal(failures[0]?.terminalId, DEFAULT_TERMINAL_ID);
      assert.equal(
        yield* manager.inspectSession({ threadId, terminalId: DEFAULT_TERMINAL_ID }),
        "inactive",
      );
      assert.equal(
        yield* manager.getHistory({ threadId, terminalId: DEFAULT_TERMINAL_ID }),
        "private-history\n",
      );

      failRemove = false;
      assert.deepEqual(yield* manager.disposeThread({ threadId, deleteHistory: true }), []);
      assert.equal(
        yield* manager.inspectSession({ threadId, terminalId: DEFAULT_TERMINAL_ID }),
        "missing",
      );
      assert.equal(yield* manager.getHistory({ threadId, terminalId: DEFAULT_TERMINAL_ID }), "");
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("disposeThread 将线程历史枚举失败纳入 receipt", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      let failReadDirectory = false;
      const fixture = yield* createManager(new FakePtyAdapter()).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          readDirectory: (path, options) =>
            failReadDirectory
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "readDirectory",
                    pathOrDescriptor: String(path),
                    description: "terminal history enumeration denied in test",
                  }),
                )
              : fileSystem.readDirectory(path, options),
        }),
      );
      const { manager, ptyAdapter } = fixture;
      const threadId = "dispose-thread-history-enumeration-failure";
      yield* openTerminal(manager, threadId);
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("stale-history\n");
      yield* emitExitAndWait(manager, process, threadId, { exitCode: 0, signal: null });
      yield* manager.close({ threadId, terminalId: DEFAULT_TERMINAL_ID });
      assert.equal(
        yield* manager.getHistory({ threadId, terminalId: DEFAULT_TERMINAL_ID }),
        "stale-history\n",
      );
      failReadDirectory = true;

      const failures = yield* manager.disposeThread({ threadId, deleteHistory: true });

      assert.equal(failures.length, 1);
      assert.equal(failures[0]?.terminalId, "*");
      assert.equal(
        yield* manager.getHistory({ threadId, terminalId: DEFAULT_TERMINAL_ID }),
        "stale-history\n",
      );

      failReadDirectory = false;
      assert.deepEqual(yield* manager.disposeThread({ threadId, deleteHistory: true }), []);
      assert.equal(yield* manager.getHistory({ threadId, terminalId: DEFAULT_TERMINAL_ID }), "");
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("attachStream barrier 满时稳定断流且不残留订阅", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(new FakePtyAdapter(), {
        terminalEventSubscriberQueueCapacity: 1,
      });
      yield* openTerminal(manager, "attach-barrier-overflow");
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const listenerCalls = yield* Ref.make(0);
      const attachExit = yield* manager
        .attachStream(
          {
            threadId: "attach-barrier-overflow",
            terminalId: DEFAULT_TERMINAL_ID,
          },
          (event) =>
            Ref.update(listenerCalls, (count) => count + 1).pipe(
              Effect.andThen(
                event.type === "snapshot"
                  ? manager
                      .clear({
                        threadId: "attach-barrier-overflow",
                        terminalId: DEFAULT_TERMINAL_ID,
                      })
                      .pipe(Effect.orDie)
                  : Effect.void,
              ),
            ),
        )
        .pipe(Effect.exit, Effect.timeoutOption("500 millis"));

      assert.isTrue(Option.isSome(attachExit));
      if (Option.isNone(attachExit)) return;
      if (Exit.isSuccess(attachExit.value)) {
        attachExit.value.value();
      }
      assert.isTrue(Exit.isFailure(attachExit.value));
      if (Exit.isFailure(attachExit.value)) {
        assert.isTrue(Cause.hasInterruptsOnly(attachExit.value.cause));
      }
      assert.equal(yield* Ref.get(listenerCalls), 1);

      yield* manager.clear({
        threadId: "attach-barrier-overflow",
        terminalId: DEFAULT_TERMINAL_ID,
      });
      assert.equal(yield* Ref.get(listenerCalls), 1);
      yield* emitExitAndWait(manager, process, "attach-barrier-overflow", {
        exitCode: 0,
        signal: null,
      });
    }),
  );

  it.effect("attachStream barrier 执行中溢出会结束等待方而不是永久挂起", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(new FakePtyAdapter(), {
        terminalEventSubscriberQueueCapacity: 2,
      });
      yield* openTerminal(manager, "attach-barrier-interrupted");
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => process.emitExit({ exitCode: 0, signal: null })),
      );

      const publishedOutputs = yield* Effect.forEach(["buffered", "one", "two", "overflow"], () =>
        Deferred.make<void>(),
      );
      const unsubscribeObserver = yield* manager.subscribe((event) => {
        if (event.type !== "output" || event.threadId !== "attach-barrier-interrupted") {
          return Effect.void;
        }
        const index = ["buffered\n", "one\n", "two\n", "overflow\n"].indexOf(event.data);
        return index >= 0
          ? Deferred.succeed(publishedOutputs[index]!, undefined).pipe(Effect.asVoid)
          : Effect.void;
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribeObserver));

      const replayStarted = yield* Deferred.make<void>();
      const releaseReplay = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(releaseReplay, undefined).pipe(Effect.ignore),
      );
      const attachFiber = yield* manager
        .attachStream(
          {
            threadId: "attach-barrier-interrupted",
            terminalId: DEFAULT_TERMINAL_ID,
          },
          (event) => {
            if (event.type === "snapshot") {
              return Effect.sync(() => process.emitData("buffered\n")).pipe(
                Effect.andThen(Deferred.await(publishedOutputs[0]!)),
              );
            }
            return event.type === "output" && event.data === "buffered\n"
              ? Deferred.succeed(replayStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseReplay)),
                )
              : Effect.void;
          },
        )
        .pipe(Effect.exit, Effect.forkChild);

      yield* Deferred.await(replayStarted);
      for (const [index, data] of ["one\n", "two\n", "overflow\n"].entries()) {
        process.emitData(data);
        yield* Deferred.await(publishedOutputs[index + 1]!);
      }

      const attachExit = yield* Fiber.join(attachFiber).pipe(Effect.timeoutOption("500 millis"));
      assert.isTrue(Option.isSome(attachExit));
      if (Option.isNone(attachExit)) return;
      assert.isTrue(Exit.isFailure(attachExit.value));
      if (Exit.isFailure(attachExit.value)) {
        assert.isTrue(Cause.hasInterruptsOnly(attachExit.value.cause));
      }
    }),
  );

  it.effect("subscribeMetadata barrier 满时稳定断流且不残留订阅", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(new FakePtyAdapter(), {
        terminalEventSubscriberQueueCapacity: 1,
      });
      yield* openTerminal(manager, "metadata-barrier-overflow");
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const listenerCalls = yield* Ref.make(0);
      const metadataExit = yield* manager
        .subscribeMetadata((event) =>
          Ref.update(listenerCalls, (count) => count + 1).pipe(
            Effect.andThen(
              event.type === "snapshot"
                ? manager
                    .open({
                      threadId: "metadata-barrier-overflow-new",
                      terminalId: DEFAULT_TERMINAL_ID,
                      cwd: ".",
                    })
                    .pipe(Effect.orDie)
                : Effect.void,
            ),
          ),
        )
        .pipe(Effect.exit, Effect.timeoutOption("500 millis"));

      assert.isTrue(Option.isSome(metadataExit));
      if (Option.isNone(metadataExit)) return;
      if (Exit.isSuccess(metadataExit.value)) {
        metadataExit.value.value();
      }
      assert.isTrue(Exit.isFailure(metadataExit.value));
      if (Exit.isFailure(metadataExit.value)) {
        assert.isTrue(Cause.hasInterruptsOnly(metadataExit.value.cause));
      }
      assert.equal(yield* Ref.get(listenerCalls), 1);

      yield* manager.clear({
        threadId: "metadata-barrier-overflow",
        terminalId: DEFAULT_TERMINAL_ID,
      });
      assert.equal(yield* Ref.get(listenerCalls), 1);
      const overflowProcess = ptyAdapter.processes[1];
      expect(overflowProcess).toBeDefined();
      if (overflowProcess) {
        overflowProcess.emitExit({ exitCode: 0, signal: null });
        yield* manager.close({
          threadId: "metadata-barrier-overflow-new",
          terminalId: DEFAULT_TERMINAL_ID,
        });
      }
      yield* emitExitAndWait(manager, process, "metadata-barrier-overflow", {
        exitCode: 0,
        signal: null,
      });
    }),
  );

  it.effect("订阅者单次 defect 后继续处理后续事件", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* openTerminal(manager, "listener-defect");
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const outputCalls = yield* Ref.make(0);
      const secondOutputObserved = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "output" && event.threadId === "listener-defect"
          ? Ref.updateAndGet(outputCalls, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Effect.die("expected terminal listener defect")
                  : Deferred.succeed(secondOutputObserved, undefined).pipe(Effect.asVoid),
              ),
            )
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      process.emitData("first\n");
      process.emitData("second\n");
      const continued = yield* Deferred.await(secondOutputObserved).pipe(
        Effect.timeoutOption("500 millis"),
      );

      assert.isTrue(Option.isSome(continued));
      assert.equal(yield* Ref.get(outputCalls), 2);
      yield* emitExitAndWait(manager, process, "listener-defect", {
        exitCode: 0,
        signal: null,
      });
    }),
  );

  it.effect("显式取消订阅会中断阻塞 worker 并停止后续投递", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* openTerminal(manager, "listener-unsubscribe");
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const blockerStarted = yield* Deferred.make<void>();
      const blockerInterrupted = yield* Deferred.make<void>();
      const blockerCalls = yield* Ref.make(0);
      const unsubscribeBlocker = yield* manager.subscribe((event) =>
        event.type === "output" && event.threadId === "listener-unsubscribe"
          ? Ref.updateAndGet(blockerCalls, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Deferred.succeed(blockerStarted, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.onInterrupt(() =>
                        Deferred.succeed(blockerInterrupted, undefined).pipe(Effect.asVoid),
                      ),
                    )
                  : Effect.void,
              ),
            )
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribeBlocker));

      process.emitData("before-unsubscribe\n");
      yield* Deferred.await(blockerStarted);
      unsubscribeBlocker();
      const interrupted = yield* Deferred.await(blockerInterrupted).pipe(
        Effect.timeoutOption("500 millis"),
      );
      assert.isTrue(Option.isSome(interrupted));

      const healthyOutputObserved = yield* Deferred.make<void>();
      const unsubscribeHealthy = yield* manager.subscribe((event) =>
        event.type === "output" &&
        event.threadId === "listener-unsubscribe" &&
        event.data === "after-unsubscribe\n"
          ? Deferred.succeed(healthyOutputObserved, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribeHealthy));

      process.emitData("after-unsubscribe\n");
      yield* Deferred.await(healthyOutputObserved);
      assert.equal(yield* Ref.get(blockerCalls), 1);
      yield* emitExitAndWait(manager, process, "listener-unsubscribe", {
        exitCode: 0,
        signal: null,
      });
    }),
  );

  it.effect("Manager scope 关闭不等待阻塞观察者", () =>
    Effect.gen(function* () {
      const managerScope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* createManager().pipe(
        Effect.provideService(Scope.Scope, managerScope),
      );
      yield* openTerminal(manager, "scope-exit-handling-race");
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const exitPublishStarted = yield* Deferred.make<void>();
      const releaseExitPublish = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(releaseExitPublish, undefined).pipe(Effect.ignore),
      );
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "exited" && event.threadId === "scope-exit-handling-race"
          ? Deferred.succeed(exitPublishStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseExitPublish)),
            )
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      process.emitExit({ exitCode: 0, signal: null });
      yield* Deferred.await(exitPublishStarted);
      const closeScopeFiber = yield* Scope.close(managerScope, Exit.void).pipe(Effect.forkChild);

      const earlyClose = yield* Fiber.join(closeScopeFiber).pipe(
        Effect.timeoutOption("200 millis"),
      );
      assert.isTrue(Option.isSome(earlyClose));

      yield* Deferred.succeed(releaseExitPublish, undefined);
      yield* Fiber.join(closeScopeFiber);
    }),
  );

  it.effect("内部注销未完成时 close 等待同一 generation 的 handled", () =>
    Effect.gen(function* () {
      const unregisterStarted = yield* Deferred.make<void>();
      const releaseUnregister = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(releaseUnregister, undefined).pipe(Effect.ignore),
      );
      const { manager, ptyAdapter } = yield* createManager(new FakePtyAdapter(), {
        unregisterTerminal: (input) =>
          input.threadId === "internal-exit-handling"
            ? Deferred.succeed(unregisterStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseUnregister)),
              )
            : Effect.void,
      });
      yield* openTerminal(manager, "internal-exit-handling");
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitExit({ exitCode: 0, signal: null });
      yield* Deferred.await(unregisterStarted);
      const closeFiber = yield* manager
        .close({ threadId: "internal-exit-handling", terminalId: DEFAULT_TERMINAL_ID })
        .pipe(Effect.forkChild);

      const earlyClose = yield* Fiber.join(closeFiber).pipe(Effect.timeoutOption("50 millis"));
      assert.isTrue(Option.isNone(earlyClose));

      yield* Deferred.succeed(releaseUnregister, undefined);
      yield* Fiber.join(closeFiber);
    }),
  );

  it.effect("clear 不得删除同 generation 已排队的 exit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* openTerminal(manager, "clear-exit-race");
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const outputPublishStarted = yield* Deferred.make<void>();
      const releaseOutputPublish = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "output" && event.threadId === "clear-exit-race"
          ? Deferred.succeed(outputPublishStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseOutputPublish)),
            )
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      process.emitData("before-clear\n");
      yield* Deferred.await(outputPublishStarted);
      process.emitExit({ exitCode: 0, signal: null });
      yield* manager.clear({ threadId: "clear-exit-race", terminalId: DEFAULT_TERMINAL_ID });
      yield* Deferred.succeed(releaseOutputPublish, undefined);

      yield* manager.kill({ threadId: "clear-exit-race", terminalId: DEFAULT_TERMINAL_ID });
      assert.equal(
        yield* manager.inspectSession({
          threadId: "clear-exit-race",
          terminalId: DEFAULT_TERMINAL_ID,
        }),
        "inactive",
      );
    }),
  );
});
