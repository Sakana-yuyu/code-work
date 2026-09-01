import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { CompositionRunStartStoreLive } from "../persistence/Layers/CompositionRunStartStore.ts";
import { CompositionTaskInputStoreLive } from "../persistence/Layers/CompositionTaskInputStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  CompositionRunStartStore,
  type CompositionRunStartStoreShape,
} from "../persistence/Services/CompositionRunStartStore.ts";
import {
  CompositionTaskInputStore,
  type CompositionTaskInputStoreShape,
} from "../persistence/Services/CompositionTaskInputStore.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { makeSqliteCapabilityGrantRegistry } from "./CapabilityGrantRegistry.ts";
import { makeCompositionCapabilityRegistry } from "./CapabilityRegistry.ts";
import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import {
  CompositionAgentDriverFailure,
  makeCompositionOrchestrator,
} from "./CompositionOrchestrator.ts";
import { makeCompositionRunStartDigests } from "./CompositionRunStartLifecycle.ts";
import type { CompositionRunStartRecoveryCandidate } from "./CompositionRunStartRecoveryPolicy.ts";

const secretStoreLayer = ServerSecretStore.layer.pipe(
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "codework-run-start-entry-test-" }),
  ),
  Layer.provide(NodeServices.layer),
);

const layer = it.layer(
  Layer.mergeAll(
    CompositionTaskStoreLive,
    CompositionRunStartStoreLive,
    CompositionTaskInputStoreLive,
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory), Layer.provideMerge(secretStoreLayer)),
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

const failAfterMarkDispatching = (
  store: CompositionRunStartStoreShape,
): CompositionRunStartStoreShape => ({
  ...store,
  markDispatching: (input) =>
    store.markDispatching(input).pipe(
      Effect.flatMap(() =>
        Effect.fail(
          new PersistenceSqlError({
            operation: "CompositionRunStartEntryPoints.failAfterMarkDispatching",
            detail: "测试注入：dispatching 写入后回滚。",
          }),
        ),
      ),
    ),
});

