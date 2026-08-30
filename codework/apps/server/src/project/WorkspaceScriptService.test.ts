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
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
  const beforeStartReturns: Array<
    (input: Parameters<WorkspaceScriptTerminalPort["runCommand"]>[0]) => Effect.Effect<void>
  > = [];
  const afterStartClaims: Array<() => Effect.Effect<void>> = [];
  const kills: Array<Parameters<WorkspaceScriptTerminalPort["kill"]>[0]> = [];
  const afterInspectionReceipts: Array<() => Effect.Effect<void>> = [];
  const inspectionRequests: Array<
    Parameters<WorkspaceScriptTerminalPort["inspectSessionReceipt"]>[0]
  > = [];
  const sessionSnapshots = new Map<string, TerminalSessionSnapshot>();
  const sessionOwners = new Map<string, TerminalSessionOwner | null>();
  const historyRequests: Array<{ threadId: string; terminalId: string }> = [];
  const histories = new Map<string, string>();
  const historyFailures: unknown[] = [];
  const killFailures: unknown[] = [];
  const getRunFailures: Array<WorkspaceScriptStoreError | undefined> = [];
  let nowUnixMs = 1_000;

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
      ...snapshot({ threadId: input.threadId, terminalId: input.terminalId, cwd: input.cwd }),
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
        const created = snapshot({ ...input, worktreePath: input.worktreePath ?? null });
        sessionSnapshots.set(sessionKey, created);
        sessionOwners.set(sessionKey, input.owner);
        const beforeReturn = beforeStartReturns.shift();
        if (beforeReturn !== undefined) yield* beforeReturn(input);
        return created;
      }),
    kill: (input) =>
      Effect.gen(function* () {
        kills.push(input);
        const failure = killFailures.shift();
        if (failure !== undefined) {
          return yield* new WorkspaceScriptDependencyError({
            operation: "killTerminal",
            cause: failure,
          });
        }
        yield* emit({
          type: "exited",
          ...input,
          sequence: 2,
          exitCode: null,
          exitSignal: 15,
        });
      }),
    inspectSessionReceipt: (input) =>
      Effect.gen(function* () {
        inspectionRequests.push(input);
        const sessionKey = `${input.threadId}\u0000${input.terminalId}`;
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
        const receipt = {
          inspection:
            currentSnapshot === null
              ? ("missing" as const)
              : currentSnapshot.status === "running" && currentSnapshot.pid !== null
                ? ("active" as const)
                : ("inactive" as const),
          snapshot: currentSnapshot,
        };
        const afterReceipt = afterInspectionReceipts.shift();
        if (afterReceipt !== undefined) yield* afterReceipt();
        return receipt;
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
      getRun: (workspaceScriptRunId) => {
        const failure = getRunFailures.shift();
        return failure === undefined ? store.getRun(workspaceScriptRunId) : Effect.fail(failure);
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
            Effect.succeed(projectId === PROJECT.id ? Option.some(PROJECT) : Option.none()),
          resolveThreadProjectId: (threadId) =>
            Effect.succeed(threadId === "thread-1" ? Option.some(PROJECT.id) : Option.none()),
          platform: "win32",
          windowsComSpec: "C:/Windows/System32/cmd.exe",
          now: () => nowUnixMs++,
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
      beforeStartReturns,
      afterStartClaims,
      kills,
      afterInspectionReceipts,
      inspectionRequests,
      histories,
      historyFailures,
      killFailures,
      getRunFailures,
      historyRequests,
      emit,
      seedTerminalSession,
      readTerminalSession,
      readTerminalOwner,
      store,
      restartService,
    };
  });
};

const startRequest = {
  operationId: "operation-1",
  projectId: "project-1",
  threadId: "thread-1",
  scriptId: "serve",
};

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
      const {
        service,
        restartService,
        starts,
        inspectionRequests,
        afterStartClaims,
        getRunFailures,
      } = yield* makeFixture();
      const operationId = "operation-start-post-spawn-store-failure";
      const workspaceScriptRunId = `workspace-script-run:${operationId}`;
      afterStartClaims.push(() =>
        Effect.sync(() => {
          getRunFailures.push(
            new PersistenceSqlError({
              operation: "WorkspaceScriptService.test.postSpawnRead",
              detail: "temporary read failure",
            }),
          );
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

  it.effect("恢复候选被 foreign owner 占用时 fail-closed 且不终止外来会话", () =>
    Effect.gen(function* () {
      const { service, restartService, starts, kills, seedTerminalSession, readTerminalOwner } =
        yield* makeFixture();
      const operationId = "operation-recovery-foreign-owner";
      const started = yield* service.start({ ...startRequest, operationId });
      const foreignOwner = makeWorkspaceScriptTerminalOwner({
        workspaceScriptRunId: "workspace-script-run:foreign",
        generation: 9_999,
      });
      seedTerminalSession({
        threadId: started.threadId,
        terminalId: started.terminalId,
        cwd: started.cwd,
        owner: foreignOwner,
        snapshot: { pid: 9_912 },
      });

      const restarted = yield* restartService();
      const recovered = Option.getOrThrow(yield* restarted.get(started.workspaceScriptRunId));

      assert.equal(recovered.status, "failed");
      assert.equal(recovered.errorCode, "workspace_script_start_failed");
      assert.equal(starts.length, 1);
      assert.equal(kills.length, 0);
      assert.deepEqual(readTerminalOwner(started.threadId, started.terminalId), foreignOwner);
    }),
  );

  it.effect("恢复 inspection 后并发 stop claim 获胜时不覆盖 stopping 状态", () =>
    Effect.gen(function* () {
      const { service, restartService, store, afterInspectionReceipts } = yield* makeFixture();
      const started = yield* service.start({
        ...startRequest,
        operationId: "operation-recovery-stop-winner",
      });
      afterInspectionReceipts.push(() =>
        store
          .claimStop({
            run: {
              ...started,
              status: "stopping",
              revision: started.revision + 1,
              updatedAtUnixMs: started.updatedAtUnixMs + 1,
            },
            operationId: "stop-operation-recovery-winner",
            expectedRevision: started.revision,
          })
          .pipe(Effect.orDie, Effect.asVoid),
      );

      const restarted = yield* restartService();
      const winner = Option.getOrThrow(yield* restarted.get(started.workspaceScriptRunId));

      assert.equal(winner.status, "stopping");
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

  it.effect("stop claim 持久化后服务崩溃，相同 operationId 可恢复执行", () =>
    Effect.gen(function* () {
      const { service, restartService, store, starts, kills } = yield* makeFixture();
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
      });

      const restarted = yield* restartService();
      const recovered = Option.getOrThrow(yield* restarted.get(started.workspaceScriptRunId));
      const stopped = yield* restarted.stop({
        workspaceScriptRunId: started.workspaceScriptRunId,
        operationId: "stop-operation-crash",
        expectedRevision: started.revision,
      });

      assert.isTrue(claimed.claimed);
      assert.equal(recovered.status, "running");
      assert.equal(kills.length, 1);
      assert.deepEqual(kills[0]?.expectedOwner, starts[0]?.owner);
      assert.equal(stopped.status, "stopped");
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

  it.effect("新服务实例按 owner-bound inspection 恢复旧实例仍活跃的 Run", () =>
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
