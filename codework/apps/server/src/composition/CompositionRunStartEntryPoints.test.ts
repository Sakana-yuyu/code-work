import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CompositionRunStartStoreLive } from "../persistence/Layers/CompositionRunStartStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CompositionRunStartStore } from "../persistence/Services/CompositionRunStartStore.ts";
import type { CompositionTaskInputStoreShape } from "../persistence/Services/CompositionTaskInputStore.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import { makeCompositionOrchestrator } from "./CompositionOrchestrator.ts";

const layer = it.layer(
  Layer.mergeAll(CompositionTaskStoreLive, CompositionRunStartStoreLive).pipe(
    Layer.provide(SqlitePersistenceMemory),
  ),
);

const runtimeTaskPolicy = {
  mode: "idempotent-replay" as const,
  capabilityGrantReplay: { mode: "verified" as const },
  requiredReceipt: "runtime-task" as const,
};

const makeInputStore = (): CompositionTaskInputStoreShape => {
  const inputs = new Map<string, Parameters<CompositionTaskInputStoreShape["save"]>[0]>();
  return {
    save: (input) => Effect.sync(() => void inputs.set(input.taskId, input)),
    get: (taskId) => Effect.succeed(Option.fromNullishOr(inputs.get(taskId))),
    remove: (taskId) => Effect.sync(() => void inputs.delete(taskId)),
  };
};

layer("Composition Run Start 统一入口", (it) => {
  it.effect("普通首启缺少必需 receipt 时不得投影为 running", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-entry-dispatch",
        runtimeId: "runtime-entry-dispatch",
        startRecoveryPolicy: runtimeTaskPolicy,
        startTask: () => Effect.succeed({}),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        makeInputStore(),
        runStartStore,
      );

      const result = yield* Effect.result(
        orchestrator.dispatchTask({
          taskId: "task-entry-dispatch",
          runId: "run-entry-dispatch",
          projectId: "project-entry-dispatch",
          assigneeKind: "agent",
          assigneeId: "agent-entry-dispatch",
          mode: "serial",
          promptDigest: "sha256:entry-dispatch",
          dependsOnTaskIds: [],
          workspaceRoot: "C:/workspace/entry-dispatch",
          prompt: "验证普通首启 receipt 边界",
          capabilityIds: [],
        }),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "CompositionAgentDriverFailure");
        if (result.failure._tag === "CompositionAgentDriverFailure") {
          assert.equal(result.failure.code, "run_start_runtime_task_receipt_missing");
        }
      }
      assert.equal(Option.getOrThrow(yield* store.getTask("task-entry-dispatch")).status, "queued");
      assert.equal(Option.getOrThrow(yield* store.getRun("run-entry-dispatch")).status, "queued");
      const intent = Option.getOrThrow(yield* runStartStore.getStart("run-entry-dispatch"));
      assert.equal(intent.state, "indeterminate");
      assert.equal(intent.outcomeCode, "run_start_runtime_task_receipt_missing");
    }),
  );

  it.effect("blocked 转 ready 缺少必需 receipt 时不得投影为 running", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const inputStore = makeInputStore();
      yield* inputStore.save({
        taskId: "task-entry-resume",
        prompt: "验证依赖恢复 receipt 边界",
        workspaceRoot: "C:/workspace/entry-resume",
        capabilityIds: [],
      });
      yield* store.upsertTask({
        taskId: "task-entry-dependency",
        projectId: "project-entry-resume",
        assigneeKind: "agent",
        assigneeId: "agent-entry-resume",
        mode: "serial",
        status: "completed",
        promptDigest: "sha256:entry-dependency",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
        finishedAtUnixMs: 2,
      });
      yield* store.upsertTask({
        taskId: "task-entry-resume",
        projectId: "project-entry-resume",
        assigneeKind: "agent",
        assigneeId: "agent-entry-resume",
        mode: "serial",
        status: "blocked",
        promptDigest: "sha256:entry-resume",
        dependsOnTaskIds: ["task-entry-dependency"],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
      });
      yield* store.upsertRun({
        taskId: "task-entry-resume",
        runId: "run-entry-resume",
        agentId: "agent-entry-resume",
        runtimeId: "runtime-entry-resume",
        status: "blocked",
        attempt: 1,
        capabilityGrantIds: [],
      });

      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-entry-resume",
        runtimeId: "runtime-entry-resume",
        startRecoveryPolicy: runtimeTaskPolicy,
        startTask: () => Effect.succeed({}),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        inputStore,
        runStartStore,
      );

      const result = yield* Effect.result(orchestrator.resumeReadyTasks());

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "CompositionAgentDriverFailure");
        if (result.failure._tag === "CompositionAgentDriverFailure") {
          assert.equal(result.failure.code, "run_start_runtime_task_receipt_missing");
        }
      }
      assert.equal(Option.getOrThrow(yield* store.getTask("task-entry-resume")).status, "blocked");
      assert.equal(Option.getOrThrow(yield* store.getRun("run-entry-resume")).status, "blocked");
      const intent = Option.getOrThrow(yield* runStartStore.getStart("run-entry-resume"));
      assert.equal(intent.state, "indeterminate");
      assert.equal(intent.outcomeCode, "run_start_runtime_task_receipt_missing");
    }),
  );
});
