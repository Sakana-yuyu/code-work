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

class CursorAdapter extends Context.Service<CursorAdapter, CursorAdapterShape>()(
  "codework/composition/CompositionProviderAgentDriver.e2e.test/CursorAdapter",
) {}

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");
const decodeCursorSettings = Schema.decodeSync(CursorSettings);

const makeMockAgentWrapper = async (extraEnv: Record<string, string>): Promise<string> => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "composition-provider-e2e-"));
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
    it.effect("取消终态早于 Provider startTask 返回时仍收口到原 Composition Run", () =>
      Effect.gen(function* () {
        const adapter = yield* CursorAdapter;
        const settings = yield* ServerSettingsService;
        const store = yield* CompositionTaskStore;
        const threadId = "composition-provider-cancel-e2e";
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
          runtimeTaskId: started.runtimeTaskId,
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
        yield* adapter.stopSession(task.threadId!).pipe(Effect.ignore);
      }),
    );
  },
);
