import type {
  OrchestrationProjectShell,
  TerminalEvent,
  TerminalSessionSnapshot,
  WorkspaceScriptRun,
} from "@codework/contracts";
import {
  ProjectId,
  TerminalSessionOwnershipError,
  WORKSPACE_SCRIPT_LOG_MAX_BYTES,
} from "@codework/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import { WorkspaceScriptStoreLive } from "../persistence/Layers/WorkspaceScriptStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  WorkspaceScriptStore,
  type WorkspaceScriptStoreError,
  type WorkspaceScriptStoreShape,
} from "../persistence/Services/WorkspaceScriptStore.ts";
import {
  makeWorkspaceScriptTerminalOwner,
  terminalSessionOwnerEquals,
  type TerminalSessionOwner,
} from "../terminal/TerminalSessionOwnership.ts";
import {
  makeWorkspaceScriptService,
  WorkspaceScriptDependencyError,
  type WorkspaceScriptTerminalPort,
  workspaceScriptShellInvocation,
} from "./WorkspaceScriptService.ts";
import {
  makeWorkspaceScriptStartTerminationOperationId,
  WORKSPACE_SCRIPT_START_FAILED_DETAIL,
} from "./WorkspaceScriptStartState.ts";

const PROJECT: OrchestrationProjectShell = {
  id: ProjectId.make("project-1"),
  title: "Project One",
  workspaceRoot: "E:/workspace/project-1",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [
    {
      id: "serve",
      name: "启动开发服务",
      command: "pnpm dev",
      icon: "play",
      runOnWorktreeCreate: false,
    },
    {
      id: "test",
      name: "运行测试",
      command: "pnpm test",
      icon: "test",
      runOnWorktreeCreate: false,
    },
  ],
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
};

const snapshot = (input: {
  threadId: string;
  terminalId: string;
  cwd: string;
  worktreePath?: string | null;
}): TerminalSessionSnapshot => ({
  threadId: input.threadId,
  terminalId: input.terminalId,
  cwd: input.cwd,
  worktreePath: input.worktreePath ?? null,
  status: "running",
  pid: 1234,
  history: "",
  exitCode: null,
  exitSignal: null,
  label: "pnpm dev",
  updatedAt: "2026-08-29T00:00:01.000Z",
  sequence: 1,
});

