import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import { CompositionRunStartStoreLive } from "../persistence/Layers/CompositionRunStartStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CompositionRunStartStore } from "../persistence/Services/CompositionRunStartStore.ts";
import type { CompositionTaskInputStoreShape } from "../persistence/Services/CompositionTaskInputStore.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import {
  CompositionAgentDriverFailure,
  makeCompositionOrchestrator,
} from "./CompositionOrchestrator.ts";

const layer = it.layer(
  Layer.mergeAll(CompositionTaskStoreLive, CompositionRunStartStoreLive).pipe(
    Layer.provide(SqlitePersistenceMemory),
  ),
);

const makeInputStore = (): CompositionTaskInputStoreShape => {
  const inputs = new Map<string, Parameters<CompositionTaskInputStoreShape["save"]>[0]>();
  return {
    save: (input) => Effect.sync(() => void inputs.set(input.taskId, input)),
    get: (taskId) => Effect.succeed(Option.fromNullishOr(inputs.get(taskId))),
    remove: (taskId) => Effect.sync(() => void inputs.delete(taskId)),
  };
};

const recoveryPolicy = {
  mode: "idempotent-replay" as const,
  requiredReceipt: "runtime-task" as const,
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
        startRecoveryPolicy: recoveryPolicy,
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
      assert.equal(intent.state, "quarantined");
      assert.equal(intent.outcomeCode, "run_start_runtime_task_receipt_missing");
    }),
  );

  it.effect("重复命中 quarantined 意图时返回稳定隔离结果且不重复启动", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const inputStore = makeInputStore();
      yield* inputStore.save({
        taskId: "task-entry-quarantine-replay",
        prompt: "验证 quarantine 稳定重放",
        workspaceRoot: "C:/workspace/entry-quarantine-replay",
        capabilityIds: [],
      });
      yield* store.upsertTask({
        taskId: "task-entry-quarantine-replay-dependency",
        projectId: "project-entry-quarantine-replay",
        assigneeKind: "agent",
        assigneeId: "agent-entry-quarantine-replay",
        mode: "serial",
        status: "completed",
        promptDigest: "sha256:entry-quarantine-replay-dependency",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
        finishedAtUnixMs: 2,
      });
      yield* store.upsertTask({
        taskId: "task-entry-quarantine-replay",
        projectId: "project-entry-quarantine-replay",
        assigneeKind: "agent",
        assigneeId: "agent-entry-quarantine-replay",
        mode: "serial",
        status: "blocked",
        promptDigest: "sha256:entry-quarantine-replay",
        dependsOnTaskIds: ["task-entry-quarantine-replay-dependency"],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
      });
      yield* store.upsertRun({
        taskId: "task-entry-quarantine-replay",
        runId: "run-entry-quarantine-replay",
        agentId: "agent-entry-quarantine-replay",
        runtimeId: "runtime-entry-quarantine-replay",
        status: "blocked",
        attempt: 1,
        capabilityGrantIds: [],
      });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      let startCount = 0;
      yield* driverRegistry.register({
        agentId: "agent-entry-quarantine-replay",
        runtimeId: "runtime-entry-quarantine-replay",
        startRecoveryPolicy: recoveryPolicy,
        startTask: () =>
          Effect.sync(() => {
            startCount += 1;
            return {};
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

      const first = yield* Effect.result(orchestrator.resumeReadyTasks());
      const replayed = yield* Effect.result(orchestrator.resumeReadyTasks());

      assert.equal(first._tag, "Failure");
      assert.equal(replayed._tag, "Failure");
      if (replayed._tag === "Failure") {
        assert.equal(replayed.failure._tag, "CompositionAgentDriverFailure");
        if (replayed.failure._tag === "CompositionAgentDriverFailure") {
          assert.equal(replayed.failure.code, "run_start_runtime_task_receipt_missing");
        }
      }
      assert.equal(startCount, 1);
      const intent = Option.getOrThrow(
        yield* runStartStore.getStart("run-entry-quarantine-replay"),
      );
      assert.equal(intent.state, "quarantined");
      assert.equal(intent.outcomeCode, "run_start_runtime_task_receipt_missing");
    }),
  );

  it.effect("超长 Driver failure detail 会被安全持久化并结算意图", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      const code = `driver-failure:${"c".repeat(200)}`;
      const detail = `driver-failure:${"x".repeat(2_000)}`;
      yield* driverRegistry.register({
        agentId: "agent-entry-long-driver-failure",
        runtimeId: "runtime-entry-long-driver-failure",
        startRecoveryPolicy: recoveryPolicy,
        startTask: () =>
          Effect.fail(
            new CompositionAgentDriverFailure({
              code,
              detail,
            }),
          ),
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
          taskId: "task-entry-long-driver-failure",
          runId: "run-entry-long-driver-failure",
          projectId: "project-entry-long-driver-failure",
          assigneeKind: "agent",
          assigneeId: "agent-entry-long-driver-failure",
          mode: "serial",
          promptDigest: "sha256:entry-long-driver-failure",
          dependsOnTaskIds: [],
          workspaceRoot: "C:/workspace/entry-long-driver-failure",
          prompt: "验证超长 Driver failure detail",
          capabilityIds: [],
        }),
      );

      assert.equal(result._tag, "Success");
      if (result._tag === "Success") {
        assert.equal(result.success.run.status, "failed");
        assert.equal(result.success.run.failureCode, code);
      }
      const intent = Option.getOrThrow(
        yield* runStartStore.getStart("run-entry-long-driver-failure"),
      );
      assert.equal(intent.state, "settled");
      assert.equal(intent.outcomeCode, code.slice(0, 128));
      assert.isTrue((intent.outcomeDetail?.length ?? 0) <= 1_024);
      assert.equal(intent.outcomeDetail, detail.slice(0, 1_024));
    }),
  );

  it.effect("空白 Driver failure 使用稳定持久化 fallback 但保留原失败投影", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-entry-blank-driver-failure",
        runtimeId: "runtime-entry-blank-driver-failure",
        startRecoveryPolicy: recoveryPolicy,
        startTask: () =>
          Effect.fail(
            new CompositionAgentDriverFailure({
              code: "   ",
              detail: "\t\r\n",
            }),
          ),
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
          taskId: "task-entry-blank-driver-failure",
          runId: "run-entry-blank-driver-failure",
          projectId: "project-entry-blank-driver-failure",
          assigneeKind: "agent",
          assigneeId: "agent-entry-blank-driver-failure",
          mode: "serial",
          promptDigest: "sha256:entry-blank-driver-failure",
          dependsOnTaskIds: [],
          workspaceRoot: "C:/workspace/entry-blank-driver-failure",
          prompt: "验证空白 Driver failure",
          capabilityIds: [],
        }),
      );

      assert.equal(result._tag, "Success");
      if (result._tag === "Success") {
        assert.equal(result.success.run.failureCode, "   ");
      }
      const intent = Option.getOrThrow(
        yield* runStartStore.getStart("run-entry-blank-driver-failure"),
      );
      assert.equal(intent.state, "settled");
      assert.equal(intent.outcomeCode, "agent_driver_failure");
      assert.equal(intent.outcomeDetail, "Agent Driver 未提供可持久化的错误详情。");
    }),
  );

  it.effect("过长 runtimeTaskId receipt 会进入 quarantine 而不是卡在 dispatching", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-entry-long-runtime-task-receipt",
        runtimeId: "runtime-entry-long-runtime-task-receipt",
        startRecoveryPolicy: recoveryPolicy,
        startTask: () => Effect.succeed({ runtimeTaskId: "r".repeat(1_025) }),
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
          taskId: "task-entry-long-runtime-task-receipt",
          runId: "run-entry-long-runtime-task-receipt",
          projectId: "project-entry-long-runtime-task-receipt",
          assigneeKind: "agent",
          assigneeId: "agent-entry-long-runtime-task-receipt",
          mode: "serial",
          promptDigest: "sha256:entry-long-runtime-task-receipt",
          dependsOnTaskIds: [],
          workspaceRoot: "C:/workspace/entry-long-runtime-task-receipt",
          prompt: "验证过长 runtimeTaskId receipt",
          capabilityIds: [],
        }),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "CompositionAgentDriverFailure");
        if (result.failure._tag === "CompositionAgentDriverFailure") {
          assert.equal(result.failure.code, "run_start_runtime_task_receipt_invalid");
        }
      }
      const intent = Option.getOrThrow(
        yield* runStartStore.getStart("run-entry-long-runtime-task-receipt"),
      );
      assert.equal(intent.state, "quarantined");
      assert.equal(intent.outcomeCode, "run_start_runtime_task_receipt_invalid");
    }),
  );

  it.effect("running 投影失败时不得单独持久化 accepted receipt", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-entry-accepted-atomic",
        runtimeId: "runtime-entry-accepted-atomic",
        startRecoveryPolicy: recoveryPolicy,
        startTask: () =>
          Effect.succeed({ runtimeTaskId: "runtime-task-entry-accepted-atomic" }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const failingStore = {
        ...store,
        appendEvent: (event: Parameters<typeof store.appendEvent>[0]) =>
          event.status === "running"
            ? Effect.fail(
                new PersistenceSqlError({
                  operation: "CompositionRunStartEntryPoints.test",
                  detail: "模拟 running 投影失败，验证 receipt 与 Task/Run 的原子边界。",
                }),
              )
            : store.appendEvent(event),
      };
      const orchestrator = makeCompositionOrchestrator(
        failingStore,
        driverRegistry,
        undefined,
        makeInputStore(),
        runStartStore,
      );

      const result = yield* Effect.result(
        orchestrator.dispatchTask({
          taskId: "task-entry-accepted-atomic",
          runId: "run-entry-accepted-atomic",
          projectId: "project-entry-accepted-atomic",
          assigneeKind: "agent",
          assigneeId: "agent-entry-accepted-atomic",
          mode: "serial",
          promptDigest: "sha256:entry-accepted-atomic",
          dependsOnTaskIds: [],
          workspaceRoot: "C:/workspace/entry-accepted-atomic",
          prompt: "验证 accepted receipt 与运行投影原子性",
          capabilityIds: [],
        }),
      );

      assert.equal(result._tag, "Failure");
      assert.equal(Option.getOrThrow(yield* store.getTask("task-entry-accepted-atomic")).status, "queued");
      assert.equal(Option.getOrThrow(yield* store.getRun("run-entry-accepted-atomic")).status, "queued");
      const intent = Option.getOrThrow(
        yield* runStartStore.getStart("run-entry-accepted-atomic"),
      );
      assert.equal(intent.state, "dispatching");
      assert.equal(intent.runtimeTaskId, null);
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
        startRecoveryPolicy: recoveryPolicy,
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
      assert.equal(intent.state, "quarantined");
      assert.equal(intent.outcomeCode, "run_start_runtime_task_receipt_missing");
    }),
  );

  it.effect("旧恢复输入缺少 capabilityIds 时稳定隔离且不调用 Driver", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const inputStore = makeInputStore();
      yield* inputStore.save({
        taskId: "task-entry-legacy-capabilities",
        prompt: "验证旧恢复输入 capability 身份边界",
        workspaceRoot: "C:/workspace/entry-legacy-capabilities",
      });
      yield* store.upsertTask({
        taskId: "task-entry-legacy-capabilities-dependency",
        projectId: "project-entry-legacy-capabilities",
        assigneeKind: "agent",
        assigneeId: "agent-entry-legacy-capabilities",
        mode: "serial",
        status: "completed",
        promptDigest: "sha256:entry-legacy-capabilities-dependency",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
        finishedAtUnixMs: 2,
      });
      yield* store.upsertTask({
        taskId: "task-entry-legacy-capabilities",
        projectId: "project-entry-legacy-capabilities",
        assigneeKind: "agent",
        assigneeId: "agent-entry-legacy-capabilities",
        mode: "serial",
        status: "blocked",
        promptDigest: "sha256:entry-legacy-capabilities",
        dependsOnTaskIds: ["task-entry-legacy-capabilities-dependency"],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
      });
      yield* store.upsertRun({
        taskId: "task-entry-legacy-capabilities",
        runId: "run-entry-legacy-capabilities",
        agentId: "agent-entry-legacy-capabilities",
        runtimeId: "runtime-entry-legacy-capabilities",
        status: "blocked",
        attempt: 1,
        capabilityGrantIds: ["grant-entry-legacy-capabilities"],
      });

      let startCount = 0;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-entry-legacy-capabilities",
        runtimeId: "runtime-entry-legacy-capabilities",
        startRecoveryPolicy: recoveryPolicy,
        startTask: () =>
          Effect.sync(() => {
            startCount += 1;
            return { runtimeTaskId: "runtime-task-entry-legacy-capabilities" };
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

      const result = yield* orchestrator.resumeReadyTasks();

      assert.deepEqual(result, []);
      assert.equal(startCount, 0);
      assert.equal(
        Option.getOrThrow(yield* store.getTask("task-entry-legacy-capabilities")).status,
        "blocked",
      );
      assert.equal(
        Option.getOrThrow(yield* store.getRun("run-entry-legacy-capabilities")).status,
        "blocked",
      );
      const intent = Option.getOrThrow(
        yield* runStartStore.getStart("run-entry-legacy-capabilities"),
      );
      assert.equal(intent.state, "quarantined");
      assert.equal(intent.outcomeCode, "run_start_legacy_input_capabilities_unknown");
    }),
  );
});
