import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  type TerminalAttachStreamEvent,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
  type TerminalRestartInput,
  type TerminalSessionSnapshot,
} from "@codework/contracts";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "./Manager.ts";
import * as PtyAdapter from "./PtyAdapter.ts";
import { makeWorkspaceScriptTerminalOwner } from "./TerminalSessionOwnership.ts";

class WaitForConditionError extends Data.TaggedError("WaitForConditionError")<{
  readonly message: string;
}> {}

class FakePtyProcess implements PtyAdapter.PtyProcess {
  exitObservation: PtyAdapter.PtyExitObservation = { status: "reliable" };
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  readonly killSignals: Array<string | undefined> = [];
  readonly pid: number;
  readonly killFailures = new Map<string | undefined, unknown>();
  exitOnKillSignals = new Set<string | undefined>([undefined, "SIGTERM", "SIGKILL"]);
  onKill: ((signal: string | undefined) => void) | null = null;
  writeFailure: unknown | undefined;
  resizeFailure: unknown | undefined;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  killed = false;

  constructor(pid: number) {
    this.pid = pid;
  }

  write(data: string): void {
    if (this.writeFailure !== undefined) {
      throw this.writeFailure;
    }
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    if (this.resizeFailure !== undefined) {
      throw this.resizeFailure;
    }
    this.resizeCalls.push({ cols, rows });
  }

  kill(signal?: string): void {
    this.killed = true;
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
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
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
  readonly spawnInputs: PtyAdapter.PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  readonly spawnFailures: Error[] = [];
  private readonly mode: "sync" | "async";
  private nextPid = 9000;

  constructor(mode: "sync" | "async" = "sync") {
    this.mode = mode;
  }

  spawn(
    input: PtyAdapter.PtySpawnInput,
  ): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    this.spawnInputs.push(input);
    const failure = this.spawnFailures.shift();
    if (failure) {
      return Effect.fail(
        new PtyAdapter.PtySpawnError({
          adapter: "fake",
          shell: input.shell,
          cause: failure,
        }),
      );
    }
    const process = new FakePtyProcess(this.nextPid++);
    this.processes.push(process);
    if (this.mode === "async") {
      return Effect.tryPromise({
        try: async () => process,
        catch: (cause) =>
          new PtyAdapter.PtySpawnError({
            adapter: "fake",
            shell: input.shell,
            cause,
          }),
      });
    }
    return Effect.succeed(process);
  }
}

const waitFor = <E, R>(
  predicate: Effect.Effect<boolean, E, R>,
  timeout: Duration.Input = 800,
): Effect.Effect<void, WaitForConditionError | E, R> =>
  predicate.pipe(
    Effect.filterOrFail(
      (done) => done,
      () => new WaitForConditionError({ message: "Condition not met" }),
    ),
    Effect.retry(Schedule.spaced("15 millis")),
    Effect.timeoutOption(timeout),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () =>
          Effect.fail(new WaitForConditionError({ message: "Timed out waiting for condition" })),
        onSome: () => Effect.void,
      }),
    ),
  );

function openInput(overrides: Partial<TerminalOpenInput> = {}): TerminalOpenInput {
  return {
    threadId: "thread-1",
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

function restartInput(overrides: Partial<TerminalRestartInput> = {}): TerminalRestartInput {
  return {
    threadId: "thread-1",
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

const workspaceScriptOwner = (generation = 1) =>
  makeWorkspaceScriptTerminalOwner({
    workspaceScriptRunId: "workspace-script-run:operation-owner",
    generation,
  });

const historyLogPath = (logsDir: string, threadId = "thread-1") =>
  Effect.service(Path.Path).pipe(
    Effect.map(({ join }) => join(logsDir, `terminal_${Encoding.encodeBase64Url(threadId)}.log`)),
  );

const multiTerminalHistoryLogPath = (
  logsDir: string,
  threadId = "thread-1",
  terminalId = DEFAULT_TERMINAL_ID,
) =>
  Effect.service(Path.Path).pipe(
    Effect.map(({ join }) => {
      const threadPart = `terminal_${Encoding.encodeBase64Url(threadId)}`;
      return join(
        logsDir,
        terminalId === DEFAULT_TERMINAL_ID
          ? `${threadPart}.log`
          : `${threadPart}_${Encoding.encodeBase64Url(terminalId)}.log`,
      );
    }),
  );

interface CreateManagerOptions {
  shellResolver?: () => string;
  env?: NodeJS.ProcessEnv;
  subprocessInspector?: (terminalPid: number) => Effect.Effect<{
    readonly hasRunningSubprocess: boolean;
    readonly childCommand: string | null;
    readonly processIds: ReadonlyArray<number>;
  }>;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  processExitTimeoutMs?: number;
  maxRetainedInactiveSessions?: number;
  unregisterTerminal?: (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) => Effect.Effect<void>;
  ptyAdapter?: FakePtyAdapter;
}

interface ManagerFixture {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly ptyAdapter: FakePtyAdapter;
  readonly manager: TerminalManager.TerminalManager["Service"];
  readonly getEvents: Effect.Effect<ReadonlyArray<TerminalEvent>>;
}

const createManager = (
  historyLineLimit = 5,
  options: CreateManagerOptions = {},
): Effect.Effect<
  ManagerFixture,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Scope.Scope | ProcessRunner.ProcessRunner
> =>
  Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "codework-terminal-" });
      const logsDir = join(baseDir, "userdata", "logs", "terminals");
      const ptyAdapter = options.ptyAdapter ?? new FakePtyAdapter();

      const manager = yield* TerminalManager.makeWithOptions({
        logsDir,
        historyLineLimit,
        ptyAdapter,
        ...(options.shellResolver !== undefined ? { shellResolver: options.shellResolver } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.subprocessInspector !== undefined
          ? { subprocessInspector: options.subprocessInspector }
          : {}),
        ...(options.subprocessPollIntervalMs !== undefined
          ? { subprocessPollIntervalMs: options.subprocessPollIntervalMs }
          : {}),
        processKillGraceMs: options.processKillGraceMs ?? 1,
        processExitTimeoutMs: options.processExitTimeoutMs ?? 1_000,
        ...(options.maxRetainedInactiveSessions !== undefined
          ? { maxRetainedInactiveSessions: options.maxRetainedInactiveSessions }
          : {}),
        ...(options.unregisterTerminal !== undefined
          ? { unregisterTerminal: options.unregisterTerminal }
          : {}),
      });
      const eventsRef = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(eventsRef, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      return {
        baseDir,
        logsDir,
        join,
        ptyAdapter,
        manager,
        getEvents: Ref.get(eventsRef),
      };
    }),
  );

const withHostPlatform = (platform: NodeJS.Platform) =>
  Layer.succeed(HostProcessPlatform, platform);

