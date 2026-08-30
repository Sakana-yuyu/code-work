import type {
  OrchestrationProjectShell,
  TerminalEvent,
  TerminalSessionSnapshot,
  WorkspaceScriptRun,
} from "@codework/contracts";
import { ProjectId, WORKSPACE_SCRIPT_LOG_MAX_BYTES } from "@codework/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { WorkspaceScriptStoreLive } from "../persistence/Layers/WorkspaceScriptStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { WorkspaceScriptStore } from "../persistence/Services/WorkspaceScriptStore.ts";
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
  const kills: Array<Parameters<WorkspaceScriptTerminalPort["kill"]>[0]> = [];
  const historyRequests: Array<{ threadId: string; terminalId: string }> = [];
  const histories = new Map<string, string>();
  const terminalInspections = new Map<string, "active" | "inactive" | "missing">();
  const historyFailures: unknown[] = [];
  const killFailures: unknown[] = [];
  const silentKills: boolean[] = [];
  let nowUnixMs = 1_000;

  const terminalKey = (threadId: string, terminalId: string) => `${threadId}\u0000${terminalId}`;

  const emit = (event: TerminalEvent) =>
    Effect.forEach([...listeners], (listener) => listener(event), { discard: true });

  const terminal: WorkspaceScriptTerminalPort = {
    runCommand: (input) =>
      Effect.sync(() => {
        starts.push(input);
        terminalInspections.set(terminalKey(input.threadId, input.terminalId), "active");
        return snapshot({ ...input, worktreePath: input.worktreePath ?? null });
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
        terminalInspections.set(terminalKey(input.threadId, input.terminalId), "inactive");
        if (silentKills.shift() === true) return;
        yield* emit({
          type: "exited",
          ...input,
          sequence: 2,
          exitCode: null,
          exitSignal: 15,
        });
      }),
    inspectSession: (input) =>
      Effect.succeed(
        terminalInspections.get(terminalKey(input.threadId, input.terminalId)) ?? "missing",
      ),
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
    const makeService = () =>
      makeWorkspaceScriptService({
        store,
        terminal,
        resolveProject: (projectId) =>
          Effect.succeed(projectId === PROJECT.id ? Option.some(PROJECT) : Option.none()),
        resolveThreadProjectId: (threadId) =>
          Effect.succeed(threadId === "thread-1" ? Option.some(PROJECT.id) : Option.none()),
        platform: "win32",
        windowsComSpec: "C:/Windows/System32/cmd.exe",
        now: () => nowUnixMs++,
      });
    const service = yield* makeService();
    return {
      service,
      starts,
      kills,
      histories,
      historyFailures,
      killFailures,
      silentKills,
      terminalInspections,
      historyRequests,
      emit,
      store,
      restartService: makeService,
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
      });
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

      assert.deepEqual(kills, [{ threadId: "thread-1", terminalId: started.terminalId }]);
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

  it.effect("starting Run 可直接停止且生成合法的 startedAt 时间", () =>
    Effect.gen(function* () {
      const { service, store, kills } = yield* makeFixture();
      const starting: WorkspaceScriptRun = {
        workspaceScriptRunId: "workspace-script-run:operation-stop-starting",
        idempotencyKey: "workspace-script:project-1:thread-1:serve:operation-stop-starting",
        projectId: "project-1",
        threadId: "thread-1",
        scriptId: "serve",
        scriptName: "启动开发服务",
        terminalId: "workspace-script-operation-stop-starting",
        cwd: "E:/workspace/project-1",
        worktreePath: null,
        status: "starting",
        healthStatus: "unknown",
        healthCheckedAtUnixMs: null,
        healthDetail: null,
        ports: [],
        revision: 1,
        requestedAtUnixMs: 1_000,
        startedAtUnixMs: null,
        finishedAtUnixMs: null,
        exitCode: null,
        exitSignal: null,
        errorCode: null,
        errorDetail: null,
        compositionTaskId: null,
        compositionRunId: null,
        updatedAtUnixMs: 1_000,
      };
      yield* store.claimStart(starting);

      const stopped = yield* service.stop({
        workspaceScriptRunId: starting.workspaceScriptRunId,
        operationId: "stop-operation-starting",
        expectedRevision: starting.revision,
      });

      assert.deepEqual(kills, [{ threadId: starting.threadId, terminalId: starting.terminalId }]);
      assert.equal(stopped.status, "stopped");
      assert.isNotNull(stopped.startedAtUnixMs);
      assert.isAtLeast(stopped.startedAtUnixMs!, starting.requestedAtUnixMs);
    }),
  );

  it.effect("kill 成功但终端不发 exited 时仍在返回前收口 stopped", () =>
    Effect.gen(function* () {
      const { service, silentKills } = yield* makeFixture();
      const started = yield* service.start({
        ...startRequest,
        operationId: "operation-stop-silent-kill",
      });
      silentKills.push(true);

      const stopped = yield* service.stop({
        workspaceScriptRunId: started.workspaceScriptRunId,
        operationId: "stop-operation-silent-kill",
        expectedRevision: started.revision,
      });
      const persisted = Option.getOrThrow(yield* service.get(started.workspaceScriptRunId));

      assert.equal(stopped.status, "stopped");
      assert.equal(persisted.status, "stopped");
      assert.isNotNull(stopped.finishedAtUnixMs);
    }),
  );

  it.effect("stop claim 持久化后服务崩溃，相同 operationId 可恢复执行", () =>
    Effect.gen(function* () {
      const { service, restartService, store, kills } = yield* makeFixture();
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
      assert.equal(stopped.status, "stopped");
    }),
  );

  it.effect("服务恢复时将已无进程的 stop claim 收口为 stopped", () =>
    Effect.gen(function* () {
      const { service, restartService, store, terminalInspections } = yield* makeFixture();
      const started = yield* service.start({
        ...startRequest,
        operationId: "operation-stop-inactive-recovery",
      });
      yield* store.claimStop({
        run: {
          ...started,
          status: "stopping",
          revision: started.revision + 1,
          updatedAtUnixMs: started.updatedAtUnixMs + 1,
        },
        operationId: "stop-operation-inactive-recovery",
        expectedRevision: started.revision,
      });
      terminalInspections.set(`${started.threadId}\u0000${started.terminalId}`, "inactive");

      const restarted = yield* restartService();
      const recovered = Option.getOrThrow(yield* restarted.get(started.workspaceScriptRunId));

      assert.equal(recovered.status, "stopped");
      assert.isNotNull(recovered.finishedAtUnixMs);
      assert.isNull(recovered.errorCode);
    }),
  );

  it.effect("服务恢复时将监督状态丢失的 stop claim 收口为明确失败", () =>
    Effect.gen(function* () {
      const { service, restartService, store, terminalInspections } = yield* makeFixture();
      const started = yield* service.start({
        ...startRequest,
        operationId: "operation-stop-missing-recovery",
      });
      yield* store.claimStop({
        run: {
          ...started,
          status: "stopping",
          revision: started.revision + 1,
          updatedAtUnixMs: started.updatedAtUnixMs + 1,
        },
        operationId: "stop-operation-missing-recovery",
        expectedRevision: started.revision,
      });
      terminalInspections.delete(`${started.threadId}\u0000${started.terminalId}`);

      const restarted = yield* restartService();
      const recovered = Option.getOrThrow(yield* restarted.get(started.workspaceScriptRunId));

      assert.equal(recovered.status, "failed");
      assert.equal(recovered.errorCode, "workspace_script_terminal_supervision_lost");
      assert.isNotNull(recovered.finishedAtUnixMs);
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

  it.effect("新服务实例从持久化 Store 读取并收口旧实例的活跃 Run", () =>
    Effect.gen(function* () {
      const { service, restartService } = yield* makeFixture();
      const started = yield* service.start({ ...startRequest, operationId: "operation-restart" });

      const restarted = yield* restartService();
      const recovered = Option.getOrThrow(yield* restarted.get(started.workspaceScriptRunId));

      assert.equal(recovered.status, "failed");
      assert.equal(recovered.errorCode, "workspace_script_server_restarted");
      assert.deepEqual(
        (yield* restarted.list({ statuses: ["failed"] })).map((run) => run.workspaceScriptRunId),
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