layer("Composition Run Start 统一入口", (it) => {
  it.effect("启动恢复接受已验证 receipt 时原子投影为 running 且不重复启动外部任务", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const inputStore = makeInputStore();
      const taskId = "task-entry-startup-accepted";
      const runId = "run-entry-startup-accepted";
      const agentId = "agent-entry-startup-accepted";
      const runtimeId = "runtime-entry-startup-accepted";
      const workspaceRootDigest = "sha256:workspace-entry-startup-accepted";
      const model = "model-entry-startup-accepted";
      const externalTargetIdentity = {
        runtimeKind: "test",
        providerInstanceId: null,
        adapterId: null,
        modelIdentity: model,
        configDigest: null,
        sessionMode: "test",
      };
      const task = {
        taskId,
        projectId: "project-entry-startup-accepted",
        assigneeKind: "agent" as const,
        assigneeId: agentId,
        mode: "serial" as const,
        status: "queued" as const,
        promptDigest: "sha256:entry-startup-accepted",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1,
      };
      const run = {
        taskId,
        runId,
        agentId,
        runtimeId,
        status: "queued" as const,
        attempt: 1,
        capabilityGrantIds: [],
      };
      const digests = makeCompositionRunStartDigests({
        taskId,
        projectId: task.projectId,
        runId,
        previousRunId: null,
        assigneeKind: task.assigneeKind,
        assigneeId: task.assigneeId,
        mode: task.mode,
        dependsOnTaskIds: task.dependsOnTaskIds,
        agentId,
        runtimeId,
        attempt: run.attempt,
        promptDigest: task.promptDigest,
        workspaceRootDigest,
        model,
        externalTargetIdentity,
        capabilityIds: [],
      });
      yield* store.upsertTask(task);
      yield* store.upsertRun(run);
      yield* inputStore.save({
        taskId,
        prompt: "验证启动恢复 receipt 投影",
        workspaceRoot: "C:/workspace/entry-startup-accepted",
        workspaceRootDigest,
        model,
        capabilityIds: [],
      });
      const prepared = yield* runStartStore.prepareStart({
        taskId,
        runId,
        previousRunId: null,
        agentId,
        runtimeId,
        attempt: run.attempt,
        ...digests,
        createdAtUnixMs: 10,
      });
      const setup = yield* runStartStore.claimPrepared({
        runId,
        expectedRevision: prepared.revision,
        claimId: "claim-entry-startup-accepted",
        claimedAtUnixMs: 11,
        leaseExpiresAtUnixMs: 12,
      });
      const dispatching = yield* runStartStore.markDispatching({
        runId,
        expectedRevision: setup.intent.revision,
        claimId: setup.intent.claimId ?? "",
        ownerEpoch: setup.intent.ownerEpoch,
        dispatchedAtUnixMs: 11,
      });
      const candidate: CompositionRunStartRecoveryCandidate = {
        task,
        run,
        intent: dispatching,
        capabilityIds: [],
        workspaceRootDigest,
        model,
      };
      const driverRegistry = makeCompositionAgentDriverRegistry();
      let starts = 0;
      yield* driverRegistry.register({
        agentId,
        runtimeId,
        getStartIdentity: () => externalTargetIdentity,
        startRecoveryPolicy: recoveryPolicy,
        startTask: () =>
          Effect.sync(() => {
            starts += 1;
            return { runtimeTaskId: "unexpected" };
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
      yield* TestClock.adjust("13 millis");

      const result = yield* orchestrator.recoverPersistedRunStart({
        candidate,
        recoveryInput: Option.getOrThrow(yield* inputStore.get(taskId)),
        plan: {
          taskId,
          runId,
          action: "accept",
          runtimeTaskId: "runtime-task-entry-startup-accepted",
          capabilityHandshakeId: null,
        },
      });

      assert.equal(result.action, "accept");
      assert.equal(starts, 0);
      assert.equal(Option.getOrThrow(yield* store.getTask(taskId)).status, "running");
      assert.equal(
        Option.getOrThrow(yield* store.getRun(runId)).runtimeTaskId,
        "runtime-task-entry-startup-accepted",
      );
      assert.equal(Option.getOrThrow(yield* runStartStore.getStart(runId)).state, "settled");
    }),
  );

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
      assert.equal(
        Option.getOrThrow(yield* store.getTask("task-entry-dispatch")).status,
        "waiting_input",
      );
      assert.equal(
        Option.getOrThrow(yield* store.getRun("run-entry-dispatch")).status,
        "waiting_input",
      );
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
      assert.equal(replayed._tag, "Success");
      if (replayed._tag === "Success") assert.deepEqual(replayed.success, []);
      assert.equal(startCount, 1);
      assert.equal(
        Option.getOrThrow(yield* store.getTask("task-entry-quarantine-replay")).status,
        "waiting_input",
      );
      assert.equal(
        Option.getOrThrow(yield* store.getRun("run-entry-quarantine-replay")).status,
        "waiting_input",
      );
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
      assert.equal(
        Option.getOrThrow(yield* store.getTask("task-entry-long-runtime-task-receipt")).status,
        "waiting_input",
      );
      assert.equal(
        Option.getOrThrow(yield* store.getRun("run-entry-long-runtime-task-receipt")).status,
        "waiting_input",
      );
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
        startTask: () => Effect.succeed({ runtimeTaskId: "runtime-task-entry-accepted-atomic" }),
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
      assert.equal(
        Option.getOrThrow(yield* store.getTask("task-entry-accepted-atomic")).status,
        "queued",
      );
      assert.equal(
        Option.getOrThrow(yield* store.getRun("run-entry-accepted-atomic")).status,
        "queued",
      );
      const intent = Option.getOrThrow(yield* runStartStore.getStart("run-entry-accepted-atomic"));
      assert.equal(intent.state, "dispatching");
      assert.equal(intent.runtimeTaskId, null);
    }),
  );

  it.effect("failed 投影失败时不得单独结算 rejected 结果", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-entry-rejected-atomic",
        runtimeId: "runtime-entry-rejected-atomic",
        startRecoveryPolicy: recoveryPolicy,
        startTask: () =>
          Effect.fail(
            new CompositionAgentDriverFailure({
              code: "runtime_offline",
              detail: "模拟 Driver 明确失败。",
            }),
          ),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const failingStore = {
        ...store,
        appendEvent: (event: Parameters<typeof store.appendEvent>[0]) =>
          event.status === "failed"
            ? Effect.fail(
                new PersistenceSqlError({
                  operation: "CompositionRunStartEntryPoints.test",
                  detail: "模拟 failed 投影失败，验证 rejected 与 Task/Run 的原子边界。",
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
          taskId: "task-entry-rejected-atomic",
          runId: "run-entry-rejected-atomic",
          projectId: "project-entry-rejected-atomic",
          assigneeKind: "agent",
          assigneeId: "agent-entry-rejected-atomic",
          mode: "serial",
          promptDigest: "sha256:entry-rejected-atomic",
          dependsOnTaskIds: [],
          workspaceRoot: "C:/workspace/entry-rejected-atomic",
          prompt: "验证 rejected 与失败投影原子性",
          capabilityIds: [],
        }),
      );

      assert.equal(result._tag, "Failure");
      assert.equal(
        Option.getOrThrow(yield* store.getTask("task-entry-rejected-atomic")).status,
        "queued",
      );
      assert.equal(
        Option.getOrThrow(yield* store.getRun("run-entry-rejected-atomic")).status,
        "queued",
      );
      const intent = Option.getOrThrow(yield* runStartStore.getStart("run-entry-rejected-atomic"));
      assert.equal(intent.state, "dispatching");
      assert.equal(intent.outcomeCode, null);
    }),
  );

  it.effect("receipt 失败投影失败时不得单独持久化 quarantine", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-entry-quarantine-atomic",
        runtimeId: "runtime-entry-quarantine-atomic",
        startRecoveryPolicy: recoveryPolicy,
        startTask: () => Effect.succeed({ runtimeTaskId: "r".repeat(1_025) }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const failingStore = {
        ...store,
        appendEvent: (event: Parameters<typeof store.appendEvent>[0]) =>
          event.status === "waiting_input"
            ? Effect.fail(
                new PersistenceSqlError({
                  operation: "CompositionRunStartEntryPoints.test",
                  detail: "模拟 failed 投影失败，验证 quarantine 与 Task/Run 的原子边界。",
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
          taskId: "task-entry-quarantine-atomic",
          runId: "run-entry-quarantine-atomic",
          projectId: "project-entry-quarantine-atomic",
          assigneeKind: "agent",
          assigneeId: "agent-entry-quarantine-atomic",
          mode: "serial",
          promptDigest: "sha256:entry-quarantine-atomic",
          dependsOnTaskIds: [],
          workspaceRoot: "C:/workspace/entry-quarantine-atomic",
          prompt: "验证 quarantine 与失败投影原子性",
          capabilityIds: [],
        }),
      );

      assert.equal(result._tag, "Failure");
      assert.equal(
        Option.getOrThrow(yield* store.getTask("task-entry-quarantine-atomic")).status,
        "queued",
      );
      assert.equal(
        Option.getOrThrow(yield* store.getRun("run-entry-quarantine-atomic")).status,
        "queued",
      );
      const intent = Option.getOrThrow(
        yield* runStartStore.getStart("run-entry-quarantine-atomic"),
      );
      assert.equal(intent.state, "dispatching");
      assert.equal(intent.outcomeCode, null);
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
      assert.equal(
        Option.getOrThrow(yield* store.getTask("task-entry-resume")).status,
        "waiting_input",
      );
      assert.equal(
        Option.getOrThrow(yield* store.getRun("run-entry-resume")).status,
        "waiting_input",
      );
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

  it.effect("retry 的旧恢复输入缺少 capabilityIds 时使用持久 previousRunId 隔离", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const inputStore = makeInputStore();
      const taskId = "task-entry-legacy-retry-capabilities";
      const previousRunId = "run-entry-legacy-retry-capabilities-1";
      const runId = "run-entry-legacy-retry-capabilities-2";
      const agentId = "agent-entry-legacy-retry-capabilities";
      const runtimeId = "runtime-entry-legacy-retry-capabilities";
      const dependencyId = "task-entry-legacy-retry-capabilities-dependency";
      yield* inputStore.save({
        taskId,
        prompt: "验证 retry 旧恢复输入 capability 身份边界",
        workspaceRoot: "C:/workspace/entry-legacy-retry-capabilities",
      });
      yield* store.upsertTask({
        taskId: dependencyId,
        projectId: "project-entry-legacy-retry-capabilities",
        assigneeKind: "agent",
        assigneeId: agentId,
        mode: "serial",
        status: "completed",
        promptDigest: "sha256:entry-legacy-retry-capabilities-dependency",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
        finishedAtUnixMs: 2,
      });
      yield* store.upsertTask({
        taskId,
        projectId: "project-entry-legacy-retry-capabilities",
        assigneeKind: "agent",
        assigneeId: agentId,
        mode: "serial",
        status: "blocked",
        promptDigest: "sha256:entry-legacy-retry-capabilities",
        dependsOnTaskIds: [dependencyId],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
      });
      yield* store.upsertRun({
        taskId,
        runId: previousRunId,
        agentId,
        runtimeId,
        status: "failed",
        attempt: 1,
        capabilityGrantIds: [],
      });
      yield* store.upsertRun({
        taskId,
        runId,
        agentId,
        runtimeId,
        status: "blocked",
        attempt: 2,
        capabilityGrantIds: ["grant-entry-legacy-retry-capabilities"],
      });
      const digests = makeCompositionRunStartDigests({
        taskId,
        projectId: "project-entry-legacy-retry-capabilities",
        runId,
        previousRunId,
        assigneeKind: "agent",
        assigneeId: agentId,
        mode: "serial",
        dependsOnTaskIds: [dependencyId],
        agentId,
        runtimeId,
        attempt: 2,
        promptDigest: "sha256:entry-legacy-retry-capabilities",
        capabilityIds: null,
      });
      yield* runStartStore.prepareStart({
        taskId,
        runId,
        previousRunId,
        agentId,
        runtimeId,
        attempt: 2,
        ...digests,
        createdAtUnixMs: 10,
      });

      let startCount = 0;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId,
        runtimeId,
        startRecoveryPolicy: recoveryPolicy,
        startTask: () =>
          Effect.sync(() => {
            startCount += 1;
            return { runtimeTaskId: "runtime-task-entry-legacy-retry-capabilities" };
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
      const intent = Option.getOrThrow(yield* runStartStore.getStart(runId));
      assert.equal(intent.previousRunId, previousRunId);
      assert.equal(intent.state, "quarantined");
      assert.equal(intent.outcomeCode, "run_start_legacy_input_capabilities_unknown");
    }),
  );

  it.effect(
    "retry setup 在 dispatching 后失败时原子回滚 intent、输入、grant、queued 投影与 lease",
    () =>
      Effect.gen(function* () {
        const store = yield* CompositionTaskStore;
        const runStartStore = yield* CompositionRunStartStore;
        const inputStore = yield* CompositionTaskInputStore;
        const sql = yield* SqlClient.SqlClient;
        const taskId = "task-entry-retry-setup-rollback";
        const previousRunId = "run-entry-retry-setup-rollback-1";
        const runId = "run-entry-retry-setup-rollback-2";
        const agentId = "agent-entry-retry-setup-rollback";
        const runtimeId = "runtime-entry-retry-setup-rollback";
        const oldCapabilityIds = ["t3.runtime.provider"];
        const newCapabilityIds = ["t3.workspace.read_file"];
        yield* inputStore.save({
          taskId,
          prompt: "验证 retry setup SQLite 原子回滚",
          workspaceRoot: "C:/workspace/entry-retry-setup-rollback",
          workspaceRootDigest: "sha256:entry-retry-setup-rollback-workspace",
          capabilityIds: oldCapabilityIds,
        });
        yield* store.upsertTask({
          taskId,
          projectId: "project-entry-retry-setup-rollback",
          assigneeKind: "agent",
          assigneeId: agentId,
          mode: "serial",
          status: "failed",
          promptDigest: "sha256:entry-retry-setup-rollback",
          dependsOnTaskIds: [],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 2,
          finishedAtUnixMs: 2,
        });
        yield* store.upsertRun({
          taskId,
          runId: previousRunId,
          agentId,
          runtimeId,
          status: "failed",
          attempt: 1,
          capabilityGrantIds: [],
          finishedAtUnixMs: 2,
        });
        let starts = 0;
        const driverRegistry = makeCompositionAgentDriverRegistry();
        yield* driverRegistry.register({
          agentId,
          runtimeId,
          startRecoveryPolicy: recoveryPolicy,
          startTask: () =>
            Effect.sync(() => {
              starts += 1;
              return { runtimeTaskId: "unexpected-retry-rollback-start" };
            }),
          cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
        });
        const grantRegistry = makeSqliteCapabilityGrantRegistry({
          capabilityRegistry: makeCompositionCapabilityRegistry(),
          sql,
          now: () => 100,
          randomUUID: () => "grant-entry-retry-setup-rollback",
        });
        const orchestrator = makeCompositionOrchestrator(
          store,
          driverRegistry,
          grantRegistry,
          inputStore,
          failAfterMarkDispatching(runStartStore),
        );

        const result = yield* Effect.result(
          orchestrator.retryTask({
            taskId,
            previousRunId,
            runId,
            reason: "测试事务回滚",
            capabilityIds: newCapabilityIds,
          }),
        );

        assert.equal(result._tag, "Failure");
        assert.equal(starts, 0);
        assert.deepEqual(
          Option.getOrThrow(yield* inputStore.get(taskId)).capabilityIds,
          oldCapabilityIds,
        );
        assert.equal(Option.getOrThrow(yield* store.getTask(taskId)).status, "failed");
        assert.isTrue(Option.isNone(yield* store.getRun(runId)));
        assert.isTrue(Option.isNone(yield* runStartStore.getStart(runId)));
        const [grantCount] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count"
        FROM composition_capability_grants
        WHERE task_id = ${taskId} AND capability_id = ${newCapabilityIds[0]}
      `;
        const [leaseCount] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count"
        FROM composition_runtime_leases
        WHERE task_id = ${taskId}
      `;
        assert.equal(grantCount?.count ?? 0, 0);
        assert.equal(leaseCount?.count ?? 0, 0);
      }),
  );

  it.effect("retry 成功后把新 capabilityIds 与新 grants 一并持久化供重启恢复", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const inputStore = yield* CompositionTaskInputStore;
      const sql = yield* SqlClient.SqlClient;
      const taskId = "task-entry-retry-capabilities-persisted";
      const previousRunId = "run-entry-retry-capabilities-persisted-1";
      const runId = "run-entry-retry-capabilities-persisted-2";
      const agentId = "agent-entry-retry-capabilities-persisted";
      const runtimeId = "runtime-entry-retry-capabilities-persisted";
      const capabilityIds = ["t3.workspace.read_file"];
      yield* inputStore.save({
        taskId,
        prompt: "验证 retry capability 身份跨重启持久化",
        workspaceRoot: "C:/workspace/entry-retry-capabilities-persisted",
        capabilityIds: ["t3.runtime.provider"],
      });
      yield* store.upsertTask({
        taskId,
        projectId: "project-entry-retry-capabilities-persisted",
        assigneeKind: "agent",
        assigneeId: agentId,
        mode: "serial",
        status: "failed",
        promptDigest: "sha256:entry-retry-capabilities-persisted",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
        finishedAtUnixMs: 2,
      });
      yield* store.upsertRun({
        taskId,
        runId: previousRunId,
        agentId,
        runtimeId,
        status: "failed",
        attempt: 1,
        capabilityGrantIds: [],
        finishedAtUnixMs: 2,
      });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId,
        runtimeId,
        startRecoveryPolicy: recoveryPolicy,
        startTask: () =>
          Effect.succeed({ runtimeTaskId: "runtime-task-entry-retry-capabilities-persisted" }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const grantRegistry = makeSqliteCapabilityGrantRegistry({
        capabilityRegistry: makeCompositionCapabilityRegistry(),
        sql,
        now: () => 100,
        randomUUID: () => "grant-entry-retry-capabilities-persisted",
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        grantRegistry,
        inputStore,
        runStartStore,
      );

      const result = yield* orchestrator.retryTask({
        taskId,
        previousRunId,
        runId,
        reason: "验证新 capability 身份",
        capabilityIds,
      });

      assert.equal(result.task.status, "running");
      assert.equal(result.run.status, "running");
      assert.deepEqual(
        Option.getOrThrow(yield* inputStore.get(taskId)).capabilityIds,
        capabilityIds,
      );
      assert.deepEqual(result.run.capabilityGrantIds, [
        "grant-grant-entry-retry-capabilities-persisted",
      ]);
      const intent = Option.getOrThrow(yield* runStartStore.getStart(runId));
      assert.equal(intent.state, "settled");
      assert.equal(intent.previousRunId, previousRunId);
      assert.equal(
        intent.capabilityDigest,
        makeCompositionRunStartDigests({
          taskId,
          projectId: result.task.projectId,
          runId,
          previousRunId,
          assigneeKind: result.task.assigneeKind,
          assigneeId: result.task.assigneeId,
          mode: result.task.mode,
          dependsOnTaskIds: result.task.dependsOnTaskIds,
          agentId,
          runtimeId,
          attempt: result.run.attempt,
          promptDigest: result.task.promptDigest,
          capabilityIds,
        }).capabilityDigest,
      );
    }),
  );

  it.effect(
    "blocked-ready setup 在 dispatching 后失败时不留下 preparing tombstone 或 queued 半快照",
    () =>
      Effect.gen(function* () {
        const store = yield* CompositionTaskStore;
        const runStartStore = yield* CompositionRunStartStore;
        const inputStore = yield* CompositionTaskInputStore;
        const sql = yield* SqlClient.SqlClient;
        const taskId = "task-entry-resume-setup-rollback";
        const runId = "run-entry-resume-setup-rollback";
        const dependencyId = "task-entry-resume-setup-rollback-dependency";
        const agentId = "agent-entry-resume-setup-rollback";
        const runtimeId = "runtime-entry-resume-setup-rollback";
        yield* inputStore.save({
          taskId,
          prompt: "验证 blocked-ready setup SQLite 原子回滚",
          workspaceRoot: "C:/workspace/entry-resume-setup-rollback",
          workspaceRootDigest: "sha256:entry-resume-setup-rollback-workspace",
          capabilityIds: [],
        });
        yield* store.upsertTask({
          taskId: dependencyId,
          projectId: "project-entry-resume-setup-rollback",
          assigneeKind: "agent",
          assigneeId: agentId,
          mode: "serial",
          status: "completed",
          promptDigest: "sha256:entry-resume-setup-rollback-dependency",
          dependsOnTaskIds: [],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 2,
          finishedAtUnixMs: 2,
        });
        yield* store.upsertTask({
          taskId,
          projectId: "project-entry-resume-setup-rollback",
          assigneeKind: "agent",
          assigneeId: agentId,
          mode: "serial",
          status: "blocked",
          promptDigest: "sha256:entry-resume-setup-rollback",
          dependsOnTaskIds: [dependencyId],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 2,
        });
        yield* store.upsertRun({
          taskId,
          runId,
          agentId,
          runtimeId,
          status: "blocked",
          attempt: 1,
          capabilityGrantIds: [],
        });
        let starts = 0;
        const driverRegistry = makeCompositionAgentDriverRegistry();
        yield* driverRegistry.register({
          agentId,
          runtimeId,
          startRecoveryPolicy: recoveryPolicy,
          startTask: () =>
            Effect.sync(() => {
              starts += 1;
              return { runtimeTaskId: "unexpected-resume-rollback-start" };
            }),
          cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
        });
        const orchestrator = makeCompositionOrchestrator(
          store,
          driverRegistry,
          undefined,
          inputStore,
          failAfterMarkDispatching(runStartStore),
        );

        const result = yield* Effect.result(orchestrator.resumeReadyTasks());

        assert.equal(result._tag, "Failure");
        assert.equal(starts, 0);
        assert.equal(Option.getOrThrow(yield* store.getTask(taskId)).status, "blocked");
        assert.equal(Option.getOrThrow(yield* store.getRun(runId)).status, "blocked");
        assert.isTrue(Option.isNone(yield* runStartStore.getStart(runId)));
        const [leaseCount] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count"
        FROM composition_runtime_leases
        WHERE task_id = ${taskId}
      `;
        const events = yield* store.listEvents(taskId, runId);
        assert.equal(leaseCount?.count ?? 0, 0);
        assert.deepEqual(events, []);
      }),
  );
});
