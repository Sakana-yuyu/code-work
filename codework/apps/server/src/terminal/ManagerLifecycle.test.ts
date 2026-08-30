import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_TERMINAL_ID, type TerminalEvent } from "@codework/contracts";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
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
  readonly killSignals: Array<string | undefined> = [];
  readonly killFailures = new Map<string | undefined, unknown>();
  exitOnKillSignals = new Set<string | undefined>([undefined, "SIGTERM", "SIGKILL"]);
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();

  readonly pid: number;

  constructor(pid: number) {
    this.pid = pid;
  }

  write(): void {}

  resize(): void {}

  kill(signal?: string): void {
    this.killSignals.push(signal);
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
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }

  private emitExit(event: PtyAdapter.PtyExitEvent): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

class LifecyclePtyAdapter {
  readonly processes: LifecyclePtyProcess[] = [];
  private nextPid = 12_000;

  spawn(): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    const process = new LifecyclePtyProcess(this.nextPid++);
    this.processes.push(process);
    return Effect.succeed(process);
  }
}

const makeManager = (
  options: {
    readonly processKillGraceMs?: number;
    readonly processExitTimeoutMs?: number;
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

  it.effect("scope finalizer 隔离单个终止失败并清空全部 session 状态", () =>
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
      assert.equal(yield* manager.inspectSession({ threadId, terminalId: "first" }), "missing");
      assert.equal(yield* manager.inspectSession({ threadId, terminalId: "second" }), "missing");
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );
});
