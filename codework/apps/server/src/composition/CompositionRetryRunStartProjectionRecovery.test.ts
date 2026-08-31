import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import { CompositionRunStartStore } from "../persistence/Services/CompositionRunStartStore.ts";
import {
  CompositionTaskStore,
  type CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import { makeCompositionOrchestrator } from "./CompositionOrchestrator.ts";
import {
  compositionOrchestratorRunStartTestLayer,
  makeRunStartRecoveryInputStore,
} from "./CompositionOrchestratorRunStartTestSupport.ts";
import { seedDispatchingStart } from "./CompositionRetryRunStartDispatchRecoveryTestSupport.ts";

const layer = it.layer(compositionOrchestratorRunStartTestLayer);

layer("Composition Retry Run Start Projection Recovery", (it) => {
  it.effect("Driver accepted 后 Task 投影缺失时保留 accepted 供后续恢复", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-dispatching-projection-missing",
        previousRunId: "run-dispatching-projection-missing-old",
        runId: "run-dispatching-projection-missing-new",
        agentId: "agent-dispatching-projection-missing",
        runtimeId: "runtime-dispatching-projection-missing",
        prompt: "accepted 后投影必须确认",
        workspaceRoot: "C:/workspace/dispatching-projection-missing",
      };
      const seeded = yield* seedDispatchingStart({ store, runStartStore, ...input });
      let newRunReads = 0;
      const failingStore: CompositionTaskStoreShape = {
        ...store,
        getRun: (runId) =>
          runId === input.runId && ++newRunReads === 2
            ? Effect.succeed(Option.none())
            : store.getRun(runId),
      };
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: {
          mode: "idempotent-replay",
          capabilityGrantReplay: { mode: "verified" },
          requiredReceipt: "runtime-task-and-handshake-when-granted",
        },
        startTask: () =>
          Effect.succeed({ runtimeTaskId: "runtime-task-dispatching-projection-missing" }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        failingStore,
        driverRegistry,
        undefined,
        makeRunStartRecoveryInputStore(input.taskId, input.prompt, input.workspaceRoot),
        runStartStore,
      );

      const result = yield* Effect.result(orchestrator.recoverRunStart(seeded.request));
      const intent = Option.getOrThrow(yield* runStartStore.getStart(input.runId));

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.instanceOf(result.failure, PersistenceSqlError);
      assert.equal(intent.state, "accepted");
    }),
  );

  it.effect("Driver accepted 后 Run 身份漂移时拒绝 settle", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-dispatching-projection-drift",
        previousRunId: "run-dispatching-projection-drift-old",
        runId: "run-dispatching-projection-drift-new",
        agentId: "agent-dispatching-projection-drift",
        runtimeId: "runtime-dispatching-projection-drift",
        prompt: "拒绝漂移投影",
        workspaceRoot: "C:/workspace/dispatching-projection-drift",
      };
      const seeded = yield* seedDispatchingStart({ store, runStartStore, ...input });
      let newRunReads = 0;
      const driftingStore: CompositionTaskStoreShape = {
        ...store,
        getRun: (runId) =>
          store
            .getRun(runId)
            .pipe(
              Effect.map((run) =>
                runId === input.runId && ++newRunReads === 2
                  ? Option.map(run, (value) => ({ ...value, agentId: "agent-foreign" }))
                  : run,
              ),
            ),
      };
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: {
          mode: "idempotent-replay",
          capabilityGrantReplay: { mode: "verified" },
          requiredReceipt: "runtime-task-and-handshake-when-granted",
        },
        startTask: () =>
          Effect.succeed({ runtimeTaskId: "runtime-task-dispatching-projection-drift" }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        driftingStore,
        driverRegistry,
        undefined,
        makeRunStartRecoveryInputStore(input.taskId, input.prompt, input.workspaceRoot),
        runStartStore,
      );

      const result = yield* Effect.result(orchestrator.recoverRunStart(seeded.request));
      const intent = Option.getOrThrow(yield* runStartStore.getStart(input.runId));

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.instanceOf(result.failure, PersistenceSqlError);
      assert.equal(intent.state, "accepted");
    }),
  );

  it.effect("Task assignee 与 dispatching intent 不一致时拒绝结算", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-dispatching-assignee-conflict",
        previousRunId: "run-dispatching-assignee-conflict-old",
        runId: "run-dispatching-assignee-conflict-new",
        agentId: "agent-dispatching-assignee-conflict",
        runtimeId: "runtime-dispatching-assignee-conflict",
        prompt: "拒绝错误 assignee 投影",
        workspaceRoot: "C:/workspace/dispatching-assignee-conflict",
        status: "running" as const,
        runtimeTaskId: "runtime-task-dispatching-assignee-conflict",
      };
      const seeded = yield* seedDispatchingStart({ store, runStartStore, ...input });
      const task = Option.getOrThrow(yield* store.getTask(input.taskId));
      yield* store.upsertTask({ ...task, assigneeId: "agent-foreign" });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: {
          mode: "fail-closed",
          reasonCode: "runtime_start_replay_not_verified",
          requiredReceipt: "runtime-task-and-handshake-when-granted",
        },
        startTask: () => Effect.die("身份冲突不得触发 Driver"),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        makeRunStartRecoveryInputStore(input.taskId, input.prompt, input.workspaceRoot),
        runStartStore,
      );

      const result = yield* Effect.result(orchestrator.recoverRunStart(seeded.request));
      const intent = Option.getOrThrow(yield* runStartStore.getStart(input.runId));

      assert.equal(result._tag, "Failure");
      assert.equal(intent.state, "indeterminate");
      assert.equal(intent.outcomeCode, "run_start_dispatching_projection_identity_conflict");
    }),
  );

  it.effect("blocked 投影即使带 runtimeTaskId 也不得作为已启动状态结算", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-dispatching-blocked-projection",
        previousRunId: "run-dispatching-blocked-projection-old",
        runId: "run-dispatching-blocked-projection-new",
        agentId: "agent-dispatching-blocked-projection",
        runtimeId: "runtime-dispatching-blocked-projection",
        prompt: "拒绝非启动状态投影",
        workspaceRoot: "C:/workspace/dispatching-blocked-projection",
        status: "blocked" as const,
        runtimeTaskId: "runtime-task-dispatching-blocked-projection",
      };
      const seeded = yield* seedDispatchingStart({ store, runStartStore, ...input });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: {
          mode: "fail-closed",
          reasonCode: "runtime_start_replay_not_verified",
          requiredReceipt: "runtime-task-and-handshake-when-granted",
        },
        startTask: () => Effect.die("blocked 投影不得触发 Driver"),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        makeRunStartRecoveryInputStore(input.taskId, input.prompt, input.workspaceRoot),
        runStartStore,
      );

      const result = yield* Effect.result(orchestrator.recoverRunStart(seeded.request));
      const intent = Option.getOrThrow(yield* runStartStore.getStart(input.runId));

      assert.equal(result._tag, "Failure");
      assert.equal(intent.state, "indeterminate");
      assert.equal(intent.outcomeCode, "run_start_dispatching_projection_incomplete");
    }),
  );

  it.effect("reconcile-only Provider 只从已对账投影补齐 receipt 且不再次启动", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-dispatching-reconcile",
        previousRunId: "run-dispatching-reconcile-old",
        runId: "run-dispatching-reconcile-new",
        agentId: "agent-dispatching-reconcile",
        runtimeId: "runtime-dispatching-reconcile",
        prompt: "只读取 Provider reconcile 投影",
        workspaceRoot: "C:/workspace/dispatching-reconcile",
      };
      const seeded = yield* seedDispatchingStart({
        store,
        runStartStore,
        ...input,
        status: "running",
        runtimeTaskId: "runtime-task-dispatching-reconcile",
      });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: {
          mode: "reconcile-only",
          after: "provider-sessions.reconcile",
          requiredReceipt: "runtime-task-and-handshake-when-granted",
        },
        startTask: () => Effect.die("已对账投影恢复不得再次启动 Driver"),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        makeRunStartRecoveryInputStore(input.taskId, input.prompt, input.workspaceRoot),
        runStartStore,
      );

      const recovered = yield* orchestrator.recoverRunStart(seeded.request);
      const intent = Option.getOrThrow(yield* runStartStore.getStart(input.runId));

      assert.equal(recovered.task.status, "running");
      assert.equal(recovered.run.runtimeTaskId, "runtime-task-dispatching-reconcile");
      assert.equal(intent.state, "settled");
      assert.equal(intent.runtimeTaskId, "runtime-task-dispatching-reconcile");
    }),
  );

  it.effect("reconcile-only Driver 的早到终态只结算 receipt 而不复活任务", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-dispatching-terminal",
        previousRunId: "run-dispatching-terminal-old",
        runId: "run-dispatching-terminal-new",
        agentId: "agent-dispatching-terminal",
        runtimeId: "runtime-dispatching-terminal",
        prompt: "保留早到终态",
        workspaceRoot: "C:/workspace/dispatching-terminal",
      };
      const seeded = yield* seedDispatchingStart({
        store,
        runStartStore,
        ...input,
        status: "completed",
        runtimeTaskId: "runtime-task-dispatching-terminal",
      });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: {
          mode: "reconcile-only",
          after: "provider-sessions.reconcile",
          requiredReceipt: "runtime-task-and-handshake-when-granted",
        },
        startTask: () => Effect.die("终态恢复不得再次启动 Driver"),
        cancelTask: () => Effect.succeed({ status: "already_terminal" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        makeRunStartRecoveryInputStore(input.taskId, input.prompt, input.workspaceRoot),
        runStartStore,
      );

      const recovered = yield* orchestrator.recoverRunStart(seeded.request);

      assert.equal(recovered.task.status, "completed");
      assert.equal(recovered.run.status, "completed");
      assert.equal(Option.getOrThrow(yield* runStartStore.getStart(input.runId)).state, "settled");
    }),
  );
});