const makeFixture = () => {
  const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const starts: Array<Parameters<WorkspaceScriptTerminalPort["runCommand"]>[0]> = [];
  const startSnapshotOverrides: Array<Partial<TerminalSessionSnapshot>> = [];
  const beforeStartReturns: Array<
    (input: Parameters<WorkspaceScriptTerminalPort["runCommand"]>[0]) => Effect.Effect<void>
  > = [];
  const beforeRunCommands: Array<() => Effect.Effect<void>> = [];
  const afterStartClaims: Array<() => Effect.Effect<void>> = [];
  const kills: Array<Parameters<WorkspaceScriptTerminalPort["kill"]>[0]> = [];
  const beforeKills: Array<
    (input: Parameters<WorkspaceScriptTerminalPort["kill"]>[0]) => Effect.Effect<void>
  > = [];
  const afterSuccessfulKills: Array<
    (input: Parameters<WorkspaceScriptTerminalPort["kill"]>[0]) => Effect.Effect<void>
  > = [];
  const killExitEvents: boolean[] = [];
  const killFailureSnapshotOverrides: Array<Partial<TerminalSessionSnapshot> | null> = [];
  const inspectionResults: Array<"active" | "inactive" | "missing" | "quarantined"> = [];
  const inspectionSnapshotOverrides: Array<Partial<TerminalSessionSnapshot> | null> = [];
  const inspectionFailures: unknown[] = [];
  const beforeInspections: Array<() => Effect.Effect<void>> = [];
  const inspectionRequests: Array<
    Parameters<WorkspaceScriptTerminalPort["inspectSessionReceipt"]>[0]
  > = [];
  const sessionSnapshots = new Map<string, TerminalSessionSnapshot>();
  const sessionOwners = new Map<string, TerminalSessionOwner | null>();
  const historyRequests: Array<{ threadId: string; terminalId: string }> = [];
  const histories = new Map<string, string>();
  const historyFailures: unknown[] = [];
  const killFailures: unknown[] = [];
  const activeRunFailures: Array<WorkspaceScriptStoreError | undefined> = [];
  const stopClaimFailures: Array<WorkspaceScriptStoreError | undefined> = [];
  const stopRecoveryWaits: number[] = [];
  let projectAvailable = true;
  let nowUnixMs = 1_000;
  let stopClaimSequence = 0;
  let waitForStopClaimExpiryOverride: ((retryAtUnixMs: number) => Effect.Effect<void>) | undefined;

  const emit = (event: TerminalEvent) =>
    Effect.forEach([...listeners], (listener) => listener(event), { discard: true });

  const seedTerminalSession = (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly cwd: string;
    readonly owner?: TerminalSessionOwner | null;
    readonly snapshot?: Partial<TerminalSessionSnapshot>;
  }) => {
    const sessionKey = `${input.threadId}\u0000${input.terminalId}`;
    const seeded = {
      ...snapshot({
        threadId: input.threadId,
        terminalId: input.terminalId,
        cwd: input.cwd,
      }),
      ...input.snapshot,
    };
    sessionSnapshots.set(sessionKey, seeded);
    sessionOwners.set(sessionKey, input.owner ?? null);
    return seeded;
  };

  const readTerminalSession = (threadId: string, terminalId: string) =>
    sessionSnapshots.get(`${threadId}\u0000${terminalId}`) ?? null;

  const readTerminalOwner = (threadId: string, terminalId: string) =>
    sessionOwners.get(`${threadId}\u0000${terminalId}`) ?? null;

  const terminal: WorkspaceScriptTerminalPort = {
    runCommand: (input) =>
      Effect.gen(function* () {
        const beforeRunCommand = beforeRunCommands.shift();
        if (beforeRunCommand !== undefined) yield* beforeRunCommand();
        const sessionKey = `${input.threadId}\u0000${input.terminalId}`;
        const existingSnapshot = sessionSnapshots.get(sessionKey);
        if (existingSnapshot !== undefined) {
          if (!terminalSessionOwnerEquals(sessionOwners.get(sessionKey) ?? null, input.owner)) {
            return yield* new WorkspaceScriptDependencyError({
              operation: "runCommand",
              cause: new TerminalSessionOwnershipError({
                threadId: input.threadId,
                terminalId: input.terminalId,
              }),
            });
          }
          return existingSnapshot;
        }
        starts.push(input);
        const nextSnapshot = {
          ...snapshot({ ...input, worktreePath: input.worktreePath ?? null }),
          ...startSnapshotOverrides.shift(),
        };
        sessionSnapshots.set(sessionKey, nextSnapshot);
        sessionOwners.set(sessionKey, input.owner);
        const beforeReturn = beforeStartReturns.shift();
        if (beforeReturn !== undefined) yield* beforeReturn(input);
        return nextSnapshot;
      }),
    kill: (input) =>
      Effect.gen(function* () {
        kills.push(input);
        const beforeKill = beforeKills.shift();
        if (beforeKill !== undefined) yield* beforeKill(input);
        const sessionKey = `${input.threadId}\u0000${input.terminalId}`;
        if (
          !terminalSessionOwnerEquals(sessionOwners.get(sessionKey) ?? null, input.expectedOwner)
        ) {
          return yield* new WorkspaceScriptDependencyError({
            operation: "killTerminal",
            cause: new TerminalSessionOwnershipError({
              threadId: input.threadId,
              terminalId: input.terminalId,
            }),
          });
        }
        const failure = killFailures.shift();
        if (failure !== undefined) {
          const failureSnapshotOverride = killFailureSnapshotOverrides.shift();
          if (failureSnapshotOverride === null) {
            sessionSnapshots.delete(sessionKey);
            sessionOwners.delete(sessionKey);
          } else if (failureSnapshotOverride !== undefined) {
            const currentSnapshot = sessionSnapshots.get(sessionKey);
            if (currentSnapshot !== undefined) {
              sessionSnapshots.set(sessionKey, {
                ...currentSnapshot,
                ...failureSnapshotOverride,
              });
            }
          }
          return yield* new WorkspaceScriptDependencyError({
            operation: "killTerminal",
            cause: failure,
          });
        }
        const currentSnapshot = sessionSnapshots.get(sessionKey);
        if (currentSnapshot !== undefined) {
          sessionSnapshots.set(sessionKey, {
            ...currentSnapshot,
            status: "exited",
            pid: null,
            exitCode: null,
            exitSignal: 15,
            sequence: (currentSnapshot.sequence ?? 0) + 1,
          });
        }
        if ((killExitEvents.shift() ?? true) === false) return;
        yield* emit({
          type: "exited",
          ...input,
          sequence: 2,
          exitCode: null,
          exitSignal: 15,
        });
        const afterSuccessfulKill = afterSuccessfulKills.shift();
        if (afterSuccessfulKill !== undefined) yield* afterSuccessfulKill(input);
      }),
    inspectSessionReceipt: (input) =>
      Effect.gen(function* () {
        inspectionRequests.push(input);
        const beforeInspection = beforeInspections.shift();
        if (beforeInspection !== undefined) yield* beforeInspection();
        const failure = inspectionFailures.shift();
        if (failure !== undefined) {
          return yield* new WorkspaceScriptDependencyError({
            operation: "inspectTerminal",
            cause: failure,
          });
        }
        const sessionKey = `${input.threadId}\u0000${input.terminalId}`;
        const snapshotOverride = inspectionSnapshotOverrides.shift();
        if (snapshotOverride === null) {
          sessionSnapshots.delete(sessionKey);
          sessionOwners.delete(sessionKey);
        } else if (snapshotOverride !== undefined) {
          const currentSnapshot = sessionSnapshots.get(sessionKey);
          if (currentSnapshot !== undefined) {
            sessionSnapshots.set(sessionKey, { ...currentSnapshot, ...snapshotOverride });
          }
        }
        const currentSnapshot = sessionSnapshots.get(sessionKey) ?? null;
        if (
          currentSnapshot !== null &&
          !terminalSessionOwnerEquals(sessionOwners.get(sessionKey) ?? null, input.expectedOwner)
        ) {
          return yield* new WorkspaceScriptDependencyError({
            operation: "inspectTerminal",
            cause: new TerminalSessionOwnershipError({
              threadId: input.threadId,
              terminalId: input.terminalId,
            }),
          });
        }
        const inspection =
          currentSnapshot === null ? "missing" : (inspectionResults.shift() ?? "active");
        return {
          inspection,
          snapshot: inspection === "missing" ? null : currentSnapshot,
        };
      }),
    getHistory: (input) =>
      Effect.gen(function* () {
        historyRequests.push(input);
        const failure = historyFailures.shift();
        if (failure !== undefined) {
          return yield* new WorkspaceScriptDependencyError({
            operation: "getHistory",
            cause: failure,
          });
        }
        return histories.get(`${input.threadId}\u0000${input.terminalId}`) ?? "";
      }),
    subscribe: (listener) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
  };

  const storeLayer = WorkspaceScriptStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

  return Effect.gen(function* () {
    const storeContext = yield* Layer.build(storeLayer);
    const store = Context.get(storeContext, WorkspaceScriptStore);
    const serviceStore: WorkspaceScriptStoreShape = {
      ...store,
      claimStart: (run) =>
        Effect.gen(function* () {
          const claim = yield* store.claimStart(run);
          const afterStartClaim = afterStartClaims.shift();
          if (afterStartClaim !== undefined) yield* afterStartClaim();
          return claim;
        }),
      claimStop: (input) => {
        const failure = stopClaimFailures.shift();
        return failure === undefined ? store.claimStop(input) : Effect.fail(failure);
      },
      getActiveRunByTerminal: (threadId, terminalId) => {
        const failure = activeRunFailures.shift();
        return failure === undefined
          ? store.getActiveRunByTerminal(threadId, terminalId)
          : Effect.fail(failure);
      },
    };
    let currentServiceScope: Scope.Closeable | null = null;
    const makeService = () =>
      Effect.gen(function* () {
        const serviceScope = yield* Scope.make();
        const service = yield* makeWorkspaceScriptService({
          store: serviceStore,
          terminal,
          resolveProject: (projectId) =>
            Effect.succeed(
              projectAvailable && projectId === PROJECT.id ? Option.some(PROJECT) : Option.none(),
            ),
          resolveThreadProjectId: (threadId) =>
            Effect.succeed(threadId === "thread-1" ? Option.some(PROJECT.id) : Option.none()),
          platform: "win32",
          windowsComSpec: "C:/Windows/System32/cmd.exe",
          now: () => nowUnixMs++,
          makeStopClaimOwnerId: () => `test-stop-claim-${++stopClaimSequence}`,
          ...(waitForStopClaimExpiryOverride === undefined
            ? {}
            : {
                waitForStopClaimExpiry: (retryAtUnixMs: number) => {
                  stopRecoveryWaits.push(retryAtUnixMs);
                  return waitForStopClaimExpiryOverride?.(retryAtUnixMs) ?? Effect.void;
                },
              }),
        }).pipe(Scope.provide(serviceScope));
        currentServiceScope = serviceScope;
        return service;
      });
    const restartService = () =>
      Effect.gen(function* () {
        if (currentServiceScope !== null) {
          yield* Scope.close(currentServiceScope, Exit.void);
          currentServiceScope = null;
        }
        return yield* makeService();
      });
    const service = yield* makeService();
    yield* Effect.addFinalizer(() =>
      currentServiceScope === null
        ? Effect.void
        : Scope.close(currentServiceScope, Exit.void).pipe(Effect.ignore),
    );
    return {
      service,
      starts,
      startSnapshotOverrides,
      beforeStartReturns,
      beforeRunCommands,
      afterStartClaims,
      kills,
      beforeKills,
      afterSuccessfulKills,
      killExitEvents,
      killFailureSnapshotOverrides,
      inspectionResults,
      inspectionSnapshotOverrides,
      inspectionFailures,
      beforeInspections,
      inspectionRequests,
      histories,
      historyFailures,
      killFailures,
      activeRunFailures,
      stopClaimFailures,
      stopRecoveryWaits,
      historyRequests,
      emit,
      seedTerminalSession,
      readTerminalSession,
      readTerminalOwner,
      store,
      restartService,
      setStopRecoveryWait: (
        waitForStopClaimExpiry: (retryAtUnixMs: number) => Effect.Effect<void>,
      ) => void (waitForStopClaimExpiryOverride = waitForStopClaimExpiry),
      setNow: (value: number) => void (nowUnixMs = value),
      setProjectAvailable: (available: boolean) => void (projectAvailable = available),
    };
  });
};

const startRequest = {
  operationId: "operation-1",
  projectId: "project-1",
  threadId: "thread-1",
  scriptId: "serve",
};

const drainBackgroundFibers = () =>
  Effect.forEach(Array.from({ length: 16 }), () => Effect.yieldNow, { discard: true });

