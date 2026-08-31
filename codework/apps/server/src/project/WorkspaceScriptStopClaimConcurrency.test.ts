// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  type OrchestrationProjectShell,
  type TerminalSessionSnapshot,
  type WorkspaceScriptRun,
} from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { WorkspaceScriptStoreLive } from "../persistence/Layers/WorkspaceScriptStore.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import {
  WorkspaceScriptStore,
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
} from "./WorkspaceScriptService.ts";

const PROJECT: OrchestrationProjectShell = {
  id: ProjectId.make("project-stop-fence"),
  title: "Stop Fence",
  workspaceRoot: "E:/workspace/stop-fence",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [
    {
      id: "serve",
      name: "启动服务",
      command: "pnpm dev",
      icon: "play",
      runOnWorktreeCreate: false,
    },
  ],
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
};

const makeFileStoreLayer = (dbPath: string) =>
  WorkspaceScriptStoreLive.pipe(
    Layer.provideMerge(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
  );

const buildStore = Effect.fn("WorkspaceScriptStopClaimConcurrency.buildStore")(function* (
  dbPath: string,
) {
  const context = yield* Layer.build(makeFileStoreLayer(dbPath));
  return Context.get(context, WorkspaceScriptStore);
});

const sessionKey = (threadId: string, terminalId: string): string =>
  `${threadId}\u0000${terminalId}`;

const makeTerminalHarness = () => {
  const snapshots = new Map<string, TerminalSessionSnapshot>();
  const owners = new Map<string, TerminalSessionOwner>();
  const kills: Array<Parameters<WorkspaceScriptTerminalPort["kill"]>[0]> = [];
  const killGates: Array<{
    readonly started: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  }> = [];

  const ownerMismatch = (operation: "killTerminal" | "inspectTerminal") =>
    new WorkspaceScriptDependencyError({ operation, cause: new Error("terminal owner mismatch") });

  const terminal: WorkspaceScriptTerminalPort = {
    runCommand: (input) =>
      Effect.sync(() => {
        const snapshot: TerminalSessionSnapshot = {
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          worktreePath: input.worktreePath ?? null,
          status: "running",
          pid: 4300,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: input.command,
          updatedAt: "2026-08-30T00:00:01.000Z",
          sequence: 1,
        };
        const key = sessionKey(input.threadId, input.terminalId);
        snapshots.set(key, snapshot);
        owners.set(key, input.owner);
        return snapshot;
      }),
    kill: (input) =>
      Effect.gen(function* () {
        kills.push(input);
        const gate = killGates.shift();
        if (gate !== undefined) {
          yield* Deferred.succeed(gate.started, undefined);
          yield* Deferred.await(gate.release);
        }
        const key = sessionKey(input.threadId, input.terminalId);
        if (!terminalSessionOwnerEquals(owners.get(key) ?? null, input.expectedOwner)) {
          return yield* ownerMismatch("killTerminal");
        }
        const current = snapshots.get(key);
        if (current === undefined) {
          return yield* new WorkspaceScriptDependencyError({
            operation: "killTerminal",
            cause: new Error("terminal missing"),
          });
        }
        snapshots.set(key, {
          ...current,
          status: "exited",
          pid: null,
          exitCode: null,
          exitSignal: 15,
          sequence: (current.sequence ?? 0) + 1,
        });
      }),
    inspectSessionReceipt: (input) =>
      Effect.gen(function* () {
        const key = sessionKey(input.threadId, input.terminalId);
        const current = snapshots.get(key) ?? null;
        if (
          current !== null &&
          !terminalSessionOwnerEquals(owners.get(key) ?? null, input.expectedOwner)
        ) {
          return yield* ownerMismatch("inspectTerminal");
        }
        return current === null
          ? { inspection: "missing" as const, snapshot: null }
          : {
              inspection: current.status === "exited" ? ("inactive" as const) : ("active" as const),
              snapshot: current,
            };
      }),
    getHistory: () => Effect.succeed(""),
    subscribe: () => Effect.succeed(() => undefined),
  };

  return {
    terminal,
    kills,
    blockNextKill: Effect.fn("WorkspaceScriptStopClaimConcurrency.blockNextKill")(function* () {
      const gate = {
        started: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      killGates.push(gate);
      return gate;
    }),
    seedRun: (run: WorkspaceScriptRun) =>
      Effect.sync(() => {
        const key = sessionKey(run.threadId, run.terminalId);
        snapshots.set(key, {
          threadId: run.threadId,
          terminalId: run.terminalId,
          cwd: run.cwd,
          worktreePath: run.worktreePath,
          status: "running",
          pid: 4400,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: run.scriptName,
          updatedAt: "2026-08-30T00:00:01.000Z",
          sequence: 1,
        });
        owners.set(
          key,
          makeWorkspaceScriptTerminalOwner({
            workspaceScriptRunId: run.workspaceScriptRunId,
            generation: run.requestedAtUnixMs,
          }),
        );
      }),
  };
};

const makeService = (
  store: WorkspaceScriptStoreShape,
  terminal: WorkspaceScriptTerminalPort,
  input: {
    readonly serviceId: string;
    readonly nowUnixMs: number;
    readonly waitForStopClaimExpiry: (retryAtUnixMs: number) => Effect.Effect<void>;
  },
) => {
  let claimSequence = 0;
  return makeWorkspaceScriptService({
    store,
    terminal,
    resolveProject: (projectId) =>
      Effect.succeed(projectId === PROJECT.id ? Option.some(PROJECT) : Option.none()),
    resolveThreadProjectId: (threadId) =>
      Effect.succeed(
        threadId === "thread-stop-fence" ? Option.some(String(PROJECT.id)) : Option.none(),
      ),
    platform: "win32",
    windowsComSpec: "C:/Windows/System32/cmd.exe",
    now: () => input.nowUnixMs,
    makeStopClaimOwnerId: () => `${input.serviceId}:${++claimSequence}`,
    stopClaimTtlMs: 100,
    waitForStopClaimExpiry: input.waitForStopClaimExpiry,
  });
};

const makeRunningRun = (workspaceScriptRunId: string): WorkspaceScriptRun => ({
  workspaceScriptRunId,
  idempotencyKey: `workspace-script:key:${workspaceScriptRunId}`,
  projectId: String(PROJECT.id),
  threadId: "thread-stop-fence",
  scriptId: "serve",
  scriptName: "启动服务",
  terminalId: `terminal:${workspaceScriptRunId}`,
  cwd: PROJECT.workspaceRoot,
  worktreePath: null,
  status: "running",
  healthStatus: "unknown",
  healthCheckedAtUnixMs: null,
  healthDetail: null,
  ports: [],
  revision: 2,
  requestedAtUnixMs: 1_000,
  startedAtUnixMs: 1_000,
  finishedAtUnixMs: null,
  exitCode: null,
  exitSignal: null,
  errorCode: null,
  errorDetail: null,
  compositionTaskId: null,
  compositionRunId: null,
  updatedAtUnixMs: 1_000,
});

it.effect("同文件 SQLite 上活跃停止 claim 不会被新 Service 窃取或重开", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codework-stop-claim-live-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.scoped(
    Effect.gen(function* () {
      const storeA = yield* buildStore(dbPath);
      const storeB = yield* buildStore(dbPath);
      const terminal = makeTerminalHarness();
      const waitGate = yield* Deferred.make<void>();
      const serviceA = yield* makeService(storeA, terminal.terminal, {
        serviceId: "service-a",
        nowUnixMs: 1_000,
        waitForStopClaimExpiry: () => Deferred.await(waitGate),
      });
      const started = yield* serviceA.start({
        operationId: "operation-live-claim",
        projectId: String(PROJECT.id),
        threadId: "thread-stop-fence",
        scriptId: "serve",
      });
      const killGate = yield* terminal.blockNextKill();
      const stopFiber = yield* serviceA
        .stop({
          workspaceScriptRunId: started.workspaceScriptRunId,
          operationId: "stop-live-claim",
          expectedRevision: started.revision,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(killGate.started);

      yield* makeService(storeB, terminal.terminal, {
        serviceId: "service-b",
        nowUnixMs: 1_050,
        waitForStopClaimExpiry: () => Deferred.await(waitGate),
      });
      const whileKilling = Option.getOrThrow(
        yield* storeB.getActiveRunByTerminal(started.threadId, started.terminalId),
      );
      assert.equal(whileKilling.run.status, "stopping");
      assert.equal(whileKilling.stopClaim?.ownerId, "service-a:1");
      assert.equal(whileKilling.stopClaim?.epoch, 1);
      assert.equal(terminal.kills.length, 1);

      yield* Deferred.succeed(killGate.release, undefined);
      const stopped = yield* Fiber.join(stopFiber);
      assert.equal(stopped.status, "stopped");
      assert.equal(
        Option.getOrThrow(yield* storeB.getRun(started.workspaceScriptRunId)).status,
        "stopped",
      );
      assert.equal(terminal.kills.length, 1);
    }),
  ).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("同文件 SQLite 上过期 claim 只被一个 Service 接管且旧 fence 无法覆盖", () => {
  const tempDir = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "codework-stop-claim-expired-"),
  );
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.scoped(
    Effect.gen(function* () {
      const seedStore = yield* buildStore(dbPath);
      const storeB = yield* buildStore(dbPath);
      const storeC = yield* buildStore(dbPath);
      const terminal = makeTerminalHarness();
      const retryGate = yield* Deferred.make<void>();
      const running = makeRunningRun("run-expired-stop-claim");
      yield* seedStore.claimStart(running);
      yield* terminal.seedRun(running);
      const staleClaim = yield* seedStore.claimStop({
        run: {
          ...running,
          status: "stopping",
          revision: 3,
          updatedAtUnixMs: 1_001,
        },
        operationId: "stop-expired-claim",
        expectedRevision: running.revision,
        claimOwnerId: "service-a:1",
        claimedAtUnixMs: 1_001,
        claimExpiresAtUnixMs: 1_100,
      });
      const killGate = yield* terminal.blockNextKill();
      const serviceBFiber = yield* makeService(storeB, terminal.terminal, {
        serviceId: "service-b",
        nowUnixMs: 1_200,
        waitForStopClaimExpiry: () => Deferred.await(retryGate),
      }).pipe(Effect.forkChild);
      const serviceCFiber = yield* makeService(storeC, terminal.terminal, {
        serviceId: "service-c",
        nowUnixMs: 1_200,
        waitForStopClaimExpiry: () => Deferred.await(retryGate),
      }).pipe(Effect.forkChild);
      const serviceFibers = [serviceBFiber, serviceCFiber] as const;
      const observed = yield* Effect.raceFirst(
        Deferred.await(killGate.started).pipe(Effect.as({ _tag: "KillStarted" } as const)),
        Effect.forEach(serviceFibers, Fiber.await).pipe(
          Effect.map((exits) => ({ _tag: "ServicesExited", exits }) as const),
        ),
      );
      assert.equal(
        observed._tag,
        "KillStarted",
        observed._tag === "ServicesExited"
          ? `恢复 Service 均在终止前退出：${observed.exits.map(String).join(", ")}`
          : undefined,
      );

      const winner = Option.getOrThrow(
        yield* seedStore.getActiveRunByTerminal(running.threadId, running.terminalId),
      );
      assert.equal(winner.run.status, "stopping");
      assert.equal(winner.stopClaim?.epoch, 2);
      assert.include(["service-b:1", "service-c:1"], winner.stopClaim?.ownerId);
      assert.equal(terminal.kills.length, 1);

      const staleWrite = yield* seedStore.saveStopTransition({
        expectedRevision: staleClaim.run.revision,
        operationId: "stop-expired-claim",
        claimOwnerId: "service-a:1",
        claimEpoch: 1,
        run: {
          ...staleClaim.run,
          status: "stopped",
          revision: staleClaim.run.revision + 1,
          finishedAtUnixMs: 1_200,
          exitCode: null,
          exitSignal: 15,
          updatedAtUnixMs: 1_200,
        },
      });
      assert.isTrue(Option.isNone(staleWrite));

      yield* Deferred.succeed(killGate.release, undefined);
      yield* Effect.forEach(serviceFibers, Fiber.join, { discard: true });
      const stopped = Option.getOrThrow(yield* seedStore.getRun(running.workspaceScriptRunId));
      assert.equal(stopped.status, "stopped");
      assert.equal(terminal.kills.length, 1);
    }),
  ).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
