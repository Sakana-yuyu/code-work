import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  TerminalManagerShutdownError,
  TerminalProcessTerminationError,
  type TerminalEvent,
} from "@codework/contracts";
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
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "./Manager.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

class LifecyclePtyProcess implements PtyAdapter.PtyProcess {
  exitObservation: PtyAdapter.PtyExitObservation = { status: "reliable" };
  readonly killSignals: Array<string | undefined> = [];
  readonly killFailures = new Map<string | undefined, unknown>();
  readonly dataRegistrationFailures: unknown[] = [];
  readonly exitRegistrationFailures: unknown[] = [];
  readonly dataDisposalFailures: unknown[] = [];
  readonly exitDisposalFailures: unknown[] = [];
  exitOnKillSignals = new Set<string | undefined>([undefined, "SIGTERM", "SIGKILL"]);
  replayExitToLateSubscribers = true;
  onExitRegistration: (() => void) | null = null;
  onKill: ((signal: string | undefined) => void) | null = null;
  exitRegistrationCount = 0;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  private exitEvent: PtyAdapter.PtyExitEvent | null = null;

  readonly pid: number;

  constructor(pid: number) {
    this.pid = pid;
  }

  write(): void {}

  resize(): void {}

  kill(signal?: string): void {
    this.killSignals.push(signal);
    this.onKill?.(signal);
    const failure = this.killFailures.get(signal);
    if (failure !== undefined) {
      throw failure;
    }
    if (this.exitOnKillSignals.has(signal)) {
      this.emitExit({
        exitCode: signal === "SIGKILL" ? 137 : 0,
        signal: signal === "SIGKILL" ? 9 : signal === "SIGTERM" ? 15 : null,
      });
    }
  }

  onData(callback: (data: string) => void): () => void {
    if (this.exitObservation.status === "gap") {
      throw this.exitObservation.cause;
    }
    const failure = this.dataRegistrationFailures.shift();
    if (failure !== undefined) {
      throw failure;
    }
    this.dataListeners.add(callback);
    return () => {
      const disposalFailure = this.dataDisposalFailures.shift();
      if (disposalFailure !== undefined) {
        throw disposalFailure;
      }
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    const failure = this.exitRegistrationFailures.shift();
    if (failure !== undefined) {
      throw failure;
    }
    this.exitRegistrationCount += 1;
    this.exitListeners.add(callback);
    const registrationHook = this.onExitRegistration;
    this.onExitRegistration = null;
    registrationHook?.();
    if (this.exitEvent && this.replayExitToLateSubscribers) {
      this.exitObservation = { status: "reliable" };
      callback(this.exitEvent);
    }
    return () => {
      const disposalFailure = this.exitDisposalFailures.shift();
      if (disposalFailure !== undefined) {
        throw disposalFailure;
      }
      this.exitListeners.delete(callback);
    };
  }

  get dataListenerCount(): number {
    return this.dataListeners.size;
  }

  get exitListenerCount(): number {
    return this.exitListeners.size;
  }

  emitExit(event: PtyAdapter.PtyExitEvent): void {
    if (this.exitEvent) return;
    this.exitEvent = event;
    if (this.exitListeners.size > 0) {
      this.exitObservation = { status: "reliable" };
    }
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

class LifecyclePtyAdapter {
  readonly processes: LifecyclePtyProcess[] = [];
  configureNextProcess: ((process: LifecyclePtyProcess) => void) | null = null;
  beforeNextSpawn: (() => Promise<void>) | null = null;
  private nextPid = 12_000;

  spawn(): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    return Effect.promise(async () => {
      const beforeSpawn = this.beforeNextSpawn;
      this.beforeNextSpawn = null;
      await beforeSpawn?.();
      const process = new LifecyclePtyProcess(this.nextPid++);
      this.configureNextProcess?.(process);
      this.configureNextProcess = null;
      this.processes.push(process);
      return process;
    });
  }
}

const makeManager = (
  options: {
    readonly processKillGraceMs?: number;
    readonly processExitTimeoutMs?: number;
    readonly maxRetainedInactiveSessions?: number;
    readonly unregisterTerminal?: (input: {
      readonly threadId: string;
      readonly terminalId: string;
    }) => Effect.Effect<void>;
    readonly onExitDrained?: (input: {
      readonly threadId: string;
      readonly terminalId: string;
    }) => Effect.Effect<void>;
    readonly afterProcessCommitted?: (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly processGeneration: number;
    }) => Effect.Effect<void>;
    readonly afterGapTerminationClaimed?: (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly processGeneration: number;
    }) => Effect.Effect<void>;
    readonly afterTerminationRecordPublished?: (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly processGeneration: number;
    }) => Effect.Effect<void>;
    readonly afterExitObserverPublished?: (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly processGeneration: number;
    }) => Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "codework-terminal-lifecycle-" });
    const ptyAdapter = new LifecyclePtyAdapter();
    const manager = yield* TerminalManager.makeWithOptions({
      logsDir: path.join(baseDir, "logs"),
      historyLineLimit: 20,
      ptyAdapter,
      processKillGraceMs: options.processKillGraceMs ?? 10,
      processExitTimeoutMs: options.processExitTimeoutMs ?? 20,
      ...(options.maxRetainedInactiveSessions === undefined
        ? {}
        : { maxRetainedInactiveSessions: options.maxRetainedInactiveSessions }),
      ...(options.unregisterTerminal ? { unregisterTerminal: options.unregisterTerminal } : {}),
      ...(options.onExitDrained ? { onExitDrained: options.onExitDrained } : {}),
      ...(options.afterProcessCommitted
        ? { afterProcessCommitted: options.afterProcessCommitted }
        : {}),
      ...(options.afterGapTerminationClaimed
        ? { afterGapTerminationClaimed: options.afterGapTerminationClaimed }
        : {}),
      ...(options.afterTerminationRecordPublished
        ? { afterTerminationRecordPublished: options.afterTerminationRecordPublished }
        : {}),
      ...(options.afterExitObserverPublished
        ? { afterExitObserverPublished: options.afterExitObserverPublished }
        : {}),
    });
    return { manager, ptyAdapter };
  });