describe("WorkspaceScriptService", () => {
  it("使用平台原生 shell 执行声明式命令，不让 Terminal Manager 猜测参数", () => {
    assert.deepEqual(workspaceScriptShellInvocation({ platform: "linux", command: "pnpm dev" }), {
      command: "/bin/sh",
      args: ["-lc", "pnpm dev"],
    });
    assert.deepEqual(
      workspaceScriptShellInvocation({
        platform: "win32",
        command: "pnpm dev",
        windowsComSpec: "C:/Windows/System32/cmd.exe",
      }),
      {
        command: "C:/Windows/System32/cmd.exe",
        args: ["/d", "/s", "/c", "pnpm dev"],
      },
    );
  });

  it.effect("并发重复启动只创建一个受监督终端，并返回同一稳定 Run", () =>
    Effect.gen(function* () {
      const { service, starts } = yield* makeFixture();
      const [first, second] = yield* Effect.all(
        [service.start(startRequest), service.start(startRequest)],
        { concurrency: "unbounded" },
      );

      assert.equal(starts.length, 1);
      assert.equal(first.workspaceScriptRunId, "workspace-script-run:operation-1");
      assert.equal(second.workspaceScriptRunId, first.workspaceScriptRunId);
      assert.equal(
        Option.getOrThrow(yield* service.get(first.workspaceScriptRunId)).status,
        "running",
      );
      assert.deepEqual(starts[0], {
        threadId: "thread-1",
        terminalId: "workspace-script-operation-1",
        cwd: "E:/workspace/project-1",
        env: { T3CODE_PROJECT_ROOT: "E:/workspace/project-1" },
        command: "C:/Windows/System32/cmd.exe",
        args: ["/d", "/s", "/c", "pnpm dev"],
        owner: makeWorkspaceScriptTerminalOwner({
          workspaceScriptRunId: "workspace-script-run:operation-1",
          generation: first.requestedAtUnixMs,
        }),
      });
    }),
  );

  it.effect("普通终端预占脚本 terminalId 时稳定失败且不接管会话", () =>
    Effect.gen(function* () {
      const {
        service,
        seedTerminalSession,
        readTerminalSession,
        readTerminalOwner,
        starts,
        kills,
      } = yield* makeFixture();
      const operationId = "operation-terminal-preoccupied";
      const terminalId = `workspace-script-${operationId}`;
      const workspaceScriptRunId = `workspace-script-run:${operationId}`;
      const ordinarySnapshot = seedTerminalSession({
        threadId: startRequest.threadId,
        terminalId,
        cwd: "E:/workspace/ordinary-terminal",
        owner: null,
        snapshot: { pid: 9911, label: "ordinary-shell" },
      });

      const startResult = yield* service
        .start({ ...startRequest, operationId })
        .pipe(Effect.result);
      const afterStart = Option.getOrThrow(yield* service.get(workspaceScriptRunId));
      yield* service
        .stop({
          workspaceScriptRunId,
          operationId: "stop-preoccupied-terminal",
          expectedRevision: afterStart.revision,
        })
        .pipe(Effect.result);
      const afterStop = Option.getOrThrow(yield* service.get(workspaceScriptRunId));

      assert.equal(startResult._tag, "Failure");
      if (startResult._tag === "Failure") {
        assert.equal(startResult.failure.code, "workspace_script_start_failed");
      }
      assert.equal(afterStart.status, "failed");
      assert.equal(afterStop.status, "failed");
      assert.deepEqual(readTerminalSession(startRequest.threadId, terminalId), ordinarySnapshot);
      assert.isNull(readTerminalOwner(startRequest.threadId, terminalId));
      assert.equal(starts.length, 0);
      assert.equal(kills.length, 0);
    }),
  );

  it.effect("PTY 已创建但启动后 Store 读取失败时，重建服务按原 owner 恢复 running", () =>
    Effect.gen(function* () {
      const { service, restartService, starts, inspectionRequests, activeRunFailures } =
        yield* makeFixture();
      const operationId = "operation-start-post-spawn-store-failure";
      const workspaceScriptRunId = `workspace-script-run:${operationId}`;
      activeRunFailures.push(
        undefined,
        new PersistenceSqlError({
          operation: "WorkspaceScriptService.test.postSpawnRead",
          detail: "temporary read failure",
        }),
      );

      yield* service.start({ ...startRequest, operationId }).pipe(Effect.exit);
      const restarted = yield* restartService();
      const recovered = Option.getOrThrow(yield* restarted.get(workspaceScriptRunId));

      assert.equal(recovered.status, "running");
      assert.equal(starts.length, 1);
      assert.deepEqual(inspectionRequests.at(-1)?.expectedOwner, starts[0]?.owner);
    }),
  );

  it.effect("PTY 创建后启动调用 fiber 中断时，重建服务不重启进程并恢复 running", () =>
    Effect.gen(function* () {
      const { service, restartService, starts, inspectionRequests, beforeStartReturns } =
        yield* makeFixture();
      const operationId = "operation-start-fiber-interrupted";
      const workspaceScriptRunId = `workspace-script-run:${operationId}`;
      beforeStartReturns.push(() => Effect.interrupt);

      const interrupted = yield* service.start({ ...startRequest, operationId }).pipe(Effect.exit);
      const restarted = yield* restartService();
      const recovered = Option.getOrThrow(yield* restarted.get(workspaceScriptRunId));

      assert.equal(interrupted._tag, "Failure");
      assert.equal(recovered.status, "running");
      assert.equal(starts.length, 1);
      assert.deepEqual(inspectionRequests.at(-1)?.expectedOwner, starts[0]?.owner);
    }),
  );

  it.effect("error 且无进程的启动快照不会被持久化为 running", () =>
    Effect.gen(function* () {
      const { service, starts, startSnapshotOverrides, inspectionResults } = yield* makeFixture();
      startSnapshotOverrides.push({ status: "error", pid: null });
      inspectionResults.push("inactive");

      const request = { ...startRequest, operationId: "operation-start-error-without-process" };
      const error = yield* service.start(request).pipe(Effect.flip);
      const repeated = yield* service.start(request);
      const run = Option.getOrThrow(
        yield* service.get("workspace-script-run:operation-start-error-without-process"),
      );

      assert.equal(error.code, "workspace_script_start_failed");
      assert.equal(run.status, "failed");
      assert.equal(repeated.status, "failed");
      assert.equal(run.revision, 2);
      assert.equal(run.errorCode, "workspace_script_start_failed");
      assert.equal(run.errorDetail, WORKSPACE_SCRIPT_START_FAILED_DETAIL);
      assert.isNull(run.startedAtUnixMs);
      assert.isNotNull(run.finishedAtUnixMs);
      assert.equal(starts.length, 1);
    }),
  );

  it.effect("error 且仍有受监督进程的启动快照不会被持久化为 running", () =>
    Effect.gen(function* () {
      const { service, starts, startSnapshotOverrides, inspectionResults, beforeKills, store } =
        yield* makeFixture();
      startSnapshotOverrides.push({ status: "error", pid: 4321 });
      inspectionResults.push("active");

      const request = { ...startRequest, operationId: "operation-start-error-with-process" };
      const workspaceScriptRunId = "workspace-script-run:operation-start-error-with-process";
      beforeKills.push(() =>
        store
          .getActiveRunByTerminal(request.threadId, `workspace-script-${request.operationId}`)
          .pipe(
            Effect.map((stored) => {
              const claimed = Option.getOrThrow(stored);
              assert.equal(claimed.run.status, "starting");
              assert.equal(
                claimed.stopOperationId,
                makeWorkspaceScriptStartTerminationOperationId(workspaceScriptRunId),
              );
            }),
            Effect.orDie,
          ),
      );
      const error = yield* service.start(request).pipe(Effect.flip);
      const repeated = yield* service.start(request);
      const run = Option.getOrThrow(yield* service.get(workspaceScriptRunId));

      assert.equal(error.code, "workspace_script_start_failed");
      assert.equal(run.status, "failed");
      assert.equal(repeated.status, "failed");
      assert.equal(run.revision, 3);
      assert.equal(run.errorCode, "workspace_script_start_failed");
      assert.equal(run.errorDetail, WORKSPACE_SCRIPT_START_FAILED_DETAIL);
      assert.isNotNull(run.finishedAtUnixMs);
      assert.equal(starts.length, 1);
    }),
  );

  it.effect("退出观察缺口进入 quarantine 时不会确认 Workspace Script 已启动", () =>
    Effect.gen(function* () {
      const { service, starts, startSnapshotOverrides, inspectionResults, inspectionRequests } =
        yield* makeFixture();
      startSnapshotOverrides.push({ status: "running", pid: 5678 });
      inspectionResults.push("quarantined");

      const request = { ...startRequest, operationId: "operation-start-quarantined" };
      const error = yield* service.start(request).pipe(Effect.flip);
      const repeated = yield* service.start(request);
      const run = Option.getOrThrow(
        yield* service.get("workspace-script-run:operation-start-quarantined"),
      );

      assert.equal(error.code, "workspace_script_start_failed");
      assert.equal(run.status, "failed");
      assert.equal(repeated.status, "failed");
      assert.equal(run.revision, 3);
      assert.equal(run.errorCode, "workspace_script_start_failed");
      assert.equal(run.errorDetail, WORKSPACE_SCRIPT_START_FAILED_DETAIL);
      assert.isNotNull(run.finishedAtUnixMs);
      assert.equal(starts.length, 1);
      assert.equal(inspectionRequests.length, 2);
      assert.deepEqual(
        inspectionRequests[0]?.expectedOwner,
        makeWorkspaceScriptTerminalOwner({
          workspaceScriptRunId: run.workspaceScriptRunId,
          generation: run.requestedAtUnixMs,
        }),
      );
    }),
  );

  it.effect("启动 error 事件先到时与同步确认路径收敛到同一失败状态", () =>
    Effect.gen(function* () {
      const {
        service,
        emit,
        starts,
        startSnapshotOverrides,
        beforeStartReturns,
        inspectionResults,
      } = yield* makeFixture();
      startSnapshotOverrides.push({ status: "error", pid: null });
      inspectionResults.push("inactive");
      beforeStartReturns.push((input) =>
        emit({
          type: "error",
          threadId: input.threadId,
          terminalId: input.terminalId,
          sequence: 1,
          message: "native listener registration failed: secret detail",
        }),
      );

      const request = { ...startRequest, operationId: "operation-start-error-event-race" };
      const error = yield* service.start(request).pipe(Effect.flip);
      const repeated = yield* service.start(request);
      const run = Option.getOrThrow(
        yield* service.get("workspace-script-run:operation-start-error-event-race"),
      );

      assert.equal(error.code, "workspace_script_start_failed");
      assert.equal(run.status, "failed");
      assert.equal(repeated.status, "failed");
      assert.equal(run.revision, 2);
      assert.equal(run.errorCode, "workspace_script_start_failed");
      assert.equal(run.errorDetail, WORKSPACE_SCRIPT_START_FAILED_DETAIL);
      assert.notInclude(run.errorDetail ?? "", "secret detail");
      assert.equal(starts.length, 1);
    }),
  );

  it.effect("started 事件先到也不能绕过 owner-bound quarantine 确认", () =>
    Effect.gen(function* () {
      const {
        service,
        emit,
        startSnapshotOverrides,
        beforeStartReturns,
        inspectionResults,
        beforeInspections,
      } = yield* makeFixture();
      const operationId = "operation-started-before-quarantine";
      const workspaceScriptRunId = `workspace-script-run:${operationId}`;
      startSnapshotOverrides.push({ status: "running", pid: 6789 });
      inspectionResults.push("quarantined");
      beforeStartReturns.push((input) =>
        emit({
          type: "started",
          threadId: input.threadId,
          terminalId: input.terminalId,
          sequence: 1,
          snapshot: {
            ...snapshot({ ...input, worktreePath: input.worktreePath ?? null }),
            pid: 6789,
          },
        }),
      );
      beforeInspections.push(() =>
        service.get(workspaceScriptRunId).pipe(
          Effect.map((run) => {
            assert.equal(Option.getOrThrow(run).status, "starting");
          }),
          Effect.orDie,
        ),
      );

      yield* service.start({ ...startRequest, operationId }).pipe(Effect.flip);
    }),
  );

  it.effect("短命脚本的 exited 快照直接收口真实退出而不是启动失败", () =>
    Effect.gen(function* () {
      const { service, inspectionSnapshotOverrides, inspectionResults } = yield* makeFixture();
      inspectionSnapshotOverrides.push({
        status: "exited",
        pid: null,
        exitCode: 0,
        exitSignal: null,
      });
      inspectionResults.push("inactive");

      const run = yield* service.start({
        ...startRequest,
        operationId: "operation-short-lived-exit",
      });

      assert.equal(run.status, "exited");
      assert.equal(run.exitCode, 0);
      assert.isNotNull(run.finishedAtUnixMs);
      assert.isNull(run.errorCode);
    }),
  );

  it.effect(
    "inspection 暂时失败时保留 starting，重复 operation 不依赖当前项目配置即可重新确认",
    () =>
      Effect.gen(function* () {
        const {
          service,
          starts,
          inspectionFailures,
          inspectionResults,
          inspectionRequests,
          setProjectAvailable,
        } = yield* makeFixture();
        const request = { ...startRequest, operationId: "operation-inspection-retry" };
        inspectionFailures.push(new Error("inspection temporarily unavailable"));

        const pending = yield* service.start(request);
        setProjectAvailable(false);
        inspectionResults.push("active");
        const confirmed = yield* service.start(request);

        assert.equal(pending.status, "starting");
        assert.equal(confirmed.status, "running");
        assert.equal(starts.length, 1);
        assert.deepEqual(inspectionRequests[1]?.expectedOwner, starts[0]?.owner);
      }),
  );

  it.effect("quarantine 补偿终止失败时保留可重试的 starting", () =>
    Effect.gen(function* () {
      const { service, kills, killFailures, startSnapshotOverrides, inspectionResults } =
        yield* makeFixture();
      startSnapshotOverrides.push({ status: "running", pid: 7890 });
      inspectionResults.push("quarantined");
      killFailures.push(new Error("exit observation gap"));

      const error = yield* service
        .start({ ...startRequest, operationId: "operation-quarantine-kill-failed" })
        .pipe(Effect.flip);
      const run = Option.getOrThrow(
        yield* service.get("workspace-script-run:operation-quarantine-kill-failed"),
      );

      assert.equal(error.code, "workspace_script_start_failed");
      assert.equal(run.status, "starting");
      assert.isNull(run.finishedAtUnixMs);
      assert.equal(kills.length, 1);
    }),
  );

  it.effect("kill 响应丢失但 fresh receipt 已退出时不会重复终止", () =>
    Effect.gen(function* () {
      const {
        service,
        kills,
        killFailures,
        killFailureSnapshotOverrides,
        startSnapshotOverrides,
        inspectionResults,
        inspectionRequests,
      } = yield* makeFixture();
      startSnapshotOverrides.push({ status: "error", pid: 7900 });
      inspectionResults.push("active", "inactive");
      killFailureSnapshotOverrides.push({
        status: "exited",
        pid: null,
        exitCode: null,
        exitSignal: 15,
      });
      killFailures.push(new Error("termination response lost"));

      const error = yield* service
        .start({ ...startRequest, operationId: "operation-kill-response-lost" })
        .pipe(Effect.flip);
      const run = Option.getOrThrow(
        yield* service.get("workspace-script-run:operation-kill-response-lost"),
      );

      assert.equal(error.code, "workspace_script_start_failed");
      assert.equal(run.status, "failed");
      assert.equal(run.revision, 3);
      assert.equal(kills.length, 1);
      assert.equal(inspectionRequests.length, 2);
    }),
  );

  it.effect("终止意图落库后 Service 实例中断，重建实例可复用同一意图继续收口", () =>
    Effect.gen(function* () {
      const {
        service,
        restartService,
        store,
        kills,
        beforeKills,
        startSnapshotOverrides,
        inspectionResults,
        setNow,
      } = yield* makeFixture();
      const operationId = "operation-start-termination-replay";
      const workspaceScriptRunId = `workspace-script-run:${operationId}`;
      startSnapshotOverrides.push({ status: "error", pid: 7920 });
      inspectionResults.push("active", "active");
      beforeKills.push(() => Effect.interrupt);

      const interrupted = yield* service.start({ ...startRequest, operationId }).pipe(Effect.exit);
      const stored = Option.getOrThrow(
        yield* store.getActiveRunByTerminal("thread-1", `workspace-script-${operationId}`),
      );
      setNow(40_000);
      const restarted = yield* restartService();
      const replay = yield* restarted.start({ ...startRequest, operationId });
      const run = Option.getOrThrow(yield* restarted.get(workspaceScriptRunId));

      assert.equal(interrupted._tag, "Failure");
      assert.equal(
        stored.stopOperationId,
        makeWorkspaceScriptStartTerminationOperationId(workspaceScriptRunId),
      );
      assert.equal(replay.status, "failed");
      assert.equal(run.status, "failed");
      assert.equal(kills.length, 2);
    }),
  );

  it.effect("Stop 在 inspection 期间抢先领取时保持 stopping 赢家且不补偿终止", () =>
    Effect.gen(function* () {
      const {
        service,
        store,
        kills,
        startSnapshotOverrides,
        inspectionResults,
        beforeInspections,
      } = yield* makeFixture();
      const inspectionStarted = yield* Deferred.make<void>();
      const releaseInspection = yield* Deferred.make<void>();
      const operationId = "operation-stop-wins-start-failure";
      const workspaceScriptRunId = `workspace-script-run:${operationId}`;
      startSnapshotOverrides.push({ status: "error", pid: 7950 });
      inspectionResults.push("active");
      beforeInspections.push(() =>
        Deferred.succeed(inspectionStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseInspection)),
        ),
      );

      const startFiber = yield* service
        .start({ ...startRequest, operationId })
        .pipe(Effect.forkChild);
      yield* Deferred.await(inspectionStarted);
      const starting = Option.getOrThrow(yield* service.get(workspaceScriptRunId));
      const stopClaim = yield* store.claimStop({
        run: {
          ...starting,
          status: "stopping",
          revision: starting.revision + 1,
          startedAtUnixMs: starting.requestedAtUnixMs,
          updatedAtUnixMs: starting.updatedAtUnixMs,
        },
        operationId: "stop-operation-wins-start-failure",
        expectedRevision: starting.revision,
        claimOwnerId: "external-stop-during-inspection",
        claimedAtUnixMs: 2_000,
        claimExpiresAtUnixMs: 32_000,
      });
      yield* Deferred.succeed(releaseInspection, undefined);
      const winner = yield* Fiber.join(startFiber);

      assert.isTrue(stopClaim.claimed);
      assert.equal(winner.status, "stopping");
      assert.equal(Option.getOrThrow(yield* service.get(workspaceScriptRunId)).status, "stopping");
      assert.equal(kills.length, 0);
    }),
  );

  it.effect("starting stop 在 runCommand 前形成 spawn gate，不创建迟到终端", () =>
    Effect.gen(function* () {
      const { service, afterStartClaims, beforeKills, starts, kills } = yield* makeFixture();
      const claimPersisted = yield* Deferred.make<void>();
      const releaseStart = yield* Deferred.make<void>();
      const killEntered = yield* Deferred.make<void>();
      const releaseKill = yield* Deferred.make<void>();
      const operationId = "operation-stop-before-spawn";
      const workspaceScriptRunId = `workspace-script-run:${operationId}`;
      afterStartClaims.push(() =>
        Deferred.succeed(claimPersisted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseStart)),
        ),
      );
      beforeKills.push(() =>
        Deferred.succeed(killEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseKill))),
      );

      const startFiber = yield* service
        .start({ ...startRequest, operationId })
        .pipe(Effect.forkChild);
      yield* Deferred.await(claimPersisted);
      const starting = Option.getOrThrow(yield* service.get(workspaceScriptRunId));
      const stopFiber = yield* service
        .stop({
          workspaceScriptRunId,
          operationId: "stop-operation-before-spawn",
          expectedRevision: starting.revision,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(killEntered);
      yield* Deferred.succeed(releaseStart, undefined);
      const startWinner = yield* Fiber.join(startFiber);
      yield* Deferred.succeed(releaseKill, undefined);
      const stopWinner = yield* Fiber.join(stopFiber);

      assert.equal(startWinner.status, "stopped");
      assert.equal(stopWinner.status, "stopped");
      assert.equal(Option.getOrThrow(yield* service.get(workspaceScriptRunId)).status, "stopped");
      assert.equal(starts.length, 0);
      assert.equal(kills.length, 1);
    }),
  );

  it.effect("stop 在 runCommand 进入后抢先时，spawn 后 reconciliation 终止迟到进程", () =>
    Effect.gen(function* () {
      const { service, beforeRunCommands, starts, kills } = yield* makeFixture();
      const runCommandEntered = yield* Deferred.make<void>();
      const releaseRunCommand = yield* Deferred.make<void>();
      const operationId = "operation-stop-during-spawn";
      const workspaceScriptRunId = `workspace-script-run:${operationId}`;
      beforeRunCommands.push(() =>
        Deferred.succeed(runCommandEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseRunCommand)),
        ),
      );

      const startFiber = yield* service
        .start({ ...startRequest, operationId })
        .pipe(Effect.forkChild);
      yield* Deferred.await(runCommandEntered);
      const starting = Option.getOrThrow(yield* service.get(workspaceScriptRunId));
      const stopError = yield* service
        .stop({
          workspaceScriptRunId,
          operationId: "stop-operation-during-spawn",
          expectedRevision: starting.revision,
        })
        .pipe(Effect.flip);
      yield* Deferred.succeed(releaseRunCommand, undefined);
      const startWinner = yield* Fiber.join(startFiber);

      assert.equal(stopError.code, "workspace_script_stop_failed");
      assert.equal(startWinner.status, "stopped");
      assert.equal(starts.length, 1);
      assert.equal(kills.length, 2);
    }),
  );

  it.effect("error 且仍 active 时仅在补偿终止成功后写入 failed", () =>
    Effect.gen(function* () {
      const { service, kills, startSnapshotOverrides, inspectionResults } = yield* makeFixture();
      startSnapshotOverrides.push({ status: "error", pid: 8901 });
      inspectionResults.push("active");

      const error = yield* service
        .start({ ...startRequest, operationId: "operation-error-active-compensated" })
        .pipe(Effect.flip);
      const run = Option.getOrThrow(
        yield* service.get("workspace-script-run:operation-error-active-compensated"),
      );

      assert.equal(error.code, "workspace_script_start_failed");
      assert.equal(run.status, "failed");
      assert.equal(run.revision, 3);
      assert.equal(kills.length, 1);
    }),
  );

  it.effect("同一 operationId 绑定不同脚本时 fail-closed", () =>
    Effect.gen(function* () {
      const { service, starts } = yield* makeFixture();
      yield* service.start(startRequest);
      const error = yield* service.start({ ...startRequest, scriptId: "test" }).pipe(Effect.flip);
      const worktreeError = yield* service
        .start({ ...startRequest, worktreePath: "E:/workspace/project-1-worktree" })
        .pipe(Effect.flip);

      assert.equal(error.code, "workspace_script_idempotency_conflict");
      assert.equal(worktreeError.code, "workspace_script_idempotency_conflict");
      assert.equal(starts.length, 1);
    }),
  );

  it.effect("拒绝跨项目线程和不存在的脚本，不启动任何终端", () =>
    Effect.gen(function* () {
      const { service, starts } = yield* makeFixture();
      const wrongThread = yield* service
        .start({ ...startRequest, threadId: "thread-other" })
        .pipe(Effect.flip);
      const missingScript = yield* service
        .start({ ...startRequest, operationId: "operation-2", scriptId: "missing" })
        .pipe(Effect.flip);

      assert.equal(wrongThread.code, "workspace_script_thread_project_mismatch");
      assert.equal(missingScript.code, "workspace_script_not_found");
      assert.equal(starts.length, 0);
    }),
  );

  it.effect("自然退出事件更新对应 Run，忽略无归属终端", () =>
    Effect.gen(function* () {
      const { service, emit } = yield* makeFixture();
      const started = yield* service.start(startRequest);
      yield* emit({
        type: "exited",
        threadId: "thread-other",
        terminalId: "terminal-other",
        sequence: 1,
        exitCode: 9,
        exitSignal: null,
      });
      yield* emit({
        type: "exited",
        threadId: started.threadId,
        terminalId: started.terminalId,
        sequence: 2,
        exitCode: 7,
        exitSignal: null,
      });

      const run = Option.getOrThrow(yield* service.get(started.workspaceScriptRunId));
      assert.equal(run.status, "exited");
      assert.equal(run.exitCode, 7);
      assert.isNotNull(run.finishedAtUnixMs);
    }),
  );

  it.effect("自然退出后的 stop 返回既有终态且不重复终止", () =>
    Effect.gen(function* () {
      const { service, emit, kills } = yield* makeFixture();
      const started = yield* service.start({
        ...startRequest,
        operationId: "operation-stop-after-exit",
      });
      yield* emit({
        type: "exited",
        threadId: started.threadId,
        terminalId: started.terminalId,
        sequence: 2,
        exitCode: 0,
        exitSignal: null,
      });
      const exited = Option.getOrThrow(yield* service.get(started.workspaceScriptRunId));

      const repeated = yield* service.stop({
        workspaceScriptRunId: exited.workspaceScriptRunId,
        operationId: "stop-operation-after-exit",
        expectedRevision: exited.revision,
      });

      assert.equal(repeated.status, "exited");
      assert.equal(repeated.revision, exited.revision);
      assert.equal(repeated.exitCode, 0);
      assert.equal(kills.length, 0);
    }),
  );

  it.effect("并发终态事件只保留一个 CAS 赢家", () =>
    Effect.gen(function* () {
      const { service, emit } = yield* makeFixture();
      const started = yield* service.start({ ...startRequest, operationId: "operation-race" });

      yield* Effect.all(
        [
          emit({
            type: "exited",
            threadId: started.threadId,
            terminalId: started.terminalId,
            sequence: 2,
            exitCode: 0,
            exitSignal: null,
          }),
          emit({
            type: "closed",
            threadId: started.threadId,
            terminalId: started.terminalId,
            sequence: 3,
          }),
        ],
        { concurrency: "unbounded" },
      );

      const settled = Option.getOrThrow(yield* service.get(started.workspaceScriptRunId));
      assert.equal(settled.revision, started.revision + 1);
      assert.isTrue(settled.status === "exited" || settled.status === "failed");
    }),
  );

  it.effect("stop 只终止 Run 自己持有的终端，同一 operationId 不重复 kill", () =>
    Effect.gen(function* () {
      const { service, kills } = yield* makeFixture();
      const started = yield* service.start(startRequest);
      const stopped = yield* service.stop({
        workspaceScriptRunId: started.workspaceScriptRunId,
        operationId: "stop-operation-1",
        expectedRevision: started.revision,
      });
      const repeated = yield* service.stop({
        workspaceScriptRunId: started.workspaceScriptRunId,
        operationId: "stop-operation-1",
        expectedRevision: started.revision,
      });

      assert.deepEqual(kills, [
        {
          threadId: "thread-1",
          terminalId: started.terminalId,
          expectedOwner: makeWorkspaceScriptTerminalOwner({
            workspaceScriptRunId: started.workspaceScriptRunId,
            generation: started.requestedAtUnixMs,
          }),
        },
      ]);
      assert.equal(stopped.status, "stopped");
      assert.equal(repeated.status, "stopped");
    }),
  );

  it.effect("kill 成功但 exited 事件丢失时使用 fresh owner receipt 收口 stopped", () =>
    Effect.gen(function* () {
      const { service, killExitEvents } = yield* makeFixture();
      const started = yield* service.start({
        ...startRequest,
        operationId: "operation-stop-silent-exit",
      });
      killExitEvents.push(false);

      const stopped = yield* service.stop({
        workspaceScriptRunId: started.workspaceScriptRunId,
        operationId: "stop-operation-silent-exit",
        expectedRevision: started.revision,
      });

      assert.equal(stopped.status, "stopped");
      assert.equal(stopped.exitSignal, 15);
    }),
  );

  it.effect("kill 成功但 fresh receipt 仍 active 时不得假报 stopped", () =>
    Effect.gen(function* () {
      const { service, killExitEvents, inspectionResults, inspectionSnapshotOverrides } =
        yield* makeFixture();
      const started = yield* service.start({
        ...startRequest,
        operationId: "operation-stop-unconfirmed-success",
      });
      killExitEvents.push(false);
      inspectionResults.push("active");
      inspectionSnapshotOverrides.push({ status: "running", pid: 1234 });

      const error = yield* service
        .stop({
          workspaceScriptRunId: started.workspaceScriptRunId,
          operationId: "stop-operation-unconfirmed-success",
          expectedRevision: started.revision,
        })
        .pipe(Effect.flip);
      const retryable = Option.getOrThrow(yield* service.get(started.workspaceScriptRunId));

      assert.equal(error.code, "workspace_script_stop_failed");
      assert.equal(retryable.status, "running");
      assert.isNull(retryable.finishedAtUnixMs);
    }),
  );

  it.effect("kill 报错但 fresh receipt 已退出时返回 stopped 而不是假失败", () =>
    Effect.gen(function* () {
      const { service, killFailures, killFailureSnapshotOverrides } = yield* makeFixture();
      const started = yield* service.start({
        ...startRequest,
        operationId: "operation-stop-response-lost",
      });
      killFailureSnapshotOverrides.push({
        status: "exited",
        pid: null,
        exitCode: null,
        exitSignal: 15,
      });
      killFailures.push(new Error("termination response lost"));

      const stopped = yield* service.stop({
        workspaceScriptRunId: started.workspaceScriptRunId,
        operationId: "stop-operation-response-lost",
        expectedRevision: started.revision,
      });

      assert.equal(stopped.status, "stopped");
      assert.equal(stopped.exitSignal, 15);
    }),
  );

  it.effect("kill 报错时若 exited 事件已赢得 CAS，stop 返回终态赢家", () =>
    Effect.gen(function* () {
      const { service, emit, killFailures, beforeInspections } = yield* makeFixture();
      const started = yield* service.start({
        ...startRequest,
        operationId: "operation-stop-cas-winner",
      });
      killFailures.push(new Error("kill result unknown"));
      beforeInspections.push(() =>
        emit({
          type: "exited",
          threadId: started.threadId,
          terminalId: started.terminalId,
          sequence: 3,
          exitCode: null,
          exitSignal: 15,
        }),
      );

      const stopped = yield* service.stop({
        workspaceScriptRunId: started.workspaceScriptRunId,
        operationId: "stop-operation-cas-winner",
        expectedRevision: started.revision,
      });

      assert.equal(stopped.status, "stopped");
      assert.equal(stopped.exitSignal, 15);
    }),
  );

  it.effect("kill 失败后保留可重试状态，相同 operationId 可安全重试", () =>
    Effect.gen(function* () {
      const { service, kills, killFailures } = yield* makeFixture();
      const started = yield* service.start({
        ...startRequest,
        operationId: "operation-stop-retry",
      });
      killFailures.push(new Error("kill temporarily unavailable"));

      const firstError = yield* service
        .stop({
          workspaceScriptRunId: started.workspaceScriptRunId,
          operationId: "stop-operation-retry",
          expectedRevision: started.revision,
        })
        .pipe(Effect.flip);
      const retryable = Option.getOrThrow(yield* service.get(started.workspaceScriptRunId));
      const conflictingOperation = yield* service
        .stop({
          workspaceScriptRunId: started.workspaceScriptRunId,
          operationId: "stop-operation-other",
          expectedRevision: retryable.revision,
        })
        .pipe(Effect.flip);
      const repeated = yield* Effect.all(
        [
          service.stop({
            workspaceScriptRunId: started.workspaceScriptRunId,
            operationId: "stop-operation-retry",
            expectedRevision: started.revision,
          }),
          service.stop({
            workspaceScriptRunId: started.workspaceScriptRunId,
            operationId: "stop-operation-retry",
            expectedRevision: started.revision,
          }),
        ],
        { concurrency: "unbounded" },
      );

      assert.equal(firstError.code, "workspace_script_stop_failed");
      assert.equal(conflictingOperation.code, "workspace_script_stop_idempotency_conflict");
      assert.equal(retryable.status, "running");
      assert.isNull(retryable.finishedAtUnixMs);
      assert.isNull(retryable.errorCode);
      assert.equal(kills.length, 2);
      assert.deepEqual(
        repeated.map((run) => run.status),
        ["stopped", "stopped"],
      );
    }),
  );

  it.effect("stop claim 持久化后服务崩溃，重建实例会自动恢复原 operation", () =>
    Effect.gen(function* () {
      const { service, restartService, store, starts, kills, setNow } = yield* makeFixture();
      const started = yield* service.start({
        ...startRequest,
        operationId: "operation-stop-crash",
      });
      const claimed = yield* store.claimStop({
        run: {
          ...started,
          status: "stopping",
          revision: started.revision + 1,
          updatedAtUnixMs: started.updatedAtUnixMs + 1,
        },
        operationId: "stop-operation-crash",
        expectedRevision: started.revision,
        claimOwnerId: "crashed-stop-service",
        claimedAtUnixMs: 2_000,
        claimExpiresAtUnixMs: 32_000,
      });

      setNow(40_000);
      const restarted = yield* restartService();
      const recovered = Option.getOrThrow(yield* restarted.get(started.workspaceScriptRunId));

      assert.isTrue(claimed.claimed);
      assert.equal(recovered.status, "stopped");
      assert.equal(kills.length, 1);
      assert.deepEqual(kills[0]?.expectedOwner, starts[0]?.owner);
    }),
  );

  it.effect("running stop intent 在服务重启后自动重试并收口真实退出", () =>
    Effect.gen(function* () {
      const { service, restartService, starts, kills, killFailures } = yield* makeFixture();
      const started = yield* service.start({
        ...startRequest,
        operationId: "operation-stop-running-recovery",
      });
      killFailures.push(new Error("termination temporarily unavailable"));
      yield* service
        .stop({
          workspaceScriptRunId: started.workspaceScriptRunId,
          operationId: "stop-operation-running-recovery",
          expectedRevision: started.revision,
        })
        .pipe(Effect.flip);

      const retryable = Option.getOrThrow(yield* service.get(started.workspaceScriptRunId));
      const restarted = yield* restartService();
      const recovered = Option.getOrThrow(yield* restarted.get(started.workspaceScriptRunId));

      assert.equal(retryable.status, "running");
      assert.equal(recovered.status, "stopped");
      assert.equal(kills.length, 2);
      assert.deepEqual(kills[1]?.expectedOwner, starts[0]?.owner);
    }),
  );

  it.effect("running stop intent 的恢复终止仍未知时在同一服务生命周期继续重试", () =>
    Effect.gen(function* () {
      const {
        service,
        restartService,
        kills,
        killFailures,
        afterSuccessfulKills,
        stopRecoveryWaits,
        setNow,
        setStopRecoveryWait,
      } = yield* makeFixture();
      const recovered = yield* Deferred.make<void>();
      const started = yield* service.start({
        ...startRequest,
        operationId: "operation-stop-running-unknown",
      });
      killFailures.push(new Error("first termination failed"));
      yield* service
        .stop({
          workspaceScriptRunId: started.workspaceScriptRunId,
          operationId: "stop-operation-running-unknown",
          expectedRevision: started.revision,
        })
        .pipe(Effect.flip);
      killFailures.push(new Error("recovery termination response unknown"));
      afterSuccessfulKills.push(() => Deferred.succeed(recovered, undefined).pipe(Effect.asVoid));
      setStopRecoveryWait((retryAtUnixMs) => Effect.sync(() => setNow(retryAtUnixMs)));

      const restarted = yield* restartService();
      yield* drainBackgroundFibers();
      assert.isTrue(Option.isSome(yield* Deferred.poll(recovered)));
      const stopped = Option.getOrThrow(yield* restarted.get(started.workspaceScriptRunId));

      assert.equal(stopped.status, "stopped");
      assert.equal(kills.length, 3);
      assert.equal(stopRecoveryWaits.length, 1);
    }),
  );

  it.effect("stop intent 恢复首次 Store 读取失败时在同一服务生命周期重试", () =>
    Effect.gen(function* () {
      const {
        service,
        restartService,
        kills,
        killFailures,
        afterSuccessfulKills,
        activeRunFailures,
        stopRecoveryWaits,
        setNow,
        setStopRecoveryWait,
      } = yield* makeFixture();
      const recovered = yield* Deferred.make<void>();
      const started = yield* service.start({
        ...startRequest,
        operationId: "operation-stop-recovery-read-failure",
      });
      killFailures.push(new Error("initial termination failed"));
      yield* service
        .stop({
          workspaceScriptRunId: started.workspaceScriptRunId,
          operationId: "stop-operation-recovery-read-failure",
          expectedRevision: started.revision,
        })
        .pipe(Effect.flip);
      activeRunFailures.push(
        new PersistenceSqlError({
          operation: "WorkspaceScriptService.test.recoveryRead",
          detail: "temporary read failure",
        }),
      );
      afterSuccessfulKills.push(() => Deferred.succeed(recovered, undefined).pipe(Effect.asVoid));
      setStopRecoveryWait((retryAtUnixMs) => Effect.sync(() => setNow(retryAtUnixMs)));

      const restarted = yield* restartService();
      yield* drainBackgroundFibers();
      assert.isTrue(Option.isSome(yield* Deferred.poll(recovered)));
      const stopped = Option.getOrThrow(yield* restarted.get(started.workspaceScriptRunId));

      assert.equal(stopped.status, "stopped");
      assert.equal(kills.length, 2);
      assert.equal(stopRecoveryWaits.length, 1);
    }),
  );

  it.effect("stop intent 恢复首次 claim 失败时在同一服务生命周期重试", () =>
    Effect.gen(function* () {
      const {
        service,
        restartService,
        kills,
        killFailures,
        afterSuccessfulKills,
        stopClaimFailures,
        stopRecoveryWaits,
        setNow,
        setStopRecoveryWait,
      } = yield* makeFixture();
      const recovered = yield* Deferred.make<void>();
      const started = yield* service.start({
        ...startRequest,
        operationId: "operation-stop-recovery-claim-failure",
      });
      killFailures.push(new Error("initial termination failed"));
      yield* service
        .stop({
          workspaceScriptRunId: started.workspaceScriptRunId,
          operationId: "stop-operation-recovery-claim-failure",
          expectedRevision: started.revision,
        })
        .pipe(Effect.flip);
      stopClaimFailures.push(
        new PersistenceSqlError({
          operation: "WorkspaceScriptService.test.recoveryClaim",
          detail: "temporary claim failure",
        }),
      );
      afterSuccessfulKills.push(() => Deferred.succeed(recovered, undefined).pipe(Effect.asVoid));
      setStopRecoveryWait((retryAtUnixMs) => Effect.sync(() => setNow(retryAtUnixMs)));

      const restarted = yield* restartService();
      yield* drainBackgroundFibers();
      assert.isTrue(Option.isSome(yield* Deferred.poll(recovered)));
      const stopped = Option.getOrThrow(yield* restarted.get(started.workspaceScriptRunId));

      assert.equal(stopped.status, "stopped");
      assert.equal(kills.length, 2);
      assert.equal(stopRecoveryWaits.length, 1);
    }),
  );

  it.effect("delayed recovery 读取失败时保持 retryable 并继续安排下一次 backoff", () =>
    Effect.gen(function* () {
      const {
        service,
        restartService,
        store,
        kills,
        afterSuccessfulKills,
        activeRunFailures,
        stopRecoveryWaits,
        setNow,
        setStopRecoveryWait,
      } = yield* makeFixture();
      const recovered = yield* Deferred.make<void>();
      const started = yield* service.start({
        ...startRequest,
        operationId: "operation-stop-delayed-read-failure",
      });
      const stopOperationId = "stop-operation-delayed-read-failure";
      setNow(2_000);
      const claimed = yield* store.claimStop({
        run: {
          ...started,
          status: "stopping",
          revision: started.revision + 1,
          updatedAtUnixMs: 2_000,
        },
        operationId: stopOperationId,
        expectedRevision: started.revision,
        claimOwnerId: "delayed-recovery-owner",
        claimedAtUnixMs: 2_000,
        claimExpiresAtUnixMs: 32_000,
      });
      activeRunFailures.push(
        undefined,
        new PersistenceSqlError({
          operation: "WorkspaceScriptService.test.delayedRecoveryRead",
          detail: "temporary delayed read failure",
        }),
      );
      afterSuccessfulKills.push(() => Deferred.succeed(recovered, undefined).pipe(Effect.asVoid));
      setStopRecoveryWait((retryAtUnixMs) => Effect.sync(() => setNow(retryAtUnixMs)));

      const restarted = yield* restartService();
      yield* drainBackgroundFibers();
      assert.isTrue(Option.isSome(yield* Deferred.poll(recovered)));
      const stopped = Option.getOrThrow(yield* restarted.get(started.workspaceScriptRunId));

      assert.isTrue(claimed.claimed);
      assert.equal(stopped.status, "stopped");
      assert.equal(kills.length, 1);
      assert.equal(stopRecoveryWaits.length, 2);
    }),
  );

  it.effect("kill 报错后的迟到 exit 按已持久化 stop operation 收口", () =>
    Effect.gen(function* () {
      const { service, emit, killFailures } = yield* makeFixture();
      const started = yield* service.start({
        ...startRequest,
        operationId: "operation-stop-late-exit",
      });
      killFailures.push(new Error("kill response lost"));
      yield* service
        .stop({
          workspaceScriptRunId: started.workspaceScriptRunId,
          operationId: "stop-operation-late-exit",
          expectedRevision: started.revision,
        })
        .pipe(Effect.flip);

      yield* emit({
        type: "exited",
        threadId: started.threadId,
        terminalId: started.terminalId,
        sequence: 3,
        exitCode: null,
        exitSignal: 15,
      });

      const settled = Option.getOrThrow(yield* service.get(started.workspaceScriptRunId));
      assert.equal(settled.status, "stopped");
      assert.equal(settled.exitSignal, 15);
      assert.isNull(settled.errorCode);
    }),
  );

  it.effect("running stop intent 不会被迟到 error 事件覆盖为普通失败", () =>
    Effect.gen(function* () {
      const { service, emit, killFailures } = yield* makeFixture();
      const started = yield* service.start({
        ...startRequest,
        operationId: "operation-stop-late-error",
      });
      killFailures.push(new Error("kill outcome unknown"));
      yield* service
        .stop({
          workspaceScriptRunId: started.workspaceScriptRunId,
          operationId: "stop-operation-late-error",
          expectedRevision: started.revision,
        })
        .pipe(Effect.flip);

      yield* emit({
        type: "error",
        threadId: started.threadId,
        terminalId: started.terminalId,
        sequence: 3,
        message: "late terminal error",
      });

      const preserved = Option.getOrThrow(yield* service.get(started.workspaceScriptRunId));
      assert.equal(preserved.status, "running");
      assert.isNull(preserved.errorCode);
      assert.isNull(preserved.errorDetail);
    }),
  );

  it.effect("list 按项目、线程和状态筛选稳定投影", () =>
    Effect.gen(function* () {
      const { service } = yield* makeFixture();
      const run = yield* service.start(startRequest);
      const listed: ReadonlyArray<WorkspaceScriptRun> = yield* service.list({
        projectId: "project-1",
        threadId: "thread-1",
        statuses: ["running"],
      });

      assert.deepEqual(
        listed.map((item) => item.workspaceScriptRunId),
        [run.workspaceScriptRunId],
      );
      assert.deepEqual(yield* service.list({ statuses: ["failed"] }), []);
    }),
  );

  it.effect("日志快照只使用持久化 Run 绑定的线程和终端", () =>
    Effect.gen(function* () {
      const { service, histories, historyRequests } = yield* makeFixture();
      const run = yield* service.start(startRequest);
      histories.set(`${run.threadId}\u0000${run.terminalId}`, "server ready\n");

      assert.deepEqual(yield* service.getLogs(run.workspaceScriptRunId), {
        workspaceScriptRunId: run.workspaceScriptRunId,
        terminalId: run.terminalId,
        history: "server ready\n",
        truncated: false,
      });
      assert.deepEqual(historyRequests, [
        {
          threadId: run.threadId,
          terminalId: run.terminalId,
        },
      ]);
    }),
  );

  it.effect("日志快照按 UTF-8 字节限制为最新内容且不切断字符", () =>
    Effect.gen(function* () {
      const { service, histories } = yield* makeFixture();
      const run = yield* service.start({ ...startRequest, operationId: "operation-log-cap" });
      const history = `old\n${"界".repeat(Math.ceil(WORKSPACE_SCRIPT_LOG_MAX_BYTES / 3) + 20)}\nlatest\n`;
      histories.set(`${run.threadId}\u0000${run.terminalId}`, history);

      const result = yield* service.getLogs(run.workspaceScriptRunId);

      assert.isTrue(result.truncated);
      assert.isAtMost(Buffer.byteLength(result.history, "utf8"), WORKSPACE_SCRIPT_LOG_MAX_BYTES);
      assert.isTrue(result.history.endsWith("\nlatest\n"));
      assert.isFalse(result.history.includes("\uFFFD"));
    }),
  );

  it.effect("不存在的 Run 不读取任意终端日志", () =>
    Effect.gen(function* () {
      const { service, historyRequests } = yield* makeFixture();

      const error = yield* service.getLogs("workspace-script-run:missing").pipe(Effect.flip);

      assert.equal(error.code, "workspace_script_run_not_found");
      assert.equal(historyRequests.length, 0);
    }),
  );

  it.effect("终端历史读取失败时返回稳定错误且不泄漏本地路径", () =>
    Effect.gen(function* () {
      const { service, historyFailures } = yield* makeFixture();
      const run = yield* service.start({ ...startRequest, operationId: "operation-log-failure" });
      historyFailures.push(new Error("E:/secret/userdata/logs/terminals/private.log"));

      const error = yield* service.getLogs(run.workspaceScriptRunId).pipe(Effect.flip);

      assert.equal(error.code, "workspace_script_logs_failed");
      assert.equal(error.detail, "读取 Workspace Script 日志失败。");
      assert.isFalse(error.detail.includes("private.log"));
    }),
  );

  it.effect("新服务实例按 owner-bound receipt 恢复旧实例仍活跃的 Run", () =>
    Effect.gen(function* () {
      const { service, restartService, starts, inspectionRequests } = yield* makeFixture();
      const started = yield* service.start({ ...startRequest, operationId: "operation-restart" });

      const restarted = yield* restartService();
      const recovered = Option.getOrThrow(yield* restarted.get(started.workspaceScriptRunId));

      assert.equal(recovered.status, "running");
      assert.isNull(recovered.errorCode);
      assert.equal(starts.length, 1);
      assert.deepEqual(inspectionRequests.at(-1)?.expectedOwner, starts[0]?.owner);
      assert.deepEqual(
        (yield* restarted.list({ statuses: ["running"] })).map((run) => run.workspaceScriptRunId),
        [started.workspaceScriptRunId],
      );
    }),
  );

  it.effect("停止 operation 跨服务实例重放时不会重复 kill", () =>
    Effect.gen(function* () {
      const { service, restartService, kills } = yield* makeFixture();
      const started = yield* service.start({
        ...startRequest,
        operationId: "operation-stop-replay",
      });
      const stopped = yield* service.stop({
        workspaceScriptRunId: started.workspaceScriptRunId,
        operationId: "stop-operation-replay",
        expectedRevision: started.revision,
      });

      const restarted = yield* restartService();
      const repeated = yield* restarted.stop({
        workspaceScriptRunId: started.workspaceScriptRunId,
        operationId: "stop-operation-replay",
        expectedRevision: started.revision,
      });

      assert.equal(kills.length, 1);
      assert.equal(repeated.status, "stopped");
      assert.equal(repeated.revision, stopped.revision);
    }),
  );
});
