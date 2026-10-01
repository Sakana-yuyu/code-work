// @effect-diagnostics nodeBuiltinImport:off - 本测试启动真实本地 ACP mock 子进程。

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CursorSettings,
  ProviderInstanceId,
  RuntimeTaskId,
  ThreadId,
  type CompositionTask,
  type CompositionTaskRun,
  type ProviderRuntimeEvent,
} from "@codework/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { CursorAdapterShape } from "../provider/Services/CursorAdapter.ts";
import { makeCursorAdapter } from "../provider/Layers/CursorAdapter.ts";
import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import { makeCompositionProviderAgentDriver } from "./CompositionProviderAgentDriver.ts";
import { projectCompositionRuntimeEvent } from "./CompositionTaskRuntimeProjector.ts";

import { makeCompositionOrchestrator } from "./CompositionOrchestrator.ts";
import { makeCompositionRuntimeToolBridge } from "./CompositionRuntimeToolBridge.ts";
import { makeCompositionCapabilityRegistry } from "./CapabilityRegistry.ts";
import { makeCapabilityGrantRegistry } from "./CapabilityGrantRegistry.ts";
import type { ToolBrokerInput } from "./ToolBroker.ts";

class CursorAdapter extends Context.Service<CursorAdapter, CursorAdapterShape>()(
  "codework/composition/CompositionProviderAgentDriver.e2e.test/CursorAdapter",
) {}

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");
const decodeCursorSettings = Schema.decodeSync(CursorSettings);
const decodeTerminalFixtureLog = Schema.decodeUnknownSync(
  Schema.Struct({
    method: Schema.String,
    result: Schema.Struct({
      exitCode: Schema.optionalKey(Schema.NullOr(Schema.Number)),
      exitStatus: Schema.optionalKey(
        Schema.Struct({
          exitCode: Schema.optionalKey(Schema.NullOr(Schema.Number)),
        }),
      ),
    }),
  }),
);

const makeMockAgentWrapper = async (extraEnv: Record<string, string>): Promise<string> => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "composition-provider-e2e-"));
  // oxlint-disable-next-line codework/no-global-process-runtime -- wrapper generation must follow the real host shell.
  const isWindows = process.platform === "win32";
  const wrapperPath = NodePath.join(dir, isWindows ? "mock-agent.cmd" : "mock-agent.sh");
  const script = isWindows
    ? `@echo off
${Object.entries(extraEnv)
  .map(([key, value]) => `set "${key}=${value.replaceAll('"', '""')}"`)
  .join("\n")}
"${process.execPath}" "${mockAgentPath}" %*
exit /b %ERRORLEVEL%
`
    : `#!/bin/sh
${Object.entries(extraEnv)
  .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
  .join("\n")}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  if (!isWindows) await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
};

const CursorAdapterLayer = Layer.effect(
  CursorAdapter,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    return yield* makeCursorAdapter(decodeCursorSettings({}), {
      resolveSettings: settings.getSettings.pipe(
        Effect.map((snapshot) => snapshot.providers.cursor),
        Effect.orDie,
      ),
    });
  }),
).pipe(
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "codework-composition-provider-e2e-" }),
  ),
  Layer.provide(NodeServices.layer),
);

