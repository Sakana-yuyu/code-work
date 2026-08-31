import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import { CompositionRunStartStore } from "../persistence/Services/CompositionRunStartStore.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import { makeCompositionOrchestrator } from "./CompositionOrchestrator.ts";
import {
  compositionOrchestratorRunStartTestLayer,
  makeRunStartRecoveryInputStore,
} from "./CompositionOrchestratorRunStartTestSupport.ts";
import { seedDispatchingStart } from "./CompositionRetryRunStartDispatchRecoveryTestSupport.ts";

const layer = it.layer(compositionOrchestratorRunStartTestLayer);

const recoveryPolicy = {
  mode: "idempotent-replay" as const,
  capabilityGrantReplay: { mode: "verified" as const },
  requiredReceipt: "runtime-task-and-handshake-when-granted" as const,
};

layer("Composition Retry Run Start Consistency", (it) => {
  it.effect("Driver accepted 后 Task 先进入终态时不得同步 receipt 或 settle", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-dispatching-task-terminal-race",
        previousRunId: "run-dispatching-task-terminal-race-old",
        runId: "run-dispatching-task-terminal-race-new",
        agentId: "agent-dispatching-task-terminal-race",
        runtimeId: "runtime-dispatching-task-terminal-race",
        prompt: "Task 终态竞争不得结算",
        workspaceRoot: "C:/workspace/dispatching-task-terminal-race",
      };
      const seeded = yield* seedDispatchingStart({ store, runStartStore, ...input });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: recoveryPolicy,
        startTask: ({ task }) =>
          store
            .upsertTask({
              ...task,
              status: "completed",
              updatedAtUnixMs: 20,
              finishedAtUnixMs: 20,
            })
            .pipe(
              Effect.orDie,
              Effect.as({ runtimeTaskId: "runtime-task-dispatching-task-terminal-race" }),
            ),
        cancelTask: () => Effect.succeed({ status: "already_terminal" as const }),
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
      const task = Option.getOrThrow(yield* store.getTask(input.taskId));
      const run = Option.getOrThrow(yield* store.getRun(input.runId));

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.instanceOf(result.failure, PersistenceSqlError);
      assert.equal(intent.state, "accepted");
      assert.equal(task.status, "completed");
      assert.equal(run.status, "queued");
      assert.equal(run.runtimeTaskId, undefined);
    }),
  );

  it.effect("Driver accepted 后 Run 先进入终态时不得同步 receipt 或 settle", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-dispatching-run-terminal-race",
        previousRunId: "run-dispatching-run-terminal-race-old",
        runId: "run-dispatching-run-terminal-race-new",
        agentId: "agent-dispatching-run-terminal-race",
        runtimeId: "runtime-dispatching-run-terminal-race",
        prompt: "Run 终态竞争不得结算",
        workspaceRoot: "C:/workspace/dispatching-run-terminal-race",
      };
      const seeded = yield* seedDispatchingStart({ store, runStartStore, ...input });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: recoveryPolicy,
        startTask: ({ run }) =>
          store
            .upsertRun({
              ...run,
              status: "completed",
              startedAtUnixMs: 19,
              finishedAtUnixMs: 20,
            })
            .pipe(
              Effect.orDie,
              Effect.as({ runtimeTaskId: "runtime-task-dispatching-run-terminal-race" }),
            ),
        cancelTask: () => Effect.succeed({ status: "already_terminal" as const }),
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
      const task = Option.getOrThrow(yield* store.getTask(input.taskId));
      const run = Option.getOrThrow(yield* store.getRun(input.runId));

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.instanceOf(result.failure, PersistenceSqlError);
      assert.equal(intent.state, "accepted");
      assert.equal(task.status, "queued");
      assert.equal(run.status, "completed");
      assert.equal(run.runtimeTaskId, undefined);
    }),
  );

  it.effect("Task assigneeKind 不是 agent 时拒绝匹配 dispatching intent", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-dispatching-assignee-kind",
        previousRunId: "run-dispatching-assignee-kind-old",
        runId: "run-dispatching-assignee-kind-new",
        agentId: "shared-assignee-id",
        runtimeId: "runtime-dispatching-assignee-kind",
        prompt: "拒绝 squad 假阳性",
        workspaceRoot: "C:/workspace/dispatching-assignee-kind",
      };
      const seeded = yield* seedDispatchingStart({
        store,
        runStartStore,
        ...input,
        status: "running",
        runtimeTaskId: "runtime-task-dispatching-assignee-kind",
      });
      const task = Option.getOrThrow(yield* store.getTask(input.taskId));
      yield* store.upsertTask({ ...task, assigneeKind: "squad" });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: {
          mode: "fail-closed",
          reasonCode: "runtime_start_replay_not_verified",
          requiredReceipt: "runtime-task-and-handshake-when-granted",
        },
        startTask: () => Effect.die("assigneeKind 冲突时不得触发 Driver"),
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

  it.effect("Driver accepted 后 Task assigneeKind 漂移时不得同步 receipt 或 settle", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-dispatching-assignee-kind-race",
        previousRunId: "run-dispatching-assignee-kind-race-old",
        runId: "run-dispatching-assignee-kind-race-new",
        agentId: "agent-dispatching-assignee-kind-race",
        runtimeId: "runtime-dispatching-assignee-kind-race",
        prompt: "Driver accepted 后拒绝 assigneeKind 漂移",
        workspaceRoot: "C:/workspace/dispatching-assignee-kind-race",
      };
      const seeded = yield* seedDispatchingStart({ store, runStartStore, ...input });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: recoveryPolicy,
        startTask: ({ task }) =>
          store
            .upsertTask({ ...task, assigneeKind: "squad" })
            .pipe(
              Effect.orDie,
              Effect.as({ runtimeTaskId: "runtime-task-dispatching-assignee-kind-race" }),
            ),
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
      const task = Option.getOrThrow(yield* store.getTask(input.taskId));
      const run = Option.getOrThrow(yield* store.getRun(input.runId));

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.instanceOf(result.failure, PersistenceSqlError);
      assert.equal(intent.state, "accepted");
      assert.equal(task.assigneeKind, "squad");
      assert.equal(task.status, "queued");
      assert.equal(run.status, "queued");
      assert.equal(run.runtimeTaskId, undefined);
    }),
  );
});