const openTerminal = (
  manager: TerminalManager.TerminalManager["Service"],
  threadId: string,
  terminalId: string,
) =>
  manager.open({
    threadId,
    terminalId,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
  });

const withHostPlatform = (platform: NodeJS.Platform) =>
  Layer.succeed(HostProcessPlatform, platform);

it.layer(
  Layer.merge(NodeServices.layer, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
  { excludeTestServices: true },
)("TerminalManager lifecycle reliability", (it) => {
  it.effect("阻塞退出事件订阅者不会阻塞 close，解除后仍按序交付", () =>
    Effect.gen(function* () {
      const { manager } = yield* makeManager();
      const threadId = "blocked-subscriber-thread";
      yield* openTerminal(manager, threadId, DEFAULT_TERMINAL_ID);
      const blocked = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const closedDelivered = yield* Deferred.make<void>();
      const closeDone = yield* Deferred.make<void>();
      const deliveredEvents = yield* Ref.make<ReadonlyArray<TerminalEvent["type"]>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        event.threadId !== threadId || (event.type !== "exited" && event.type !== "closed")
          ? Effect.void
          : Effect.gen(function* () {
              yield* Ref.update(deliveredEvents, (events) => [...events, event.type]);
              if (event.type === "exited") {
                yield* Deferred.succeed(blocked, undefined);
                yield* Deferred.await(release);
              } else {
                yield* Deferred.succeed(closedDelivered, undefined);
              }
            }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const closeFiber = yield* manager
        .close({ threadId, terminalId: DEFAULT_TERMINAL_ID })
        .pipe(Effect.ensuring(Deferred.succeed(closeDone, undefined)), Effect.forkChild);
      yield* Deferred.await(blocked);
      const completionWhileBlocked = yield* Deferred.await(closeDone).pipe(
        Effect.timeoutOption("100 millis"),
      );

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(closeFiber);
      yield* Deferred.await(closedDelivered);

      assert.isTrue(Option.isSome(completionWhileBlocked));
      expect(yield* Ref.get(deliveredEvents)).toEqual(["exited", "closed"]);
      assert.equal(
        yield* manager.inspectSession({ threadId, terminalId: DEFAULT_TERMINAL_ID }),
        "missing",
      );
    }),
  );

  it.effect("close-all 在初始 signal 失败后仍关闭后续 session", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* makeManager();
      const threadId = "close-all-initial-signal-failure";
      yield* openTerminal(manager, threadId, "first");
      yield* openTerminal(manager, threadId, "second");
      const first = ptyAdapter.processes[0];
      const second = ptyAdapter.processes[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) return;
      first.killFailures.set(undefined, new Error("initial signal failed"));

      const error = yield* manager.close({ threadId }).pipe(Effect.flip);

      assert.equal(error._tag, "TerminalProcessTerminationError");
      expect(first.killSignals).toEqual([undefined]);
      expect(second.killSignals).toEqual([undefined]);
      assert.equal(yield* manager.inspectSession({ threadId, terminalId: "first" }), "active");
      assert.equal(yield* manager.inspectSession({ threadId, terminalId: "second" }), "missing");
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("close-all 在 force throw 与 force timeout 后仍尝试其余 session", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* makeManager({
        processKillGraceMs: 10,
        processExitTimeoutMs: 20,
      });
      const threadId = "close-all-force-failures";
      yield* openTerminal(manager, threadId, "force-throw");
      yield* openTerminal(manager, threadId, "force-timeout");
      yield* openTerminal(manager, threadId, "success");
      const forceThrow = ptyAdapter.processes[0];
      const forceTimeout = ptyAdapter.processes[1];
      const success = ptyAdapter.processes[2];
      expect(forceThrow).toBeDefined();
      expect(forceTimeout).toBeDefined();
      expect(success).toBeDefined();
      if (!forceThrow || !forceTimeout || !success) return;
      forceThrow.exitOnKillSignals.clear();
      forceThrow.killFailures.set("SIGKILL", new Error("force signal failed"));
      forceTimeout.exitOnKillSignals.clear();

      const closeFiber = yield* manager.close({ threadId }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("30 millis");
      const error = yield* Fiber.join(closeFiber).pipe(Effect.flip);

      const observedForceThrowSignals = [...forceThrow.killSignals];
      const observedForceTimeoutSignals = [...forceTimeout.killSignals];
      const observedSuccessSignals = [...success.killSignals];
      const observedForceThrowState = yield* manager.inspectSession({
        threadId,
        terminalId: "force-throw",
      });
      const observedForceTimeoutState = yield* manager.inspectSession({
        threadId,
        terminalId: "force-timeout",
      });
      const observedSuccessState = yield* manager.inspectSession({
        threadId,
        terminalId: "success",
      });
      forceThrow.killFailures.delete("SIGKILL");
      forceThrow.exitOnKillSignals.add("SIGTERM");
      forceTimeout.exitOnKillSignals.add("SIGTERM");
      for (const terminalId of ["force-throw", "force-timeout", "success"]) {
        if ((yield* manager.inspectSession({ threadId, terminalId })) === "active") {
          yield* manager.kill({ threadId, terminalId });
        }
      }

      assert.equal(error._tag, "TerminalProcessTerminationError");
      expect(observedForceThrowSignals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(observedForceTimeoutSignals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(observedSuccessSignals).toEqual(["SIGTERM"]);
      assert.equal(observedForceThrowState, "active");
      assert.equal(observedForceTimeoutState, "active");
      assert.equal(observedSuccessState, "missing");
    }).pipe(Effect.provide(Layer.merge(withHostPlatform("linux"), TestClock.layer()))),
  );

  it.effect("scope finalizer 隔离单个终止失败并保留其监督 handle", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* makeManager().pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      const threadId = "finalizer-isolation";
      yield* openTerminal(manager, threadId, "first");
      yield* openTerminal(manager, threadId, "second");
      const first = ptyAdapter.processes[0];
      const second = ptyAdapter.processes[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) return;
      first.killFailures.set(undefined, new Error("finalizer signal failed"));

      yield* Scope.close(scope, Exit.void);

      expect(first.killSignals).toEqual([undefined]);
      expect(second.killSignals).toEqual([undefined]);
      assert.equal(yield* manager.inspectSession({ threadId, terminalId: "first" }), "active");
      assert.equal(yield* manager.inspectSession({ threadId, terminalId: "second" }), "missing");

      first.killFailures.delete(undefined);
      const retryCompletion = yield* manager
        .kill({ threadId, terminalId: "first" })
        .pipe(Effect.exit, Effect.timeoutOption("500 millis"));

      assert.isTrue(Option.isSome(retryCompletion));
      if (Option.isSome(retryCompletion)) {
        assert.isTrue(Exit.isSuccess(retryCompletion.value));
      }
      expect(first.killSignals).toEqual([undefined, undefined]);
      assert.equal(yield* manager.inspectSession({ threadId, terminalId: "first" }), "missing");
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("scope finalizer 在真实退出超时后保留同一 process handle", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* makeManager({
        processKillGraceMs: 10,
        processExitTimeoutMs: 20,
      }).pipe(Effect.provideService(Scope.Scope, scope));
      const threadId = "finalizer-exit-timeout";
      yield* openTerminal(manager, threadId, DEFAULT_TERMINAL_ID);
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.exitOnKillSignals.clear();

      const closeFiber = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("30 millis");
      const closeExit = yield* Fiber.await(closeFiber);

      assert.isTrue(Exit.isSuccess(closeExit));
      expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
      assert.equal(
        yield* manager.inspectSession({ threadId, terminalId: DEFAULT_TERMINAL_ID }),
        "active",
      );

      process.exitOnKillSignals.add("SIGTERM");
      const retryCompletion = yield* manager
        .kill({ threadId, terminalId: DEFAULT_TERMINAL_ID })
        .pipe(Effect.exit, Effect.timeoutOption("500 millis"));

      assert.isTrue(Option.isSome(retryCompletion));
      if (Option.isSome(retryCompletion)) {
        assert.isTrue(Exit.isSuccess(retryCompletion.value));
      }
      expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM"]);
      assert.equal(
        yield* manager.inspectSession({ threadId, terminalId: DEFAULT_TERMINAL_ID }),
        "missing",
      );
    }).pipe(Effect.provide(Layer.merge(withHostPlatform("linux"), TestClock.layer()))),
  );

  it.effect("shutdown gate 收口在途 spawn 并拒绝快照后的新 session", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* makeManager().pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      yield* openTerminal(manager, "shutdown-anchor", DEFAULT_TERMINAL_ID);
      const anchor = ptyAdapter.processes[0];
      expect(anchor).toBeDefined();
      if (!anchor) return;

      const { promise: spawnEntered, resolve: resolveSpawnEntered } = Promise.withResolvers<void>();
      const { promise: releaseSpawn, resolve: resolveSpawn } = Promise.withResolvers<void>();
      ptyAdapter.beforeNextSpawn = () => {
        resolveSpawnEntered();
        return releaseSpawn;
      };
      const inFlightOpen = yield* openTerminal(
        manager,
        "shutdown-in-flight",
        DEFAULT_TERMINAL_ID,
      ).pipe(Effect.forkChild);
      yield* Effect.promise(() => spawnEntered);

      const { promise: shutdownStarted, resolve: resolveShutdownStarted } =
        Promise.withResolvers<void>();
      anchor.onKill = () => resolveShutdownStarted();
      const closeFiber = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
      yield* Effect.promise(() => shutdownStarted);

      const rejected = yield* openTerminal(
        manager,
        "shutdown-after-gate",
        DEFAULT_TERMINAL_ID,
      ).pipe(Effect.exit);
      resolveSpawn();
      const inFlightExit = yield* Fiber.await(inFlightOpen);
      const closeExit = yield* Fiber.await(closeFiber);

      assert.isTrue(Exit.isFailure(rejected));
      if (Exit.isFailure(rejected)) {
        const error = Cause.squash(rejected.cause);
        assert.instanceOf(error, TerminalManagerShutdownError);
      }
      assert.isTrue(Exit.isSuccess(inFlightExit));
      assert.isTrue(Exit.isSuccess(closeExit));
      assert.equal(ptyAdapter.processes.length, 2);
      assert.equal(
        yield* manager.inspectSession({
          threadId: "shutdown-in-flight",
          terminalId: DEFAULT_TERMINAL_ID,
        }),
        "missing",
      );
      assert.equal(
        yield* manager.inspectSession({
          threadId: "shutdown-after-gate",
          terminalId: DEFAULT_TERMINAL_ID,
        }),
        "missing",
      );
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("closed 生命周期等待全部 retained exit drain 完成后再关闭终止资源", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const slowUnregisterStarted = yield* Deferred.make<void>();
      const releaseSlowUnregister = yield* Deferred.make<void>();
      const fastDrained = yield* Deferred.make<void>();
      const slowDrained = yield* Deferred.make<void>();
      const { manager, ptyAdapter } = yield* makeManager({
        unregisterTerminal: ({ terminalId }) =>
          terminalId === "slow"
            ? Deferred.succeed(slowUnregisterStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseSlowUnregister)),
              )
            : Effect.void,
        onExitDrained: ({ terminalId }) =>
          terminalId === "slow"
            ? Deferred.succeed(slowDrained, undefined).pipe(Effect.asVoid)
            : Deferred.succeed(fastDrained, undefined).pipe(Effect.asVoid),
      }).pipe(Effect.provideService(Scope.Scope, scope));
      const threadId = "retained-exit-drains";
      yield* openTerminal(manager, threadId, "fast");
      yield* openTerminal(manager, threadId, "slow");
      const fast = ptyAdapter.processes[0];
      const slow = ptyAdapter.processes[1];
      expect(fast).toBeDefined();
      expect(slow).toBeDefined();
      if (!fast || !slow) return;
      fast.killFailures.set(undefined, new Error("retain fast"));
      slow.killFailures.set(undefined, new Error("retain slow"));

      yield* Scope.close(scope, Exit.void);
      slow.emitExit({ exitCode: 0, signal: null });
      yield* Deferred.await(slowUnregisterStarted);
      fast.emitExit({ exitCode: 0, signal: null });
      yield* Deferred.await(fastDrained);

      assert.equal(yield* manager.inspectSession({ threadId, terminalId: "fast" }), "missing");
      assert.equal(yield* manager.inspectSession({ threadId, terminalId: "slow" }), "inactive");

      yield* Deferred.succeed(releaseSlowUnregister, undefined);
      const slowCompletion = yield* Deferred.await(slowDrained).pipe(
        Effect.timeoutOption("500 millis"),
      );

      assert.isTrue(Option.isSome(slowCompletion));
      assert.equal(yield* manager.inspectSession({ threadId, terminalId: "slow" }), "missing");
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("closing 期间已退出的 retained session 会保活退出持久化资源", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const unregisterStarted = yield* Deferred.make<void>();
      const releaseUnregister = yield* Deferred.make<void>();
      const exitDrained = yield* Deferred.make<void>();
      const { manager, ptyAdapter } = yield* makeManager({
        unregisterTerminal: ({ terminalId }) =>
          terminalId === "draining"
            ? Deferred.succeed(unregisterStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseUnregister)),
              )
            : Effect.void,
        onExitDrained: ({ terminalId }) =>
          terminalId === "draining"
            ? Deferred.succeed(exitDrained, undefined).pipe(Effect.asVoid)
            : Effect.void,
      }).pipe(Effect.provideService(Scope.Scope, scope));
      const threadId = "closing-exit-drain";
      yield* openTerminal(manager, threadId, "draining");
      yield* openTerminal(manager, threadId, "anchor");
      const draining = ptyAdapter.processes[0];
      const anchor = ptyAdapter.processes[1];
      expect(draining).toBeDefined();
      expect(anchor).toBeDefined();
      if (!draining || !anchor) return;

      draining.killFailures.set(undefined, new Error("retain draining process"));
      anchor.exitOnKillSignals.clear();
      const { promise: drainingKillStarted, resolve: resolveDrainingKillStarted } =
        Promise.withResolvers<void>();
      const { promise: anchorKillStarted, resolve: resolveAnchorKillStarted } =
        Promise.withResolvers<void>();
      draining.onKill = () => resolveDrainingKillStarted();
      anchor.onKill = () => resolveAnchorKillStarted();

      const closeFiber = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
      yield* Effect.promise(() => Promise.all([drainingKillStarted, anchorKillStarted]));
      draining.emitExit({ exitCode: 0, signal: null });
      yield* Deferred.await(unregisterStarted);
      anchor.emitExit({ exitCode: 0, signal: null });

      const closeCompletion = yield* Fiber.await(closeFiber).pipe(
        Effect.timeoutOption("500 millis"),
      );
      assert.isTrue(Option.isSome(closeCompletion));
      assert.equal(yield* manager.inspectSession({ threadId, terminalId: "draining" }), "inactive");

      yield* Deferred.succeed(releaseUnregister, undefined);
      const drainCompletion = yield* Deferred.await(exitDrained).pipe(
        Effect.timeoutOption("500 millis"),
      );
      assert.isTrue(Option.isSome(drainCompletion));
      assert.equal(yield* manager.inspectSession({ threadId, terminalId: "draining" }), "missing");
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("process commit 后取消不会注销已托管的退出观察器", () =>
    Effect.gen(function* () {
      const processCommitted = yield* Deferred.make<void>();
      const { manager, ptyAdapter } = yield* makeManager({
        afterProcessCommitted: () =>
          Deferred.succeed(processCommitted, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const threadId = "activation-commit-interrupt";
      ptyAdapter.configureNextProcess = (process) => {
        process.killFailures.set(undefined, new Error("retain committed process"));
      };

      const openFiber = yield* openTerminal(manager, threadId, DEFAULT_TERMINAL_ID).pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(processCommitted);
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const interruption = yield* Fiber.interrupt(openFiber).pipe(
        Effect.timeoutOption("500 millis"),
      );
      assert.isTrue(Option.isSome(interruption));
      assert.equal(
        yield* manager.inspectSession({ threadId, terminalId: DEFAULT_TERMINAL_ID }),
        "active",
      );
      assert.equal(process.exitListenerCount, 1);

      process.killFailures.delete(undefined);
      const recovery = yield* manager
        .kill({ threadId, terminalId: DEFAULT_TERMINAL_ID })
        .pipe(Effect.timeoutOption("500 millis"));
      assert.isTrue(Option.isSome(recovery));
      assert.equal(
        yield* manager.inspectSession({ threadId, terminalId: DEFAULT_TERMINAL_ID }),
        "inactive",
      );
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("gap 领取后若真实 exit 先赢则不会再向旧 handle 发信号", () =>
    Effect.gen(function* () {
      const exitDrained = yield* Deferred.make<void>();
      let process: LifecyclePtyProcess | null = null;
      const { manager, ptyAdapter } = yield* makeManager({
        afterGapTerminationClaimed: () =>
          Effect.sync(() => process?.emitExit({ exitCode: 0, signal: null })),
        onExitDrained: () => Deferred.succeed(exitDrained, undefined).pipe(Effect.asVoid),
      });
      const threadId = "gap-exit-before-signal";
      const terminalId = DEFAULT_TERMINAL_ID;
      yield* openTerminal(manager, threadId, terminalId);
      process = ptyAdapter.processes[0] ?? null;
      expect(process).not.toBeNull();
      if (!process) return;
      process.exitObservation = {
        status: "gap",
        cause: new Error("native exit observer coverage was lost"),
      };
      process.exitOnKillSignals.clear();

      yield* manager.kill({ threadId, terminalId }).pipe(Effect.exit);
      yield* Deferred.await(exitDrained);

      expect(process.killSignals).toEqual([]);
      assert.equal(yield* manager.inspectSession({ threadId, terminalId }), "inactive");
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("Node 风格无重放缺口会隔离同一 handle 并阻止同 ID 重启", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* makeManager().pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      const threadId = "node-observation-gap";
      const terminalId = DEFAULT_TERMINAL_ID;
      ptyAdapter.configureNextProcess = (process) => {
        process.exitObservation = {
          status: "gap",
          cause: new Error("native exit observer coverage was lost"),
        };
        process.replayExitToLateSubscribers = false;
        process.emitExit({ exitCode: 19, signal: null });
      };

      const snapshot = yield* openTerminal(manager, threadId, terminalId);
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      const historyBefore = yield* manager.getHistory({ threadId, terminalId });

      expect(snapshot).toMatchObject({ status: "error", pid: process.pid });
      assert.equal(yield* manager.inspectSession({ threadId, terminalId }), "quarantined");
      expect(process.killSignals).toEqual([undefined]);

      const killError = yield* manager.kill({ threadId, terminalId }).pipe(Effect.flip);
      assert.instanceOf(killError, TerminalProcessTerminationError);
      assert.equal(killError.reason, "exit-observation-gap");

      yield* openTerminal(manager, threadId, terminalId);
      yield* manager.runCommand({
        threadId,
        terminalId,
        cwd: globalThis.process.cwd(),
        command: "ignored-after-quarantine",
      });
      const clearError = yield* manager.clear({ threadId, terminalId }).pipe(Effect.flip);
      const restartError = yield* manager
        .restart({
          threadId,
          terminalId,
          cwd: globalThis.process.cwd(),
          cols: 100,
          rows: 24,
        })
        .pipe(Effect.flip);
      const closeError = yield* manager.close({ threadId, terminalId }).pipe(Effect.flip);

      assert.instanceOf(clearError, TerminalProcessTerminationError);
      assert.equal(clearError.reason, "exit-observation-gap");
      assert.instanceOf(restartError, TerminalProcessTerminationError);
      assert.equal(restartError.reason, "exit-observation-gap");
      assert.instanceOf(closeError, TerminalProcessTerminationError);
      assert.equal(closeError.reason, "exit-observation-gap");
      assert.equal(ptyAdapter.processes.length, 1);
      expect(process.killSignals).toEqual([undefined]);
      assert.equal(yield* manager.getHistory({ threadId, terminalId }), historyBefore);

      const closeScopeCompletion = yield* Scope.close(scope, Exit.void).pipe(
        Effect.timeoutOption("500 millis"),
      );
      assert.isTrue(Option.isSome(closeScopeCompletion));
      assert.equal(yield* manager.inspectSession({ threadId, terminalId }), "quarantined");
      expect(process.killSignals).toEqual([undefined]);
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("quarantined handle 的未来真实 exit 会解除隔离并完整收口", () =>
    Effect.gen(function* () {
      const exitDrained = yield* Deferred.make<void>();
      const { manager, ptyAdapter } = yield* makeManager({
        onExitDrained: () => Deferred.succeed(exitDrained, undefined).pipe(Effect.asVoid),
      });
      const threadId = "quarantine-future-exit";
      const terminalId = DEFAULT_TERMINAL_ID;
      ptyAdapter.configureNextProcess = (process) => {
        process.exitObservation = {
          status: "gap",
          cause: new Error("native exit observer coverage was lost"),
        };
        process.replayExitToLateSubscribers = false;
        process.exitOnKillSignals.clear();
      };

      yield* openTerminal(manager, threadId, terminalId);
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      assert.equal(yield* manager.inspectSession({ threadId, terminalId }), "quarantined");
      expect(process.killSignals).toEqual([undefined]);

      process.emitExit({ exitCode: 0, signal: null });
      const drained = yield* Deferred.await(exitDrained).pipe(Effect.timeoutOption("500 millis"));

      assert.isTrue(Option.isSome(drained));
      assert.equal(process.exitObservation.status, "reliable");
      assert.equal(yield* manager.inspectSession({ threadId, terminalId }), "inactive");
      yield* manager.close({ threadId, terminalId });
      assert.equal(yield* manager.inspectSession({ threadId, terminalId }), "missing");
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("Unix quarantine 不向可能复用的裸 PID 发送信号", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* makeManager();
      const threadId = "unix-observation-gap";
      const terminalId = DEFAULT_TERMINAL_ID;
      ptyAdapter.configureNextProcess = (process) => {
        process.exitObservation = {
          status: "gap",
          cause: new Error("native exit observer coverage was lost"),
        };
        process.exitOnKillSignals.clear();
      };

      yield* openTerminal(manager, threadId, terminalId);
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const firstRetry = yield* manager.kill({ threadId, terminalId }).pipe(Effect.flip);
      const secondRetry = yield* manager.kill({ threadId, terminalId }).pipe(Effect.flip);
      yield* TestClock.adjust("5 seconds");

      assert.instanceOf(firstRetry, TerminalProcessTerminationError);
      assert.equal(firstRetry.reason, "exit-observation-gap");
      assert.equal(firstRetry.signal, null);
      assert.instanceOf(secondRetry, TerminalProcessTerminationError);
      assert.equal(secondRetry.reason, "exit-observation-gap");
      assert.equal(secondRetry.signal, null);
      expect(process.killSignals).toEqual([]);
      assert.equal(yield* manager.inspectSession({ threadId, terminalId }), "quarantined");
    }).pipe(Effect.provide(Layer.merge(withHostPlatform("linux"), TestClock.layer()))),
  );

  it.effect("onData 注册抛错时释放本地 handle 且 session 进入 error", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* makeManager();
      const threadId = "activation-on-data-failure";
      const errorEvent = yield* Deferred.make<Extract<TerminalEvent, { type: "error" }>>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.threadId === threadId && event.type === "error"
          ? Deferred.succeed(errorEvent, event).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      ptyAdapter.configureNextProcess = (process) => {
        process.dataRegistrationFailures.push(new Error("onData registration failed"));
      };

      const snapshot = yield* openTerminal(manager, threadId, DEFAULT_TERMINAL_ID);
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      const event = yield* Deferred.await(errorEvent);

      expect(snapshot).toMatchObject({ status: "error", pid: null });
      expect(event.message).toContain("data listener");
      expect(process.killSignals).toEqual([undefined]);
      assert.equal(process.dataListenerCount, 0);
      assert.equal(process.exitListenerCount, 0);
      assert.equal(
        yield* manager.inspectSession({ threadId, terminalId: DEFAULT_TERMINAL_ID }),
        "inactive",
      );
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("onExit 注册抛错时注销 data listener 并等待 Unix TERM 真实退出", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* makeManager();
      const threadId = "activation-on-exit-failure";
      ptyAdapter.configureNextProcess = (process) => {
        process.exitRegistrationFailures.push(new Error("onExit registration failed"));
      };

      const snapshot = yield* openTerminal(manager, threadId, DEFAULT_TERMINAL_ID);
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      expect(snapshot).toMatchObject({ status: "error", pid: null });
      expect(process.killSignals).toEqual(["SIGTERM"]);
      assert.equal(process.dataListenerCount, 0);
      assert.equal(process.exitListenerCount, 0);
      assert.equal(
        yield* manager.inspectSession({ threadId, terminalId: DEFAULT_TERMINAL_ID }),
        "inactive",
      );
    }).pipe(Effect.provide(withHostPlatform("linux"))),
  );

  it.effect("激活清理终止失败时保留监督且不受 inactive 淘汰", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* makeManager({ maxRetainedInactiveSessions: 0 });
      const threadId = "activation-cleanup-termination-failure";
      ptyAdapter.configureNextProcess = (process) => {
        process.exitRegistrationFailures.push(new Error("onExit registration failed"));
        process.dataDisposalFailures.push(new Error("data disposal failed"));
        process.killFailures.set(undefined, new Error("cleanup signal failed"));
      };

      const snapshot = yield* openTerminal(manager, threadId, DEFAULT_TERMINAL_ID);
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      expect(snapshot).toMatchObject({ status: "error", pid: process.pid });
      expect(process.killSignals).toEqual([undefined]);
      assert.equal(process.dataListenerCount, 1);
      assert.equal(process.exitListenerCount, 1);
      assert.equal(
        yield* manager.inspectSession({ threadId, terminalId: DEFAULT_TERMINAL_ID }),
        "active",
      );

      process.killFailures.delete(undefined);
      yield* manager.kill({ threadId, terminalId: DEFAULT_TERMINAL_ID });

      expect(process.killSignals).toEqual([undefined, undefined]);
      assert.equal(process.dataListenerCount, 0);
      assert.equal(process.exitListenerCount, 0);
      assert.equal(
        yield* manager.inspectSession({ threadId, terminalId: DEFAULT_TERMINAL_ID }),
        "missing",
      );
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("观察器缺失窗口自然退出后迟订阅重放可收口", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* makeManager();
      const threadId = "activation-observer-synchronous-exit";
      ptyAdapter.configureNextProcess = (process) => {
        process.dataRegistrationFailures.push(new Error("onData registration failed"));
        process.exitRegistrationFailures.push(new Error("onExit registration failed"));
        process.exitOnKillSignals.clear();
      };

      const snapshot = yield* openTerminal(manager, threadId, DEFAULT_TERMINAL_ID);
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      expect(snapshot).toMatchObject({ status: "error", pid: process.pid });
      expect(process.killSignals).toEqual([]);
      assert.equal(process.exitListenerCount, 0);

      process.emitExit({ exitCode: 0, signal: null });
      yield* manager.kill({ threadId, terminalId: DEFAULT_TERMINAL_ID });

      expect(process.killSignals).toEqual([]);
      assert.equal(process.exitListenerCount, 0);
      assert.equal(
        yield* manager.inspectSession({ threadId, terminalId: DEFAULT_TERMINAL_ID }),
        "inactive",
      );
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("listener 注销抛错不会阻断真实退出收口", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* makeManager();
      const threadId = "listener-disposal-failure";
      yield* openTerminal(manager, threadId, DEFAULT_TERMINAL_ID);
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.dataDisposalFailures.push(new Error("data disposal failed"));

      const completion = yield* manager
        .kill({ threadId, terminalId: DEFAULT_TERMINAL_ID })
        .pipe(Effect.exit, Effect.timeoutOption("200 millis"));

      assert.isTrue(Option.isSome(completion));
      if (Option.isSome(completion)) {
        assert.isTrue(Exit.isSuccess(completion.value));
      }
      assert.equal(process.exitListenerCount, 0);
      assert.equal(
        yield* manager.inspectSession({ threadId, terminalId: DEFAULT_TERMINAL_ID }),
        "inactive",
      );
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("公开 kill 与 scope finalizer 并发时只补建一个退出观察器", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* makeManager().pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      const threadId = "observer-single-flight";
      ptyAdapter.configureNextProcess = (process) => {
        process.dataRegistrationFailures.push(new Error("onData registration failed"));
        process.exitRegistrationFailures.push(new Error("onExit registration failed"));
      };
      const snapshot = yield* openTerminal(manager, threadId, DEFAULT_TERMINAL_ID);
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      expect(snapshot).toMatchObject({ status: "error", pid: process.pid });

      const { promise: observerRegistrationStarted, resolve: resolveObserverRegistrationStarted } =
        Promise.withResolvers<void>();
      process.onExitRegistration = () => {
        resolveObserverRegistrationStarted();
      };
      const closeFiber = yield* Effect.promise(() => observerRegistrationStarted).pipe(
        Effect.andThen(Scope.close(scope, Exit.void)),
        Effect.forkChild,
      );

      const killCompletion = yield* manager
        .kill({ threadId, terminalId: DEFAULT_TERMINAL_ID })
        .pipe(Effect.exit, Effect.timeoutOption("500 millis"));
      assert.isTrue(Option.isSome(killCompletion));
      if (Option.isSome(killCompletion)) {
        assert.isTrue(Exit.isSuccess(killCompletion.value));
      }
      const closeExit = yield* Fiber.await(closeFiber);
      assert.isTrue(Exit.isSuccess(closeExit));

      assert.equal(process.exitRegistrationCount, 1);
      assert.equal(process.exitListenerCount, 0);
      assert.equal(
        yield* manager.inspectSession({ threadId, terminalId: DEFAULT_TERMINAL_ID }),
        "missing",
      );
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );
});