it.layer(
  Layer.merge(NodeServices.layer, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
  { excludeTestServices: true },
)("TerminalManager", (it) => {
  it.effect("spawns lazily and reuses running terminal per thread", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const [first, second] = yield* Effect.all(
        [manager.open(openInput()), manager.open(openInput())],
        { concurrency: "unbounded" },
      );
      const third = yield* manager.open(openInput());

      assert.equal(first.threadId, "thread-1");
      assert.equal(first.terminalId, DEFAULT_TERMINAL_ID);
      assert.equal(second.threadId, "thread-1");
      assert.equal(third.threadId, "thread-1");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("直接以 executable 和 argv 启动命令进程并保留退出快照", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager();

      const opened = yield* manager.runCommand({
        threadId: "run-command-1",
        terminalId: "command-1",
        cwd: process.cwd(),
        command: "example-command",
        args: ["--flag", "value with spaces"],
      });
      assert.equal(opened.status, "running");
      expect(ptyAdapter.spawnInputs[0]).toMatchObject({
        shell: "example-command",
        args: ["--flag", "value with spaces"],
      });

      const processHandle = ptyAdapter.processes[0];
      expect(processHandle).toBeDefined();
      if (!processHandle) return;
      processHandle.emitData("command-output\n");
      processHandle.emitExit({ exitCode: 7, signal: 0 });
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "exited" &&
              event.threadId === "run-command-1" &&
              event.terminalId === "command-1",
          ),
        ),
      );

      let snapshot: TerminalSessionSnapshot | undefined;
      const unsubscribe = yield* manager.attachStream(
        { threadId: "run-command-1", terminalId: "command-1" },
        (event) =>
          Effect.sync(() => {
            if (event.type === "snapshot") snapshot = event.snapshot;
          }),
      );
      unsubscribe();
      expect(snapshot).toMatchObject({
        status: "exited",
        history: "command-output\n",
        exitCode: 7,
      });
    }),
  );

  it.effect("受监督命令拒绝复用已被普通终端预占的 terminalId", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const terminalId = "workspace-script-operation-owner";
      yield* manager.open(openInput({ threadId: "owner-preempt", terminalId }));
      const original = ptyAdapter.processes[0];
      expect(original).toBeDefined();
      if (!original) return;

      const error = yield* manager
        .runCommand({
          threadId: "owner-preempt",
          terminalId,
          cwd: process.cwd(),
          command: "workspace-script-command",
          owner: workspaceScriptOwner(),
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "TerminalSessionOwnershipError");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      assert.equal(original.killed, false);
    }),
  );

  it.effect("错误 owner generation 不得终止受监督命令", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const terminalId = "workspace-script-operation-owner-kill";
      yield* manager.runCommand({
        threadId: "owner-kill",
        terminalId,
        cwd: process.cwd(),
        command: "workspace-script-command",
        owner: workspaceScriptOwner(7),
      });
      const processHandle = ptyAdapter.processes[0];
      expect(processHandle).toBeDefined();
      if (!processHandle) return;

      const error = yield* manager
        .kill({
          threadId: "owner-kill",
          terminalId,
          expectedOwner: workspaceScriptOwner(8),
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "TerminalSessionOwnershipError");
      assert.equal(processHandle.killed, false);
    }),
  );

  it.effect("owner generation 在重复访问中保持并约束 session inspection", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const terminalId = "workspace-script-operation-owner-inspect";
      const owner = workspaceScriptOwner(11);
      const first = yield* manager.runCommand({
        threadId: "owner-inspect",
        terminalId,
        cwd: process.cwd(),
        command: "workspace-script-command",
        owner,
      });
      const repeated = yield* manager.runCommand({
        threadId: "owner-inspect",
        terminalId,
        cwd: process.cwd(),
        command: "workspace-script-command",
        owner: workspaceScriptOwner(11),
      });
      const active = yield* manager.inspectSession({
        threadId: "owner-inspect",
        terminalId,
        expectedOwner: workspaceScriptOwner(11),
      });
      const receipt = yield* manager.inspectSessionReceipt({
        threadId: "owner-inspect",
        terminalId,
        expectedOwner: workspaceScriptOwner(11),
      });
      const wrongGeneration = yield* manager
        .inspectSession({
          threadId: "owner-inspect",
          terminalId,
          expectedOwner: workspaceScriptOwner(12),
        })
        .pipe(Effect.flip);
      const wrongReceiptGeneration = yield* manager
        .inspectSessionReceipt({
          threadId: "owner-inspect",
          terminalId,
          expectedOwner: workspaceScriptOwner(12),
        })
        .pipe(Effect.flip);

      assert.equal(first.pid, repeated.pid);
      assert.equal(active, "active");
      assert.equal(receipt.inspection, "active");
      expect(receipt.snapshot).toMatchObject({ status: "running", pid: first.pid });
      assert.equal(wrongGeneration._tag, "TerminalSessionOwnershipError");
      assert.equal(wrongReceiptGeneration._tag, "TerminalSessionOwnershipError");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("退出状态已落入 Manager 而事件尚未发布时 receipt 保留真实退出结果", () =>
    Effect.gen(function* () {
      const unregisterStarted = yield* Deferred.make<void>();
      const releaseUnregister = yield* Deferred.make<void>();
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        unregisterTerminal: () =>
          Deferred.succeed(unregisterStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseUnregister)),
          ),
      });
      const threadId = "owner-exit-receipt";
      const terminalId = "workspace-script-operation-owner-exit-receipt";
      const owner = workspaceScriptOwner(14);
      yield* manager.runCommand({
        threadId,
        terminalId,
        cwd: process.cwd(),
        command: "workspace-script-command",
        owner,
      });
      const processHandle = ptyAdapter.processes[0];
      expect(processHandle).toBeDefined();
      if (!processHandle) return;

      processHandle.emitExit({ exitCode: 17, signal: null });
      yield* Deferred.await(unregisterStarted);
      const receipt = yield* manager.inspectSessionReceipt({
        threadId,
        terminalId,
        expectedOwner: owner,
      });

      assert.equal(receipt.inspection, "inactive");
      expect(receipt.snapshot).toMatchObject({
        status: "exited",
        pid: null,
        exitCode: 17,
        exitSignal: null,
      });
      expect((yield* getEvents).filter((event) => event.type === "exited")).toEqual([]);

      yield* Deferred.succeed(releaseUnregister, undefined);
      yield* waitFor(
        getEvents.pipe(Effect.map((events) => events.some((event) => event.type === "exited"))),
      );
    }),
  );

  it.effect("普通终端操作不得接管或关闭受监督 session", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const terminalId = "workspace-script-operation-owner-guard";
      const owner = workspaceScriptOwner(13);
      yield* manager.runCommand({
        threadId: "owner-guard",
        terminalId,
        cwd: process.cwd(),
        command: "workspace-script-command",
        owner,
      });
      const processHandle = ptyAdapter.processes[0];
      expect(processHandle).toBeDefined();
      if (!processHandle) return;

      const openError = yield* manager
        .open(openInput({ threadId: "owner-guard", terminalId }))
        .pipe(Effect.flip);
      const restartError = yield* manager
        .restart(restartInput({ threadId: "owner-guard", terminalId }))
        .pipe(Effect.flip);
      const closeError = yield* manager
        .close({ threadId: "owner-guard", terminalId })
        .pipe(Effect.flip);
      const inspection = yield* manager.inspectSession({
        threadId: "owner-guard",
        terminalId,
        expectedOwner: owner,
      });

      assert.equal(openError._tag, "TerminalSessionOwnershipError");
      assert.equal(restartError._tag, "TerminalSessionOwnershipError");
      assert.equal(closeError._tag, "TerminalSessionOwnershipError");
      assert.equal(inspection, "active");
      assert.equal(processHandle.killed, false);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("普通 write 不得向受监督 session 注入输入", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const terminalId = "workspace-script-operation-owner-write";
      const owner = workspaceScriptOwner(21);
      yield* manager.runCommand({
        threadId: "owner-write",
        terminalId,
        cwd: process.cwd(),
        command: "workspace-script-command",
        owner,
      });
      const processHandle = ptyAdapter.processes[0];
      expect(processHandle).toBeDefined();
      if (!processHandle) return;

      const error = yield* manager
        .write({ threadId: "owner-write", terminalId, data: "\u0003dangerous-command\r" })
        .pipe(Effect.flip);

      assert.equal(error._tag, "TerminalSessionOwnershipError");
      expect(processHandle.writes).toEqual([]);
      assert.equal(
        yield* manager.inspectSession({
          threadId: "owner-write",
          terminalId,
          expectedOwner: owner,
        }),
        "active",
      );
    }),
  );

  it.effect("普通 resize 不得改变受监督 PTY 尺寸", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const terminalId = "workspace-script-operation-owner-resize";
      const owner = workspaceScriptOwner(22);
      yield* manager.runCommand({
        threadId: "owner-resize",
        terminalId,
        cwd: process.cwd(),
        command: "workspace-script-command",
        owner,
      });
      const processHandle = ptyAdapter.processes[0];
      expect(processHandle).toBeDefined();
      if (!processHandle) return;

      const error = yield* manager
        .resize({ threadId: "owner-resize", terminalId, cols: 180, rows: 60 })
        .pipe(Effect.flip);

      assert.equal(error._tag, "TerminalSessionOwnershipError");
      expect(processHandle.resizeCalls).toEqual([]);
      assert.equal(
        yield* manager.inspectSession({
          threadId: "owner-resize",
          terminalId,
          expectedOwner: owner,
        }),
        "active",
      );
    }),
  );

  it.effect("普通 clear 不得擦除受监督历史，getHistory 保持只读可用", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager();
      const terminalId = "workspace-script-operation-owner-clear";
      const owner = workspaceScriptOwner(23);
      yield* manager.runCommand({
        threadId: "owner-clear",
        terminalId,
        cwd: process.cwd(),
        command: "workspace-script-command",
        owner,
      });
      const processHandle = ptyAdapter.processes[0];
      expect(processHandle).toBeDefined();
      if (!processHandle) return;
      processHandle.emitData("owned-log\n");
      yield* waitFor(
        manager
          .getHistory({ threadId: "owner-clear", terminalId })
          .pipe(Effect.map((history) => history === "owned-log\n")),
      );

      const error = yield* manager.clear({ threadId: "owner-clear", terminalId }).pipe(Effect.flip);

      assert.equal(error._tag, "TerminalSessionOwnershipError");
      assert.equal(
        yield* manager.getHistory({ threadId: "owner-clear", terminalId }),
        "owned-log\n",
      );
      expect(
        (yield* getEvents).filter(
          (event) => event.type === "cleared" && event.terminalId === terminalId,
        ),
      ).toEqual([]);
      assert.equal(
        yield* manager.inspectSession({
          threadId: "owner-clear",
          terminalId,
          expectedOwner: owner,
        }),
        "active",
      );
    }),
  );

  it.effect("generic attach 不得读取、resize 或重启受监督 session", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const threadId = "owner-attach";
      const terminalId = "workspace-script-operation-owner-attach";
      const owner = workspaceScriptOwner(24);
      yield* manager.runCommand({
        threadId,
        terminalId,
        cwd: process.cwd(),
        command: "workspace-script-command",
        owner,
      });
      const processHandle = ptyAdapter.processes[0];
      expect(processHandle).toBeDefined();
      if (!processHandle) return;
      let delivered = 0;

      const activeError = yield* manager
        .attachStream({ threadId, terminalId, cols: 180, rows: 60 }, () =>
          Effect.sync(() => void (delivered += 1)),
        )
        .pipe(Effect.flip);

      assert.equal(activeError._tag, "TerminalSessionOwnershipError");
      assert.equal(delivered, 0);
      expect(processHandle.resizeCalls).toEqual([]);
      assert.equal(
        yield* manager.inspectSession({ threadId, terminalId, expectedOwner: owner }),
        "active",
      );

      processHandle.emitExit({ exitCode: 0, signal: 0 });
      yield* waitFor(
        manager
          .inspectSession({ threadId, terminalId, expectedOwner: owner })
          .pipe(Effect.map((inspection) => inspection === "inactive")),
      );
      const inactiveError = yield* manager
        .attachStream(
          {
            threadId,
            terminalId,
            cwd: process.cwd(),
            restartIfNotRunning: true,
          },
          () => Effect.sync(() => void (delivered += 1)),
        )
        .pipe(Effect.flip);

      assert.equal(inactiveError._tag, "TerminalSessionOwnershipError");
      assert.equal(delivered, 0);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("close-all 跳过受监督 session 并继续关闭普通终端", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const threadId = "owner-close-all";
      const ownedTerminalId = "workspace-script-operation-owner-close-all";
      const ordinaryTerminalId = "ordinary-terminal";
      const owner = workspaceScriptOwner(25);
      yield* manager.runCommand({
        threadId,
        terminalId: ownedTerminalId,
        cwd: process.cwd(),
        command: "workspace-script-command",
        owner,
      });
      yield* manager.open(openInput({ threadId, terminalId: ordinaryTerminalId }));
      const ownedProcess = ptyAdapter.processes[0];
      const ordinaryProcess = ptyAdapter.processes[1];
      expect(ownedProcess).toBeDefined();
      expect(ordinaryProcess).toBeDefined();
      if (!ownedProcess || !ordinaryProcess) return;
      ownedProcess.emitData("owned-log\n");
      ordinaryProcess.emitData("ordinary-log\n");
      yield* waitFor(
        manager
          .getHistory({ threadId, terminalId: ownedTerminalId })
          .pipe(Effect.map((history) => history === "owned-log\n")),
      );
      yield* waitFor(
        manager
          .getHistory({ threadId, terminalId: ordinaryTerminalId })
          .pipe(Effect.map((history) => history === "ordinary-log\n")),
      );

      yield* manager.close({ threadId, deleteHistory: true });

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
      assert.equal(ownedProcess.killed, false);
      assert.equal(ordinaryProcess.killed, true);
      assert.equal(
        yield* manager.getHistory({ threadId, terminalId: ownedTerminalId }),
        "owned-log\n",
      );
      assert.equal(yield* manager.getHistory({ threadId, terminalId: ordinaryTerminalId }), "");
    }),
  );

  it.effect("运行中的 on_exit 命令从内存返回最新历史且不会创建额外 PTY", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager();
      yield* manager.runCommand({
        threadId: "run-history-live",
        terminalId: "command-history-live",
        cwd: process.cwd(),
        command: "long-running-command",
      });
      const processHandle = ptyAdapter.processes[0];
      expect(processHandle).toBeDefined();
      if (!processHandle) return;

      processHandle.emitData("live-output\n");
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "output" &&
              event.threadId === "run-history-live" &&
              event.terminalId === "command-history-live",
          ),
        ),
      );

      expect(
        yield* manager.getHistory({
          threadId: "run-history-live",
          terminalId: "command-history-live",
        }),
      ).toBe("live-output\n");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("无活动会话时读取持久化历史或空结果且不会创建 PTY", () =>
    Effect.gen(function* () {
      const { manager, logsDir, ptyAdapter } = yield* createManager();
      const fs = yield* FileSystem.FileSystem;
      const persistedPath = yield* multiTerminalHistoryLogPath(
        logsDir,
        "run-history-persisted",
        "command-history-persisted",
      );
      yield* fs.makeDirectory(logsDir, { recursive: true });
      yield* fs.writeFileString(persistedPath, "persisted-output\n");

      expect(
        yield* manager.getHistory({
          threadId: "run-history-persisted",
          terminalId: "command-history-persisted",
        }),
      ).toBe("persisted-output\n");
      expect(
        yield* manager.getHistory({
          threadId: "run-history-missing",
          terminalId: "command-history-missing",
        }),
      ).toBe("");
      expect(ptyAdapter.spawnInputs).toHaveLength(0);
    }),
  );

  it.effect("kill 只终止进程并保留 handle，close 才释放 session", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.runCommand({
        threadId: "run-kill-1",
        terminalId: "command-kill-1",
        cwd: process.cwd(),
        command: "long-running-command",
      });
      const processHandle = ptyAdapter.processes[0];
      expect(processHandle).toBeDefined();
      if (!processHandle) return;
      processHandle.emitData("before-kill\n");

      yield* manager.kill({ threadId: "run-kill-1", terminalId: "command-kill-1" });
      yield* waitFor(Effect.sync(() => processHandle.killed));

      let snapshot: TerminalSessionSnapshot | undefined;
      const unsubscribe = yield* manager.attachStream(
        { threadId: "run-kill-1", terminalId: "command-kill-1" },
        (event) =>
          Effect.sync(() => {
            if (event.type === "snapshot") snapshot = event.snapshot;
          }),
      );
      unsubscribe();
      expect(snapshot).toMatchObject({ status: "exited", history: "before-kill\n" });

      yield* manager.close({ threadId: "run-kill-1", terminalId: "command-kill-1" });
      const error = yield* manager
        .write({ threadId: "run-kill-1", terminalId: "command-kill-1", data: "ignored" })
        .pipe(Effect.flip);
      assert.equal(error._tag, "TerminalSessionLookupError");
    }),
  );

  it.effect("win32 kill 使用无参数信号并在真实退出前保留 supervision", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 1_000 });
      const threadId = "run-kill-win32";
      const terminalId = "command-kill-win32";
      yield* manager.runCommand({
        threadId,
        terminalId,
        cwd: process.cwd(),
        command: "long-running-command",
      });
      const processHandle = ptyAdapter.processes[0];
      expect(processHandle).toBeDefined();
      if (!processHandle) return;
      processHandle.exitOnKillSignals.clear();
      const signaled = yield* Deferred.make<string | undefined>();
      processHandle.onKill = (signal) => {
        Deferred.doneUnsafe(signaled, Effect.succeed(signal));
      };

      const killFiber = yield* manager.kill({ threadId, terminalId }).pipe(Effect.forkChild);
      yield* Deferred.await(signaled);
      processHandle.onKill = null;

      assert.equal(processHandle.killSignals.length, 1);
      assert.equal(processHandle.killSignals[0], undefined);
      assert.equal(processHandle.dataListenerCount, 1);
      assert.equal(processHandle.exitListenerCount, 1);

      processHandle.emitExit({ exitCode: 0, signal: null });
      yield* Fiber.join(killFiber);

      assert.equal(yield* manager.inspectSession({ threadId, terminalId }), "inactive");
      assert.equal(processHandle.dataListenerCount, 0);
      assert.equal(processHandle.exitListenerCount, 0);
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("Unix TERM 后自然退出会取消延迟强杀", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 1_000 });
      const threadId = "run-kill-unix-graceful";
      const terminalId = "command-kill-unix-graceful";
      yield* manager.runCommand({
        threadId,
        terminalId,
        cwd: process.cwd(),
        command: "long-running-command",
      });
      const processHandle = ptyAdapter.processes[0];
      expect(processHandle).toBeDefined();
      if (!processHandle) return;
      processHandle.exitOnKillSignals.clear();
      const signaled = yield* Deferred.make<string | undefined>();
      processHandle.onKill = (signal) => {
        Deferred.doneUnsafe(signaled, Effect.succeed(signal));
      };

      const killFiber = yield* manager.kill({ threadId, terminalId }).pipe(Effect.forkChild);
      yield* Deferred.await(signaled);
      processHandle.onKill = null;
      expect(processHandle.killSignals).toEqual(["SIGTERM"]);
      processHandle.emitExit({ exitCode: 0, signal: 15 });
      yield* Fiber.join(killFiber);
      yield* TestClock.adjust("1 second");

      expect(processHandle.killSignals).toEqual(["SIGTERM"]);
      assert.equal(yield* manager.inspectSession({ threadId, terminalId }), "inactive");
    }).pipe(Effect.provide(Layer.merge(withHostPlatform("linux"), TestClock.layer()))),
  );

  it.effect("并发重复 kill 共享同一次终止且不重复发信号", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 1_000 });
      const threadId = "run-kill-shared";
      const terminalId = "command-kill-shared";
      yield* manager.runCommand({
        threadId,
        terminalId,
        cwd: process.cwd(),
        command: "long-running-command",
      });
      const processHandle = ptyAdapter.processes[0];
      expect(processHandle).toBeDefined();
      if (!processHandle) return;
      processHandle.exitOnKillSignals.clear();
      const signaled = yield* Deferred.make<string | undefined>();
      processHandle.onKill = (signal) => {
        Deferred.doneUnsafe(signaled, Effect.succeed(signal));
      };

      const first = yield* manager.kill({ threadId, terminalId }).pipe(Effect.forkChild);
      const second = yield* manager.kill({ threadId, terminalId }).pipe(Effect.forkChild);
      yield* Deferred.await(signaled);
      processHandle.onKill = null;

      assert.equal(processHandle.killSignals.length, 1);
      assert.equal(processHandle.killSignals[0], undefined);
      processHandle.emitExit({ exitCode: 0, signal: null });
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.equal(processHandle.killSignals.length, 1);
      assert.equal(processHandle.killSignals[0], undefined);
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("kill signal 失败时返回 typed error 且不脱管", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const threadId = "run-kill-signal-failure";
      const terminalId = "command-kill-signal-failure";
      yield* manager.runCommand({
        threadId,
        terminalId,
        cwd: process.cwd(),
        command: "long-running-command",
      });
      const processHandle = ptyAdapter.processes[0];
      expect(processHandle).toBeDefined();
      if (!processHandle) return;
      processHandle.exitOnKillSignals.clear();
      processHandle.killFailures.set(undefined, new Error("kill failed"));

      const error = yield* manager.kill({ threadId, terminalId }).pipe(Effect.flip);

      assert.equal(error._tag, "TerminalProcessTerminationError");
      if (error._tag === "TerminalProcessTerminationError") {
        assert.equal(error.reason, "signal-failed");
        assert.equal(error.signal, "platform-default");
      }
      assert.equal(processHandle.killSignals.length, 1);
      assert.equal(processHandle.killSignals[0], undefined);
      assert.equal(yield* manager.inspectSession({ threadId, terminalId }), "active");
      assert.equal(processHandle.dataListenerCount, 1);
      assert.equal(processHandle.exitListenerCount, 1);
    }).pipe(Effect.provide(withHostPlatform("win32"))),
  );

  it.effect("Unix 强杀 signal 失败时返回 typed error 且不脱管", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 10 });
      const threadId = "run-kill-force-signal-failure";
      const terminalId = "command-kill-force-signal-failure";
      yield* manager.runCommand({
        threadId,
        terminalId,
        cwd: process.cwd(),
        command: "long-running-command",
      });
      const processHandle = ptyAdapter.processes[0];
      expect(processHandle).toBeDefined();
      if (!processHandle) return;
      processHandle.exitOnKillSignals.clear();
      processHandle.killFailures.set("SIGKILL", new Error("force kill failed"));

      const killFiber = yield* manager.kill({ threadId, terminalId }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 millis");
      const error = yield* Fiber.join(killFiber).pipe(Effect.flip);

      assert.equal(error._tag, "TerminalProcessTerminationError");
      if (error._tag === "TerminalProcessTerminationError") {
        assert.equal(error.reason, "force-signal-failed");
        assert.equal(error.signal, "SIGKILL");
      }
      expect(processHandle.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
      assert.equal(yield* manager.inspectSession({ threadId, terminalId }), "active");
      assert.equal(processHandle.dataListenerCount, 1);
      assert.equal(processHandle.exitListenerCount, 1);

      processHandle.killFailures.delete("SIGKILL");
      processHandle.exitOnKillSignals.add("SIGTERM");
      yield* manager.kill({ threadId, terminalId });
    }).pipe(Effect.provide(Layer.merge(withHostPlatform("linux"), TestClock.layer()))),
  );

  it.effect("Unix 强杀后退出超时返回 typed error 且不脱管", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        processKillGraceMs: 10,
        processExitTimeoutMs: 20,
      });
      const threadId = "run-kill-force-exit-timeout";
      const terminalId = "command-kill-force-exit-timeout";
      yield* manager.runCommand({
        threadId,
        terminalId,
        cwd: process.cwd(),
        command: "long-running-command",
      });
      const processHandle = ptyAdapter.processes[0];
      expect(processHandle).toBeDefined();
      if (!processHandle) return;
      processHandle.exitOnKillSignals.clear();

      const killFiber = yield* manager.kill({ threadId, terminalId }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("30 millis");
      const error = yield* Fiber.join(killFiber).pipe(Effect.flip);

      assert.equal(error._tag, "TerminalProcessTerminationError");
      if (error._tag === "TerminalProcessTerminationError") {
        assert.equal(error.reason, "force-exit-timeout");
        assert.equal(error.signal, "SIGKILL");
      }
      expect(processHandle.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
      assert.equal(yield* manager.inspectSession({ threadId, terminalId }), "active");
      assert.equal(processHandle.dataListenerCount, 1);
      assert.equal(processHandle.exitListenerCount, 1);

      processHandle.exitOnKillSignals.add("SIGTERM");
      yield* manager.kill({ threadId, terminalId });
    }).pipe(Effect.provide(Layer.merge(withHostPlatform("linux"), TestClock.layer()))),
  );

  it.effect("attaches to running sessions without restarting them", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();

      yield* manager.open(openInput());
      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        {
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          cols: 100,
          rows: 40,
        },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      assert.equal(snapshot.snapshot.threadId, "thread-1");
      assert.equal(snapshot.snapshot.terminalId, DEFAULT_TERMINAL_ID);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("keeps attach streams live when a terminal id is closed and reopened", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
        Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* manager.close({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        deleteHistory: true,
      });
      yield* manager.open(openInput());

      yield* waitFor(
        Ref.get(attachEvents).pipe(
          Effect.map(
            (events) =>
              events.length >= 4 &&
              events.at(-1)?.type === "snapshot" &&
              events.some((event) => event.type === "closed"),
          ),
        ),
      );

      const events = yield* Ref.get(attachEvents);
      expect(events.map((event) => event.type)).toEqual([
        "snapshot",
        "exited",
        "closed",
        "snapshot",
      ]);
      expect(
        events.filter((event) => event.type === "snapshot").map((event) => event.snapshot.status),
      ).toEqual(["running", "running"]);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  it.effect("attaches to exited sessions without restarting them", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager();

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
        "1200 millis",
      );

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        openInput({
          env: {
            CODEWORK_WORKTREE_PATH: "/tmp/should-not-restart",
          },
          worktreePath: "/tmp/should-not-restart",
        }),
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      assert.equal(snapshot.snapshot.status, "exited");
      assert.equal(snapshot.snapshot.worktreePath, null);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("restarts inactive sessions from attach only when requested", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager();

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
        "1200 millis",
      );

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        {
          ...openInput({
            env: {
              CODEWORK_WORKTREE_PATH: "/tmp/restart-requested",
            },
            worktreePath: "/tmp/restart-requested",
          }),
          restartIfNotRunning: true,
        },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      assert.equal(snapshot.snapshot.status, "running");
      assert.equal(snapshot.snapshot.worktreePath, "/tmp/restart-requested");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  const makeDirectory = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.makeDirectory(filePath, { recursive: true }),
    );

  const chmod = (filePath: string, mode: number) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.chmod(filePath, mode));

  const pathExists = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.exists(filePath));

  const readFileString = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.readFileString(filePath));

  const writeFileString = (filePath: string, contents: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.writeFileString(filePath, contents),
    );

  it.effect("reports a missing cwd without an artificial cause", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;

      const { manager, baseDir } = yield* createManager();
      const cwd = path.join(baseDir, "missing-cwd");
      const error = yield* Effect.flip(manager.open(openInput({ cwd })));

      expect(error).toMatchObject({
        _tag: "TerminalCwdNotFoundError",
        cwd,
      });
      expect("cause" in error).toBe(false);
    }),
  );

  it.effect("reports a cwd that is not a directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;

      const { manager, baseDir } = yield* createManager();
      const cwd = path.join(baseDir, "cwd-file");
      yield* writeFileString(cwd, "not a directory");
      const error = yield* Effect.flip(manager.open(openInput({ cwd })));

      expect(error).toMatchObject({
        _tag: "TerminalCwdNotDirectoryError",
        cwd,
      });
      expect("cause" in error).toBe(false);
    }),
  );

  it.effect("preserves non-notFound cwd stat failures", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;

      const path = yield* Path.Path;

      const { manager, baseDir } = yield* createManager();
      const blockedRoot = path.join(baseDir, "blocked-root");
      const blockedCwd = path.join(blockedRoot, "cwd");
      yield* makeDirectory(blockedCwd);
      yield* chmod(blockedRoot, 0o000);

      const error = yield* Effect.flip(manager.open(openInput({ cwd: blockedCwd }))).pipe(
        Effect.ensuring(chmod(blockedRoot, 0o755).pipe(Effect.ignore)),
      );

      expect(error).toMatchObject({
        _tag: "TerminalCwdStatError",
        cwd: blockedCwd,
        cause: {
          _tag: "PlatformError",
        },
      });
    }),
  );

  it.effect("supports asynchronous PTY spawn effects", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(ptyAdapter.processes).toHaveLength(1);
    }),
  );

  it.effect("forwards write and resize to active pty process", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "ls\n",
      });
      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 120,
        rows: 30,
      });

      expect(process.writes).toEqual(["ls\n"]);
      expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);
    }),
  );

  it.effect("preserves structured context and causes for PTY I/O failures", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const writeCause = new Error("PTY input handle is unavailable");
      process.writeFailure = writeCause;
      const writeError = yield* Effect.flip(
        manager.write({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          data: "secret input that must not be attached to the error",
        }),
      );

      expect(writeError).toMatchObject({
        _tag: "TerminalWriteError",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        terminalPid: process.pid,
      });
      expect(writeError.cause).toBe(writeCause);
      expect(writeError).not.toHaveProperty("data");

      const resizeCause = new Error("PTY resize handle is unavailable");
      process.resizeFailure = resizeCause;
      const resizeError = yield* Effect.flip(
        manager.resize({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          cols: 132,
          rows: 40,
        }),
      );

      expect(resizeError).toMatchObject({
        _tag: "TerminalResizeError",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        terminalPid: process.pid,
        cols: 132,
        rows: 40,
      });
      expect(resizeError.cause).toBe(resizeCause);

      process.resizeFailure = undefined;
      yield* manager.open(openInput({ cols: 132, rows: 40 }));
      expect(process.resizeCalls).toEqual([{ cols: 132, rows: 40 }]);
    }),
  );

  it.effect("ignores delayed resize requests after a terminal closes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* manager.close({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        deleteHistory: true,
      });
      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 120,
        rows: 30,
      });

      expect(process.resizeCalls).toEqual([]);
    }),
  );

  it.effect("resizes running terminal on open when a different size is requested", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ cols: 100, rows: 24 }));
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const reopened = yield* manager.open(openInput({ cols: 120, rows: 30 }));

      assert.equal(reopened.status, "running");
      expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);
    }),
  );

  it.effect("supports multiple terminals per thread independently", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "term-2" }));

      const first = ptyAdapter.processes[0];
      const second = ptyAdapter.processes[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) return;

      yield* manager.write({ threadId: "thread-1", terminalId: "default", data: "pwd\n" });
      yield* manager.write({ threadId: "thread-1", terminalId: "term-2", data: "ls\n" });

      expect(first.writes).toEqual(["pwd\n"]);
      expect(second.writes).toEqual(["ls\n"]);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  it.effect("clears transcript and emits cleared event", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager();
      const path = yield* Path.Path;
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello\n");
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      yield* manager.clear({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(readFileString),
          Effect.map((text) => text === ""),
        ),
      );

      const events = yield* getEvents;
      expect(events.some((event) => event.type === "cleared")).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "cleared" &&
            event.threadId === "thread-1" &&
            event.terminalId === DEFAULT_TERMINAL_ID,
        ),
      ).toBe(true);
    }),
  );

  it.effect("restarts terminal with empty transcript and respawns pty", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput());
      const firstProcess = ptyAdapter.processes[0];
      expect(firstProcess).toBeDefined();
      if (!firstProcess) return;
      firstProcess.emitData("before restart\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );

      const snapshot = yield* manager.restart(restartInput());
      assert.equal(snapshot.history, "");
      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(readFileString),
          Effect.map((text) => text === ""),
        ),
      );
    }),
  );

  it.effect("restarts a running session when open is called with a different cwd", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, baseDir } = yield* createManager();
      const path = yield* Path.Path;
      const originalCwd = path.join(baseDir, "original");
      const differentCwd = path.join(baseDir, "different");
      yield* makeDirectory(originalCwd);
      yield* makeDirectory(differentCwd);

      yield* manager.open(openInput({ cwd: originalCwd }));
      const firstProcess = ptyAdapter.processes[0];
      expect(firstProcess).toBeDefined();
      if (!firstProcess) return;

      firstProcess.emitData("before reopen\n");
      const logPath = yield* historyLogPath(logsDir);
      yield* waitFor(pathExists(logPath));

      const reopened = yield* manager.open(openInput({ cwd: differentCwd }));

      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      assert.equal(firstProcess.killed, true);
      assert.equal(reopened.cwd, differentCwd);
      assert.equal(reopened.history, "");
      yield* waitFor(Effect.map(readFileString(logPath), (text) => text === ""));
    }),
  );

  it.effect("propagates explicit worktree metadata through snapshots and lifecycle events", () =>
    Effect.gen(function* () {
      const { manager, getEvents, baseDir } = yield* createManager();
      const path = yield* Path.Path;
      const firstWorktreePath = path.join(baseDir, "worktrees", "feature-a");
      const secondWorktreePath = path.join(baseDir, "worktrees", "feature-b");
      yield* makeDirectory(firstWorktreePath);
      yield* makeDirectory(secondWorktreePath);
      const startedSnapshot = yield* manager.open(
        openInput({
          cwd: firstWorktreePath,
          worktreePath: firstWorktreePath,
        }),
      );
      const restartedSnapshot = yield* manager.restart(
        restartInput({
          cwd: secondWorktreePath,
          worktreePath: secondWorktreePath,
        }),
      );

      assert.equal(startedSnapshot.worktreePath, firstWorktreePath);
      assert.equal(restartedSnapshot.worktreePath, secondWorktreePath);

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "restarted")),
      );

      const events = yield* getEvents;
      const startedEvent = events.find(
        (event): event is Extract<TerminalEvent, { type: "started" }> => event.type === "started",
      );
      const restartedEvent = events.find(
        (event): event is Extract<TerminalEvent, { type: "restarted" }> =>
          event.type === "restarted",
      );

      assert.equal(startedEvent?.snapshot.worktreePath, firstWorktreePath);
      assert.equal(restartedEvent?.snapshot.worktreePath, secondWorktreePath);
    }),
  );

  it.effect("preserves worktree metadata when reopening an exited session", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents, baseDir } = yield* createManager();
      const path = yield* Path.Path;
      const worktreePath = path.join(baseDir, "worktrees", "feature-a");
      yield* makeDirectory(worktreePath);

      yield* manager.open(
        openInput({
          cwd: worktreePath,
          worktreePath,
        }),
      );

      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
      );

      const reopenedSnapshot = yield* manager.open(
        openInput({
          cwd: worktreePath,
          worktreePath,
        }),
      );

      assert.equal(reopenedSnapshot.worktreePath, worktreePath);

      const events = yield* getEvents;
      const reopenedEvent = events
        .toReversed()
        .find(
          (event): event is Extract<TerminalEvent, { type: "started" }> => event.type === "started",
        );

      assert.equal(reopenedEvent?.snapshot.worktreePath, worktreePath);
    }),
  );

  it.effect("emits exited event and reopens with clean transcript after exit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager();
      const path = yield* Path.Path;
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("old data\n");
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
      );
      const reopened = yield* manager.open(openInput());

      assert.equal(reopened.history, "");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect(
        yield* historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(readFileString),
        ),
      ).toBe("");
    }),
  );

  it.effect("ignores trailing writes after terminal exit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitExit({ exitCode: 0, signal: 0 });

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\r",
      });
      expect(process.writes).toEqual([]);
    }),
  );

  it.effect("emits subprocess activity events when child-process state changes", () =>
    Effect.gen(function* () {
      let inspect: {
        readonly hasRunningSubprocess: boolean;
        readonly childCommand: string | null;
        readonly processIds: ReadonlyArray<number>;
      } = { hasRunningSubprocess: false, childCommand: null, processIds: [] };
      const { manager, getEvents } = yield* createManager(5, {
        subprocessInspector: () => Effect.succeed(inspect),
        subprocessPollIntervalMs: 20,
      });

      yield* manager.open(openInput());
      expect((yield* getEvents).some((event) => event.type === "activity")).toBe(false);

      inspect = { hasRunningSubprocess: true, childCommand: "vim", processIds: [100, 101] };
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === true &&
              event.label === "vim",
          ),
        ),
        "1200 millis",
      );

      inspect = { hasRunningSubprocess: false, childCommand: null, processIds: [] };
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === false &&
              event.label === "Terminal 1",
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("does not invoke subprocess polling until a terminal session is running", () =>
    Effect.gen(function* () {
      let checks = 0;
      const { manager } = yield* createManager(5, {
        subprocessInspector: () => {
          checks += 1;
          return Effect.succeed({
            hasRunningSubprocess: false,
            childCommand: null,
            processIds: [],
          });
        },
        subprocessPollIntervalMs: 20,
      });

      yield* Effect.sleep("80 millis");
      assert.equal(checks, 0);

      yield* manager.open(openInput());
      yield* waitFor(
        Effect.sync(() => checks > 0),
        "1200 millis",
      );
    }),
  );

  it.effect("derives subprocess activity for every terminal from one shared process snapshot", () =>
    Effect.gen(function* () {
      const runCalls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      // FakePtyAdapter assigns pids starting at 9000, so the two terminals
      // opened below run as pids 9000 and 9001.
      const psStdout = ["  100  9000 vim", "  101   100 git", "  200  9001 /usr/bin/python3"].join(
        "\n",
      );
      const processRunner: ProcessRunner.ProcessRunner["Service"] = {
        run: (input) =>
          Effect.sync(() => {
            runCalls.push({ command: input.command, args: input.args });
            return {
              stdout: psStdout,
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      };

      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 20,
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provide(withHostPlatform("linux")),
      );

      yield* manager.open(openInput());
      yield* manager.open(openInput({ threadId: "thread-2" }));

      yield* waitFor(
        Effect.map(
          getEvents,
          (events) =>
            events.some(
              (event) =>
                event.type === "activity" &&
                event.hasRunningSubprocess === true &&
                event.label === "vim",
            ) &&
            events.some(
              (event) =>
                event.type === "activity" &&
                event.hasRunningSubprocess === true &&
                event.label === "python3",
            ),
        ),
        "1200 millis",
      );
      yield* waitFor(
        Effect.sync(() => runCalls.length >= 3),
        "1200 millis",
      );

      // Every spawn is the shared table snapshot — no per-terminal `pgrep`
      // or per-child `ps -p` invocations.
      expect(runCalls.every((call) => call.args.join(" ") === "-eo pid=,ppid=,comm=")).toBe(true);
    }),
  );

  it.effect("keeps last known subprocess state when the process snapshot fails", () =>
    Effect.gen(function* () {
      let failSnapshots = false;
      let failedCalls = 0;
      const processRunner: ProcessRunner.ProcessRunner["Service"] = {
        run: () =>
          Effect.sync(() => {
            if (failSnapshots) failedCalls += 1;
            return {
              stdout: failSnapshots ? "" : "  100  9000 vim",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(failSnapshots ? 1 : 0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      };

      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 20,
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provide(withHostPlatform("linux")),
      );

      yield* manager.open(openInput());
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === true &&
              event.label === "vim",
          ),
        ),
        "1200 millis",
      );

      failSnapshots = true;
      yield* waitFor(
        Effect.sync(() => failedCalls >= 3),
        "1200 millis",
      );

      // A failed snapshot is not authoritative: no terminal flips to idle.
      const activityEvents = (yield* getEvents).filter((event) => event.type === "activity");
      expect(activityEvents.length).toBeGreaterThan(0);
      expect(activityEvents.every((event) => event.hasRunningSubprocess === true)).toBe(true);
    }),
  );

  it.effect("caps persisted history to configured line limit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(3);
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("line1\nline2\nline3\nline4\n");
      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      const nonEmptyLines = reopened.history.split("\n").filter((line) => line.length > 0);
      expect(nonEmptyLines).toEqual(["line2", "line3", "line4"]);
    }),
  );

  it.effect("strips replay-unsafe terminal query and reply sequences from persisted history", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("prompt ");
      process.emitData("\u001b[32mok\u001b[0m ");
      process.emitData("\u001b]11;rgb:ffff/ffff/ffff\u0007");
      process.emitData("\u001b[1;1R");
      process.emitData("done\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "prompt \u001b[32mok\u001b[0m done\n");
    }),
  );

  it.effect("strips replayable CSI and DCS traffic while preserving setters", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("prompt ");
      // DECRQM/DECRPM, XTVERSION, and kitty-keyboard CSI query/reply traffic.
      process.emitData("\u001b[?2026$p\u001b[?2026;2$y\u001b[>q\u001b[?u\u001b[?31u");
      // DECRQSS and XTGETTCAP query/reply traffic in 7-bit DCS form.
      process.emitData("\u001bP$q m\u001b\\\u001bP1$r0m\u001b\\");
      process.emitData("\u001bP+q544e\u001b\\\u001bP1+r544e=1b\u001b\\");
      // The same DCS traffic in 8-bit form.
      process.emitData("\u0090$q m\u009c\u00901$r0m\u009c");
      process.emitData("\u0090+q544e\u009c\u00901+r544e=1b\u009c");
      // Setters and cursor movement share final bytes with query families but
      // have visible terminal-state value and must survive replay.
      process.emitData('\u001b[!p\u001b["p\u001b[4 q\u001b[u');
      process.emitData("done\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, 'prompt \u001b[!p\u001b["p\u001b[4 q\u001b[udone\n');
    }),
  );

  it.effect("handles CSI and DCS query sequences split across output chunks", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("before ");
      process.emitData("\u001b[?2026$");
      process.emitData("pafter ");
      process.emitData("\u001bP$q ");
      process.emitData("m\u001b");
      process.emitData("\\after ");
      process.emitData("\u009b?3");
      process.emitData("1uafter ");
      process.emitData("\u0090+q544e");
      process.emitData("\u009cafter\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "before after after after after\n");
    }),
  );

  it.effect(
    "preserves clear and style control sequences while dropping chunk-split query traffic",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        process.emitData("before clear\n");
        process.emitData("\u001b[H\u001b[2J");
        process.emitData("prompt ");
        process.emitData("\u001b]11;");
        process.emitData("rgb:ffff/ffff/ffff\u0007\u001b[1;1");
        process.emitData("R\u001b[36mdone\u001b[0m\n");

        yield* manager.close({ threadId: "thread-1" });

        const reopened = yield* manager.open(openInput());
        assert.equal(
          reopened.history,
          "before clear\n\u001b[H\u001b[2Jprompt \u001b[36mdone\u001b[0m\n",
        );
      }),
  );

  it.effect("does not leak final bytes from ESC sequences with intermediate bytes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("before ");
      process.emitData("\u001b(B");
      process.emitData("after\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "before \u001b(Bafter\n");
    }),
  );

  it.effect(
    "preserves chunk-split ESC sequences with intermediate bytes without leaking final bytes",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        process.emitData("before ");
        process.emitData("\u001b(");
        process.emitData("Bafter\n");

        yield* manager.close({ threadId: "thread-1" });

        const reopened = yield* manager.open(openInput());
        assert.equal(reopened.history, "before \u001b(Bafter\n");
      }),
  );

  it.effect("deletes history file when close(deleteHistory=true)", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("bye\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );

      yield* manager.close({ threadId: "thread-1", deleteHistory: true });
      expect(
        yield* historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      ).toBe(false);
    }),
  );

  it.effect("closes all terminals for a thread when close omits terminalId", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "sidecar" }));
      const defaultProcess = ptyAdapter.processes[0];
      const sidecarProcess = ptyAdapter.processes[1];
      expect(defaultProcess).toBeDefined();
      expect(sidecarProcess).toBeDefined();
      if (!defaultProcess || !sidecarProcess) return;

      defaultProcess.emitData("default\n");
      sidecarProcess.emitData("sidecar\n");
      const path = yield* Path.Path;
      yield* waitFor(
        multiTerminalHistoryLogPath(logsDir, "thread-1", "default").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      yield* waitFor(
        multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );

      yield* manager.close({ threadId: "thread-1", deleteHistory: true });

      assert.equal(defaultProcess.killed, true);
      assert.equal(sidecarProcess.killed, true);
      expect(
        yield* multiTerminalHistoryLogPath(logsDir, "thread-1", "default").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      ).toBe(false);
      expect(
        yield* multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      ).toBe(false);
    }),
  );

  it.effect("escalates terminal shutdown to SIGKILL when process does not exit in time", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 10 });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.exitOnKillSignals = new Set(["SIGKILL"]);

      const closeFiber = yield* manager.close({ threadId: "thread-1" }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(closeFiber);

      assert.equal(process.killSignals[0], "SIGTERM");
      expect(process.killSignals).toContain("SIGKILL");
    }).pipe(Effect.provide(Layer.merge(withHostPlatform("linux"), TestClock.layer()))),
  );

  it.effect("publishes closed events when terminals are explicitly closed", () =>
    Effect.gen(function* () {
      const { manager, getEvents } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "sidecar" }));

      yield* manager.close({ threadId: "thread-1" });

      yield* waitFor(
        Effect.map(
          getEvents,
          (events) => events.filter((event) => event.type === "closed").length === 2,
        ),
      );

      const closedEvents = (yield* getEvents).filter(
        (event): event is Extract<TerminalEvent, { type: "closed" }> => event.type === "closed",
      );
      expect(closedEvents.map((event) => event.terminalId).sort()).toEqual(["default", "sidecar"]);
    }),
  );

  it.effect("evicts oldest inactive terminal sessions when retention limit is exceeded", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager(5, {
        maxRetainedInactiveSessions: 1,
      });

      yield* manager.open(openInput({ threadId: "thread-1" }));
      yield* manager.open(openInput({ threadId: "thread-2" }));

      const first = ptyAdapter.processes[0];
      const second = ptyAdapter.processes[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) return;

      first.emitData("first-history\n");
      second.emitData("second-history\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir, "thread-1").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      first.emitExit({ exitCode: 0, signal: 0 });
      yield* Effect.sleep(Duration.millis(5));
      second.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(
          getEvents,
          (events) => events.filter((event) => event.type === "exited").length === 2,
        ),
      );

      const reopenedSecond = yield* manager.open(openInput({ threadId: "thread-2" }));
      const reopenedFirst = yield* manager.open(openInput({ threadId: "thread-1" }));

      assert.equal(reopenedFirst.history, "first-history\n");
      assert.equal(reopenedSecond.history, "");
    }),
  );

  it.effect("migrates legacy transcript filenames to terminal-scoped history path on open", () =>
    Effect.gen(function* () {
      const { manager, logsDir } = yield* createManager();
      const path = yield* Path.Path;
      const legacyPath = path.join(logsDir, "thread-1.log");
      const nextPath = yield* historyLogPath(logsDir);
      yield* writeFileString(legacyPath, "legacy-line\n");

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.history, "legacy-line\n");
      expect(yield* pathExists(nextPath)).toBe(true);
      expect(yield* readFileString(nextPath)).toBe("legacy-line\n");
      expect(yield* pathExists(legacyPath)).toBe(false);
    }),
  );

  it.effect("retries with fallback shells when preferred shell spawn fails", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const missingShell =
        platform === "win32" ? "C:\\definitely\\missing-shell.exe" : "/definitely/missing-shell -l";
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => missingShell,
      });
      ptyAdapter.spawnFailures.push(new Error("posix_spawnp failed."));

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs.length).toBeGreaterThanOrEqual(2);
      expect(ptyAdapter.spawnInputs[0]?.shell).toBe(
        platform === "win32" ? missingShell : "/definitely/missing-shell",
      );

      if (platform === "win32") {
        expect(
          ptyAdapter.spawnInputs.some(
            (input) =>
              input.shell === "pwsh.exe" ||
              input.shell === "powershell.exe" ||
              input.shell === "cmd.exe",
          ),
        ).toBe(true);
      } else {
        expect(
          ptyAdapter.spawnInputs
            .slice(1)
            .some((input) => input.shell !== "/definitely/missing-shell"),
        ).toBe(true);
      }
    }),
  );

  it.effect("prefers PowerShell over ComSpec for Windows terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
      }).pipe(Effect.provide(withHostPlatform("win32")));

      yield* manager.open(openInput());

      expect(ptyAdapter.spawnInputs[0]).toEqual(
        expect.objectContaining({
          shell: "pwsh.exe",
          args: ["-NoLogo"],
        }),
      );
    }),
  );

  it.effect("falls back to built-in PowerShell by absolute path on Windows", () =>
    Effect.gen(function* () {
      const ptyAdapter = new FakePtyAdapter();
      const { manager } = yield* createManager(5, {
        ptyAdapter,
        shellResolver: () => "C:\\missing\\custom-shell.exe",
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
      }).pipe(Effect.provide(withHostPlatform("win32")));
      ptyAdapter.spawnFailures.push(
        new Error("spawn custom-shell.exe ENOENT"),
        new Error("spawn pwsh.exe ENOENT"),
      );

      yield* manager.open(openInput());

      expect(ptyAdapter.spawnInputs.map((input) => input.shell)).toEqual([
        "C:\\missing\\custom-shell.exe",
        "pwsh.exe",
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ]);
      expect(ptyAdapter.spawnInputs[1]?.args).toEqual(["-NoLogo"]);
      expect(ptyAdapter.spawnInputs[2]?.args).toEqual(["-NoLogo"]);
    }),
  );

  it.effect("filters app runtime env variables from terminal sessions", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          PORT: "5173",
          CODEWORK_PORT: "3773",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          TEST_TERMINAL_KEEP: "keep-me",
        },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.PORT).toBeUndefined();
      expect(spawnInput.env.CODEWORK_PORT).toBeUndefined();
      expect(spawnInput.env.VITE_DEV_SERVER_URL).toBeUndefined();
      // Arbitrary host env vars must pass through — terminals inherit the
      // user's environment apart from the explicit blocklist.
      expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");
    }),
  );

  it.effect("strips AppImage runtime env from terminal sessions", () =>
    Effect.gen(function* () {
      const appDir = "/tmp/.mount_T3Codeabc123";
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          APPIMAGE: "/home/user/Code Work-Code.AppImage",
          APPDIR: appDir,
          ARGV0: "/home/user/Code Work-Code.AppImage",
          OWD: "/home/user/project",
          PATH: `${appDir}/usr/bin:${appDir}:/usr/local/bin:/usr/bin:/bin`,
          LD_LIBRARY_PATH: `${appDir}/usr/lib:/home/user/.local/lib`,
          XDG_DATA_DIRS: `${appDir}/usr/share:/usr/local/share:/usr/share`,
          GSETTINGS_SCHEMA_DIR: `${appDir}/usr/share/glib-2.0/schemas`,
          TEST_TERMINAL_KEEP: "keep-me",
        },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      // AppImage runtime markers must never reach the PTY — tools inside the
      // terminal otherwise resolve against the AppImage mount (e.g. PHP_BINARY
      // reporting the AppImage path instead of the real binary).
      expect(spawnInput.env.APPIMAGE).toBeUndefined();
      expect(spawnInput.env.APPDIR).toBeUndefined();
      expect(spawnInput.env.ARGV0).toBeUndefined();
      expect(spawnInput.env.OWD).toBeUndefined();
      // PATH/LD_LIBRARY_PATH keep the user's real entries but drop the AppImage
      // mount segments that the runtime prepended.
      expect(spawnInput.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
      expect(spawnInput.env.LD_LIBRARY_PATH).toBe("/home/user/.local/lib");
      // XDG_DATA_DIRS keeps the host entries but drops the AppImage share dir.
      expect(spawnInput.env.XDG_DATA_DIRS).toBe("/usr/local/share:/usr/share");
      // GSETTINGS_SCHEMA_DIR pointed only at the mount, so it is removed and
      // gsettings falls back to the host schema location.
      expect(spawnInput.env.GSETTINGS_SCHEMA_DIR).toBeUndefined();
      // Unrelated host vars still pass through untouched.
      expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");
    }),
  );

  it.effect("leaves the environment untouched when not launched from an AppImage", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          LD_LIBRARY_PATH: "/home/user/.local/lib",
          // Without APPIMAGE/APPDIR set, OWD is an ordinary variable and must
          // not be stripped — only an AppImage launch gives it special meaning.
          OWD: "/home/user/keep-this",
        },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
      expect(spawnInput.env.LD_LIBRARY_PATH).toBe("/home/user/.local/lib");
      expect(spawnInput.env.OWD).toBe("/home/user/keep-this");
    }),
  );

  it.effect("injects runtime env overrides into spawned terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(
        openInput({
          env: {
            T3CODE_PROJECT_ROOT: "/repo",
            CODEWORK_WORKTREE_PATH: "/repo/worktree-a",
            CUSTOM_FLAG: "1",
          },
        }),
      );
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      assert.equal(spawnInput.env.T3CODE_PROJECT_ROOT, "/repo");
      assert.equal(spawnInput.env.CODEWORK_WORKTREE_PATH, "/repo/worktree-a");
      assert.equal(spawnInput.env.CUSTOM_FLAG, "1");
    }),
  );

  it.effect("starts zsh with prompt spacer disabled to avoid `%` end markers", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/zsh",
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.args).toEqual(["-o", "nopromptsp"]);
    }),
  );

  it.effect("bridges PTY callbacks back into Effect-managed event streaming", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello from callback\n");

      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "output" && event.data === "hello from callback\n"),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("pushes PTY callbacks to direct event subscribers", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });
      const subscriberEvents = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(subscriberEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello from subscriber\n");

      yield* waitFor(
        Effect.map(Ref.get(subscriberEvents), (events) =>
          events.some(
            (event) => event.type === "output" && event.data === "hello from subscriber\n",
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("subscribes terminal metadata with an initial snapshot and live deltas", () =>
    Effect.gen(function* () {
      const { manager } = yield* createManager();
      yield* manager.open(openInput({ threadId: "existing-thread" }));

      const metadataEvents = yield* Ref.make<ReadonlyArray<TerminalMetadataStreamEvent>>([]);
      const unsubscribe = yield* manager.subscribeMetadata((event) =>
        Ref.update(metadataEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const initialEvents = yield* Ref.get(metadataEvents);
      expect(initialEvents[0]).toMatchObject({
        type: "snapshot",
        terminals: [
          {
            threadId: "existing-thread",
            terminalId: DEFAULT_TERMINAL_ID,
          },
        ],
      });

      yield* manager.open(openInput({ threadId: "new-thread" }));

      yield* waitFor(
        Effect.map(Ref.get(metadataEvents), (events) =>
          events.some(
            (event) =>
              event.type === "upsert" &&
              event.terminal.threadId === "new-thread" &&
              event.terminal.terminalId === DEFAULT_TERMINAL_ID,
          ),
        ),
        "1200 millis",
      );

      yield* manager.close({ threadId: "new-thread", terminalId: DEFAULT_TERMINAL_ID });

      yield* waitFor(
        Effect.map(Ref.get(metadataEvents), (events) =>
          events.some(
            (event) =>
              event.type === "remove" &&
              event.threadId === "new-thread" &&
              event.terminalId === DEFAULT_TERMINAL_ID,
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("removes terminal metadata subscriptions when initial delivery fails", () =>
    Effect.gen(function* () {
      const { manager } = yield* createManager();
      yield* manager.open(openInput({ threadId: "existing-thread" }));

      const leakedLiveEvents = yield* Ref.make(0);
      const exit = yield* Effect.exit(
        manager.subscribeMetadata((event) =>
          event.type === "snapshot"
            ? Effect.die("snapshot listener failed")
            : Ref.update(leakedLiveEvents, (count) => count + 1),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);

      yield* manager.open(openInput({ threadId: "new-thread" }));
      expect(yield* Ref.get(leakedLiveEvents)).toBe(0);
    }),
  );

  it.effect(
    "streams attach snapshots followed by live events without duplicate start snapshots",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager(5, {
          ptyAdapter: new FakePtyAdapter("async"),
        });
        const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
        const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
          Ref.update(attachEvents, (events) => [...events, event]),
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        expect(yield* Ref.get(attachEvents)).toMatchObject([
          {
            type: "snapshot",
            snapshot: {
              threadId: "thread-1",
              terminalId: DEFAULT_TERMINAL_ID,
            },
          },
        ]);

        process.emitData("hello from attach\n");

        yield* waitFor(
          Effect.map(Ref.get(attachEvents), (events) =>
            events.some((event) => event.type === "output" && event.data === "hello from attach\n"),
          ),
          "1200 millis",
        );

        const events = yield* Ref.get(attachEvents);
        expect(events.filter((event) => event.type === "snapshot")).toHaveLength(1);
      }),
  );

  it.effect("buffers attach output delivered during the initial snapshot callback", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });
      yield* manager.open(openInput());

      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
        Effect.gen(function* () {
          yield* Ref.update(attachEvents, (events) => [...events, event]);
          if (event.type === "snapshot") {
            yield* Effect.sync(() => process.emitData("during snapshot\n"));
            yield* Effect.yieldNow;
          }
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* waitFor(
        Effect.map(Ref.get(attachEvents), (events) =>
          events.some((event) => event.type === "output" && event.data === "during snapshot\n"),
        ),
        "1200 millis",
      );

      expect(yield* Ref.get(attachEvents)).toMatchObject([
        { type: "snapshot" },
        { type: "output", data: "during snapshot\n" },
      ]);
    }),
  );

  it.effect("preserves queued PTY output ordering through exit callbacks", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("first\n");
      process.emitData("second\n");
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => {
          const relevant = events.filter(
            (event) => event.type === "output" || event.type === "exited",
          );
          return relevant.length >= 3;
        }),
        "1200 millis",
      );

      const relevant = (yield* getEvents).filter(
        (event) => event.type === "output" || event.type === "exited",
      );
      expect(relevant).toEqual([
        expect.objectContaining({ type: "output", data: "first\n", sequence: 2 }),
        expect.objectContaining({ type: "output", data: "second\n", sequence: 3 }),
        expect.objectContaining({ type: "exited", exitCode: 0, exitSignal: 0, sequence: 4 }),
      ]);

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        {
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
        },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      expect(snapshot.snapshot.sequence).toBe(4);
    }),
  );

  it.effect("scoped runtime shutdown stops active terminals cleanly", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* createManager(5, {
        processKillGraceMs: 10,
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const closeScope = yield* Scope.close(scope, Exit.void).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Fiber.join(closeScope);

      assert.equal(process.killSignals[0], "SIGTERM");
      expect(process.killSignals).toEqual(["SIGTERM"]);
    }).pipe(Effect.provide(withHostPlatform("linux"))),
  );
});
