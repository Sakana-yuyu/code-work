import type {
  OrchestrationProjectShell,
  TerminalEvent,
  TerminalSessionSnapshot,
  WorkspaceScriptRun,
} from "@codework/contracts";
import { ProjectId } from "@codework/contracts";
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
  let nowUnixMs = 1_000;

  const emit = (event: TerminalEvent) =>
    Effect.forEach([...listeners], (listener) => listener(event), { discard: true });

  const terminal: WorkspaceScriptTerminalPort = {
    runCommand: (input) =>
      Effect.sync(() => {
        starts.push(input);
        return snapshot({ ...input, worktreePath: input.worktreePath ?? null });
      }),
    kill: (input) =>
      Effect.gen(function* () {
        kills.push(input);
        yield* emit({
          type: "exited",
          ...input,
          sequence: 2,
          exitCode: null,
          exitSignal: 15,
        });
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
    return { service, starts, kills, emit, restartService: makeService };
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
