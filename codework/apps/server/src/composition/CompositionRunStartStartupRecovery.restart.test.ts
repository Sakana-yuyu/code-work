import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CompositionRunStartStoreLive } from "../persistence/Layers/CompositionRunStartStore.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { CompositionTaskInputStoreLive } from "../persistence/Layers/CompositionTaskInputStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { CompositionRunStartStore } from "../persistence/Services/CompositionRunStartStore.ts";
import { CompositionTaskInputStore } from "../persistence/Services/CompositionTaskInputStore.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import { makeCompositionOrchestrator } from "./CompositionOrchestrator.ts";
import { seedDispatchingStart } from "./CompositionRetryRunStartDispatchRecoveryTestSupport.ts";
import { recoverCompositionRunStarts } from "./CompositionRunStartStartupRecovery.ts";

const fixedSecretKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

const secretStoreLayer = Layer.succeed(
  ServerSecretStore.ServerSecretStore,
  ServerSecretStore.ServerSecretStore.of({
    get: () => Effect.succeed(Option.none()),
    set: () => Effect.void,
    create: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(fixedSecretKey),
    remove: () => Effect.void,
  }),
);

const makeRuntimeLayer = (dbPath: string) => {
  const persistence = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));
  return Layer.mergeAll(
    CompositionTaskStoreLive,
    CompositionRunStartStoreLive,
    CompositionTaskInputStoreLive,
  ).pipe(Layer.provideMerge(persistence), Layer.provideMerge(secretStoreLayer));
};

it.effect("同一 SQLite 文件重建完整 Runtime 后由启动扫描恢复 dispatching RunStart", () => {
  const tempDir = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "codework-run-start-startup-recovery-"),
  );
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const movedPath = NodePath.join(tempDir, "state-moved.sqlite");
  const input = {
    taskId: "task-startup-restart",
    previousRunId: "run-startup-restart-old",
    runId: "run-startup-restart-new",
    agentId: "agent-startup-restart",
    runtimeId: "runtime-startup-restart",
    prompt: "验证真实跨 Runtime 启动恢复",
    workspaceRoot: "C:/workspace/startup-restart",
  };

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const inputStore = yield* CompositionTaskInputStore;
      yield* seedDispatchingStart({ store, runStartStore, ...input });
      yield* inputStore.save({
        taskId: input.taskId,
        prompt: input.prompt,
        workspaceRoot: input.workspaceRoot,
        capabilityIds: ["t3.workspace.read_file"],
      });
    }).pipe(Effect.provide(makeRuntimeLayer(dbPath)));

    yield* Effect.sync(() => {
      NodeFS.renameSync(dbPath, movedPath);
      NodeFS.renameSync(movedPath, dbPath);
    });

    const restored = yield* Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const inputStore = yield* CompositionTaskInputStore;
      let startCalls = 0;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: {
          mode: "idempotent-replay",
          capabilityGrantReplay: { mode: "verified" },
          requiredReceipt: "runtime-task",
        },
        startTask: () =>
          Effect.sync(() => {
            startCalls += 1;
            return { runtimeTaskId: "runtime-task-startup-restart" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        inputStore,
        runStartStore,
      );

      yield* recoverCompositionRunStarts({
        store,
        runStartStore,
        inputStore,
        orchestrator,
        recoveredAtUnixMs: 10_000,
      });

      return {
        startCalls,
        task: Option.getOrThrow(yield* store.getTask(input.taskId)),
        run: Option.getOrThrow(yield* store.getRun(input.runId)),
        intent: Option.getOrThrow(yield* runStartStore.getStart(input.runId)),
      };
    }).pipe(Effect.provide(makeRuntimeLayer(dbPath)));

    assert.equal(restored.startCalls, 1);
    assert.equal(restored.task.status, "running");
    assert.equal(restored.run.status, "running");
    assert.equal(restored.run.runtimeTaskId, "runtime-task-startup-restart");
    assert.equal(restored.intent.state, "settled");
    assert.equal(restored.intent.runtimeTaskId, "runtime-task-startup-restart");
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