const TestLayer = Layer.mergeAll(
  CursorAdapterLayer,
  CompositionTaskStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(TestLayer, { excludeTestServices: true })(
  "Composition Provider Driver 本地 ACP 跨进程 E2E",
  (it) => {
    it.effect("宿主终端取消先停止进程，再发布会撤销Run权限的ACP终态", () =>
      Effect.gen(function* () {
        for (const variant of ["cancel", "kill", "stop-failed"] as const) {
          const adapter = yield* CursorAdapter;
          const settings = yield* ServerSettingsService;
          const store = yield* CompositionTaskStore;
          const workspaceRoot = yield* Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "composition-terminal-cancel-")),
          );
          const resultLogPath = NodePath.join(workspaceRoot, "terminal-results.ndjson");
          const wrapperPath = yield* Effect.promise(() =>
            makeMockAgentWrapper({
              CODEWORK_ACP_TERMINAL_COMMAND: "controlled-running-command",
              CODEWORK_ACP_TERMINAL_CWD: workspaceRoot,
              ...(variant !== "kill"
                ? { CODEWORK_ACP_TERMINAL_HANG_AFTER_CREATE: "1" }
                : { CODEWORK_ACP_TERMINAL_KILL_BEFORE_WAIT: "1" }),
              CODEWORK_ACP_CLIENT_TOOL_RESULT_LOG_PATH: resultLogPath,
            }),
          );
          yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });
          const threadId = ThreadId.make("composition-terminal-" + variant),
            taskId = "task-terminal-" + variant,
            runId = "run-terminal-" + variant;
          const agentId = "provider:cursor",
            registry = makeCompositionAgentDriverRegistry();
          const grantRegistry = makeCapabilityGrantRegistry({
            capabilityRegistry: makeCompositionCapabilityRegistry(),
          });
          const completed = yield* Deferred.make<void>();
          const stopAttempted = yield* Deferred.make<void>();
          const invocations: ToolBrokerInput[] = [];
          const releasedRuns: string[] = [];
          const runtimeBridge = makeCompositionRuntimeToolBridge({
            taskStore: store,
            terminalManager: {
              close: ({ threadId: releasedRunId }) =>
                Effect.gen(function* () {
                  assert.equal(releasedRunId, runId);
                  assert.notEqual(
                    Option.getOrThrow(yield* store.getRun(runId).pipe(Effect.orDie)).status,
                    "running",
                  );
                  releasedRuns.push(releasedRunId);
                }),
            },
            inputStore: {
              get: () => Effect.succeed(Option.some({ taskId, prompt: "取消终端", workspaceRoot })),
            },
            toolBroker: {
              invoke: (input) =>
                Effect.gen(function* () {
                  invocations.push(input);
                  if (input.canonicalToolName === "terminal.kill") {
                    // 原门禁已允许执行后，取消终态尚未落库；执行替身仅确认调用顺序。
                    assert.equal(
                      Option.getOrThrow(yield* store.getRun(runId).pipe(Effect.orDie)).status,
                      "running",
                    );
                    yield* Deferred.succeed(stopAttempted, undefined);
                  }
                  if (variant === "stop-failed" && input.canonicalToolName === "terminal.kill") {
                    return {
                      invocationId: input.toolCallId,
                      taskId,
                      runId,
                      toolCallId: input.toolCallId,
                      canonicalToolName: input.canonicalToolName,
                      idempotencyKey: input.idempotencyKey,
                      status: "failed" as const,
                      errorCode: "controlled_terminal_stop_failed",
                    };
                  }
                  return {
                    invocationId: input.toolCallId,
                    taskId,
                    runId,
                    toolCallId: input.toolCallId,
                    canonicalToolName: input.canonicalToolName,
                    idempotencyKey: input.idempotencyKey,
                    status: "succeeded" as const,
                    result:
                      input.canonicalToolName === "terminal.exec"
                        ? { status: "running" }
                        : input.canonicalToolName === "terminal.snapshot"
                          ? {
                              status: "exited",
                              history: "native-stop-output",
                              exitCode: -1,
                              exitSignal: null,
                            }
                          : {},
                  };
                }),
              cancel: () =>
                Effect.succeed({
                  invocationId: "unused",
                  taskId,
                  runId,
                  toolCallId: "unused",
                  canonicalToolName: "terminal.exec",
                  idempotencyKey: "unused",
                  status: "cancelled" as const,
                }),
            },
          });
          const driver = makeCompositionProviderAgentDriver({
            agentId,
            runtimeId: agentId,
            providerInstanceId: ProviderInstanceId.make("cursor"),
            providerKind: "cursor",
            adapter,
            toolBrokerBridge: runtimeBridge,
          });
          yield* registry.register(driver);
          const orchestrator = makeCompositionOrchestrator(store, registry, grantRegistry);
          const projector = yield* Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.gen(function* () {
              if (event.threadId !== threadId) return;
              yield* projectCompositionRuntimeEvent(store, registry, event, grantRegistry);
              if (event.type === "turn.completed") yield* Deferred.succeed(completed, undefined);
            }),
          ).pipe(Effect.forkChild);
          const abortWatch = new AbortController();
          yield* Effect.addFinalizer(() => Effect.sync(() => abortWatch.abort()));
          // 等待实际ACP create回复的文件通知，不能只等ToolBroker execute入口。
          const created = yield* Effect.promise(async () => {
            for await (const _event of NodeFSP.watch(workspaceRoot, {
              signal: abortWatch.signal,
            })) {
              const content = await NodeFSP.readFile(resultLogPath, "utf8");
              if (content.includes('"method":"terminal/create"')) return;
            }
            throw new Error("终端创建回执未收到");
          }).pipe(Effect.forkChild);
          const dispatch = yield* orchestrator
            .dispatchTask({
              taskId,
              runId,
              projectId: "project-terminal-cancel",
              threadId,
              assigneeKind: "agent",
              assigneeId: agentId,
              mode: "serial",
              promptDigest: "sha256:terminal-cancel",
              prompt: "创建终端后取消",
              workspaceRoot,
              dependsOnTaskIds: [],
              capabilityIds: ["t3.terminal.exec", "t3.terminal.kill", "t3.terminal.close"],
            })
            .pipe(Effect.forkChild);
          yield* Fiber.join(created).pipe(Effect.timeout("10 seconds"));
          if (variant !== "kill") {
            const cancellation = yield* Effect.result(
              orchestrator.cancelTask({ taskId, runId, reason: "取消宿主终端" }),
            );
            if (variant === "stop-failed") {
              assert.equal(cancellation._tag, "Failure");
              if (cancellation._tag === "Failure")
                assert.include(cancellation.failure.message, "provider_turn_cancel_failed");
            } else {
              assert.equal(cancellation._tag, "Success");
              if (cancellation._tag === "Success")
                assert.equal(cancellation.success.status, "cancelled");
            }
          }
          yield* Deferred.await(stopAttempted).pipe(Effect.timeout("5 seconds"));
          yield* Fiber.join(dispatch);
          assert.equal(
            invocations.filter((input) => input.canonicalToolName === "terminal.exec").length,
            1,
          );
          assert.equal(
            invocations.filter((input) => input.canonicalToolName === "terminal.kill").length,
            1,
          );
          assert.equal(
            Option.getOrThrow(yield* store.getRun(runId)).status,
            variant === "cancel" ? "cancelled" : variant === "kill" ? "completed" : "failed",
          );
          yield* Deferred.await(completed).pipe(Effect.timeout("5 seconds"));
          const storedRun = Option.getOrThrow(yield* store.getRun(runId));
          const storedTask = Option.getOrThrow(yield* store.getTask(taskId));
          yield* driver.revokeCapabilityHandshake!({ task: storedTask, run: storedRun });
          assert.deepEqual(releasedRuns, [runId]);
          if (variant === "kill") {
            const entries = (yield* Effect.promise(() => NodeFSP.readFile(resultLogPath, "utf8")))
              .trim()
              .split("\n")
              .map((line) => decodeTerminalFixtureLog(JSON.parse(line)));
            assert.equal(
              entries.find((entry) => entry.method === "terminal/output")?.result.exitStatus
                ?.exitCode,
              null,
            );
            assert.equal(
              entries.find((entry) => entry.method === "terminal/wait_for_exit")?.result.exitCode,
              null,
            );
            assert.equal(entries.filter((entry) => entry.method === "terminal/release").length, 1);
          }
          yield* Fiber.interrupt(projector);
        }
      }),
    );

    it.effect("取消终态早于 Provider startTask 返回时仍收口到原 Composition Run", () =>
      Effect.gen(function* () {
        const adapter = yield* CursorAdapter;
        const settings = yield* ServerSettingsService;
        const store = yield* CompositionTaskStore;
        const threadId = ThreadId.make("composition-provider-cancel-e2e");
        const taskId = "task-provider-cancel-e2e";
        const runId = "run-provider-cancel-e2e";
        const runtimeId = "provider:cursor-acp-cancel-e2e";
        const providerInstanceId = ProviderInstanceId.make("cursor");
        const releaseStartTask = yield* Deferred.make<void>();
        const wrapperPath = yield* Effect.promise(() =>
          makeMockAgentWrapper({ CODEWORK_ACP_HANG_PROMPT_FOREVER: "1" }),
        );
        yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

        const driver = makeCompositionProviderAgentDriver({
          agentId: "provider:cursor-acp-cancel-e2e",
          runtimeId,
          providerInstanceId,
          providerKind: "cursor",
          adapter: {
            startSession: adapter.startSession,
            // ACP 已返回 turnId 后仍暂停，确保终态投影发生在 Driver 写入 binding 之前。
            sendTurn: (input) =>
              adapter.sendTurn(input).pipe(Effect.tap(() => Deferred.await(releaseStartTask))),
            interruptTurn: (requestedThreadId) => adapter.interruptTurn(requestedThreadId),
            stopSession: adapter.stopSession,
          },
        });
        const registry = makeCompositionAgentDriverRegistry();
        yield* registry.register(driver);

        const task: CompositionTask = {
          taskId,
          projectId: "project-provider-cancel-e2e",
          threadId,
          assigneeKind: "agent",
          assigneeId: driver.agentId,
          mode: "serial",
          status: "running",
          promptDigest: "sha256:provider-cancel-e2e",
          dependsOnTaskIds: [],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
        };
        const run: CompositionTaskRun = {
          runId,
          taskId,
          agentId: driver.agentId,
          runtimeId,
          status: "running",
          attempt: 1,
          capabilityGrantIds: [],
          startedAtUnixMs: 2,
        };
        yield* store.upsertTask(task);
        yield* store.upsertRun(run);

        const turnStarted = yield* Deferred.make<void>();
        const cancelledCompletion = yield* Deferred.make<ProviderRuntimeEvent>();
        const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.gen(function* () {
            if (String(event.threadId) !== threadId) return;
            if (event.type === "turn.started") {
              yield* projectCompositionRuntimeEvent(store, registry, event);
              yield* Deferred.succeed(turnStarted, undefined).pipe(Effect.ignore);
              return;
            }
            if (event.type === "turn.completed" && event.payload.state === "cancelled") {
              yield* Deferred.succeed(cancelledCompletion, event).pipe(Effect.ignore);
            }
          }),
        ).pipe(Effect.forkChild);

        const startFiber = yield* driver
          .startTask({
            task,
            run,
            prompt: "等待取消的 ACP Composition 任务",
            workspaceRoot: process.cwd(),
          })
          .pipe(Effect.forkChild);

        yield* Deferred.await(turnStarted);
        assert.deepStrictEqual(
          yield* driver.cancelTask({
            task,
            run: { ...run, status: "running" },
            reason: "E2E 取消",
          }),
          { status: "cancelled" },
        );
        const completion = yield* Deferred.await(cancelledCompletion);

        // ACP 会在 sendTurn 返回 turnId 前发布终态；生产订阅必须在这里就能归属事件。
        yield* projectCompositionRuntimeEvent(store, registry, completion);
        assert.equal(Option.getOrThrow(yield* store.getTask(taskId)).status, "cancelled");
        assert.equal(Option.getOrThrow(yield* store.getRun(runId)).status, "cancelled");

        yield* Deferred.succeed(releaseStartTask, undefined);
        const started = yield* Fiber.join(startFiber);

        assert.equal(
          Option.getOrThrow(yield* store.getRun(runId)).runtimeTaskId,
          started.runtimeTaskId,
        );
        assert.deepStrictEqual(driver.resolveRuntimeEvent?.(completion), {
          taskId,
          runId,
          runtimeTaskId: started.runtimeTaskId as RuntimeTaskId,
        });

        assert.equal(Option.getOrThrow(yield* store.getTask(taskId)).status, "cancelled");
        assert.equal(Option.getOrThrow(yield* store.getRun(runId)).status, "cancelled");
        assert.deepStrictEqual(
          (yield* store.listEvents(taskId, runId)).map((event) => [event.status, event.eventType]),
          [
            ["running", "status"],
            ["cancelled", "status"],
          ],
        );

        yield* Fiber.interrupt(runtimeEventsFiber);
        yield* adapter.stopSession(ThreadId.make(task.threadId!)).pipe(Effect.ignore);
      }),
    );

    it.effect("新 Provider Driver 能投影真实 ACP 子进程的已持久化终态事件", () =>
      Effect.gen(function* () {
        const adapter = yield* CursorAdapter;
        const settings = yield* ServerSettingsService;
        const store = yield* CompositionTaskStore;
        const threadId = ThreadId.make("composition-provider-restart-e2e");
        const taskId = "task-provider-restart-e2e";
        const runId = "run-provider-restart-e2e";
        const runtimeId = "provider:cursor-acp-restart-e2e";
        const providerInstanceId = ProviderInstanceId.make("cursor");
        const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper({}));
        yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

        const driver = makeCompositionProviderAgentDriver({
          agentId: runtimeId,
          runtimeId,
          providerInstanceId,
          providerKind: "cursor",
          adapter: {
            startSession: adapter.startSession,
            sendTurn: adapter.sendTurn,
            interruptTurn: (requestedThreadId) => adapter.interruptTurn(requestedThreadId),
            stopSession: adapter.stopSession,
          },
        });
        const task: CompositionTask = {
          taskId,
          projectId: "project-provider-restart-e2e",
          threadId,
          assigneeKind: "agent",
          assigneeId: driver.agentId,
          mode: "serial",
          status: "running",
          promptDigest: "sha256:provider-restart-e2e",
          dependsOnTaskIds: [],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
        };
        const run: CompositionTaskRun = {
          runId,
          taskId,
          agentId: driver.agentId,
          runtimeId,
          status: "running",
          attempt: 1,
          capabilityGrantIds: [],
          startedAtUnixMs: 2,
        };
        yield* store.upsertTask(task);
        yield* store.upsertRun(run);

        const completed = yield* Deferred.make<ProviderRuntimeEvent>();
        const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          String(event.threadId) === threadId && event.type === "turn.completed"
            ? Deferred.succeed(completed, event).pipe(Effect.ignore)
            : Effect.void,
        ).pipe(Effect.forkChild);
        const started = yield* driver.startTask({
          task,
          run,
          prompt: "完成后模拟 Composition 进程重启",
          workspaceRoot: process.cwd(),
        });
        const completion = yield* Deferred.await(completed);
        yield* store.upsertRun({ ...run, runtimeTaskId: started.runtimeTaskId });
        assert.equal(String(completion.providerInstanceId), String(providerInstanceId));
        assert.equal(
          started.runtimeTaskId,
          `${runtimeId}:${completion.threadId}:${completion.turnId}`,
        );

        // 仅保留持久化 Run，使用新的 Driver/Registry 模拟 Composition 进程重启。
        const restartedRegistry = makeCompositionAgentDriverRegistry();
        yield* restartedRegistry.register(
          makeCompositionProviderAgentDriver({
            agentId: runtimeId,
            runtimeId,
            providerInstanceId,
            adapter: {} as never,
          }),
        );
        yield* projectCompositionRuntimeEvent(store, restartedRegistry, completion);

        assert.equal(Option.getOrThrow(yield* store.getTask(taskId)).status, "completed");
        assert.equal(Option.getOrThrow(yield* store.getRun(runId)).status, "completed");
        assert.deepStrictEqual(
          (yield* store.listEvents(taskId, runId)).map((event) => [event.status, event.eventType]),
          [["completed", "status"]],
        );

        yield* Fiber.interrupt(runtimeEventsFiber);
        yield* adapter.stopSession(threadId).pipe(Effect.ignore);
      }),
    );
  },
);
