import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CompositionGoalLoopRetryStoreLive } from "../persistence/Layers/CompositionGoalLoopRetryStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CompositionGoalLoopRetryStore } from "../persistence/Services/CompositionGoalLoopRetryStore.ts";
import type {
  CompositionTaskInputStoreShape,
  CompositionTaskRecoveryInput,
} from "../persistence/Services/CompositionTaskInputStore.ts";
import {
  CompositionTaskStore,
  type CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import { goalLoopEventPrefix } from "./CompositionGoalLoopRunner.ts";
import { settleInterruptedGoalLoop } from "./CompositionGoalLoopSettlement.ts";
import {
  recoverCompositionGoalLoopRetries,
  type CompositionGoalLoopRetryStartupRecoveryOptions,
} from "./CompositionGoalLoopRetryStartupRecovery.ts";
import { makeCompositionOrchestrator } from "./CompositionOrchestrator.ts";

const layer = it.layer(
  Layer.mergeAll(CompositionTaskStoreLive, CompositionGoalLoopRetryStoreLive).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const AGENT_ID = "agent-goal-loop-startup-recovery";
const RUNTIME_ID = "runtime-goal-loop-startup-recovery";
const CAPABILITY_IDS = ["t3.workspace.read_file"] as const;

const recoveryInput = (taskId: string): CompositionTaskRecoveryInput => ({
  taskId,
  prompt: `恢复 ${taskId}`,
  workspaceRoot: `C:/workspace/${taskId}`,
  workspaceRootDigest: `sha256:workspace:${taskId}`,
  model: "provider/model",
  capabilityIds: CAPABILITY_IDS,
});

const makeInputStore = (
  inputs: Map<string, CompositionTaskRecoveryInput>,
): CompositionTaskInputStoreShape => ({
  save: (input) =>
    Effect.sync(() => {
      inputs.set(input.taskId, input);
    }),
  get: (taskId) => Effect.succeed(Option.fromNullishOr(inputs.get(taskId))),
  remove: () => Effect.void,
});

const appendGoalEvent = (input: {
  readonly store: CompositionTaskStoreShape;
  readonly taskId: string;
  readonly runId: string;
  readonly suffix: string;
  readonly summary: string;
}) =>
  input.store.appendEventIfNew({
    taskId: input.taskId,
    runId: input.runId,
    agentId: AGENT_ID,
    runtimeId: RUNTIME_ID,
    sourceEventId: `${goalLoopEventPrefix(input.taskId, input.runId)}:${input.suffix}`,
    status: "running",
    sequence: 0,
    eventType: "status",
    summary: input.summary,
  });

const seedInterruptedGoalLoop = (input: {
  readonly store: CompositionTaskStoreShape;
  readonly taskId: string;
  readonly runId: string;
  readonly parentTaskId?: string;
}) =>
  Effect.gen(function* () {
    yield* input.store.upsertTask({
      taskId: input.taskId,
      projectId: "project-goal-loop-startup-recovery",
      ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
      assigneeKind: "agent",
      assigneeId: AGENT_ID,
      mode: "serial",
      status: "running",
      promptDigest: `sha256:prompt:${input.taskId}`,
      dependsOnTaskIds: [],
      createdAtUnixMs: 100,
      updatedAtUnixMs: 110,
    });
    yield* input.store.upsertRun({
      taskId: input.taskId,
      runId: input.runId,
      agentId: AGENT_ID,
      runtimeId: RUNTIME_ID,
      status: "running",
      attempt: 1,
      capabilityGrantIds: [],
    });
    yield* appendGoalEvent({ ...input, suffix: "start", summary: "目标循环开始" });
    yield* appendGoalEvent({ ...input, suffix: "round:1", summary: "第 1 轮" });
  });

const makeRecoveryOptions = (
  store: CompositionTaskStoreShape,
  retryStore: CompositionGoalLoopRetryStartupRecoveryOptions["retryStore"],
  inputs: Map<string, CompositionTaskRecoveryInput>,
) =>
  Effect.gen(function* () {
    const starts: Array<{
      readonly taskId: string;
      readonly runId: string;
      readonly prompt?: string;
      readonly workspaceRoot?: string;
      readonly capabilityGrantIds?: ReadonlyArray<string>;
    }> = [];
    const registry = makeCompositionAgentDriverRegistry();
    yield* registry.register({
      agentId: AGENT_ID,
      runtimeId: RUNTIME_ID,
      startTask: (input) =>
        Effect.sync(() => {
          starts.push({
            taskId: input.task.taskId,
            runId: input.run.runId,
            ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
            ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
            ...(input.capabilityGrantIds === undefined
              ? {}
              : { capabilityGrantIds: [...input.capabilityGrantIds] }),
          });
          return { runtimeTaskId: `runtime-task:${input.run.runId}` };
        }),
      cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
    });
    const inputStore = makeInputStore(inputs);
    const orchestrator = makeCompositionOrchestrator(store, registry, undefined, inputStore);
    return {
      options: {
        store,
        retryStore,
        inputStore,
        orchestrator,
        recoveredAtUnixMs: 5_000,
      } satisfies CompositionGoalLoopRetryStartupRecoveryOptions,
      starts,
    };
  });

layer("CompositionGoalLoopRetryStartupRecovery", (it) => {
  it.effect("prepared intent 在启动时完成旧 Run 结算并派发稳定新 Run", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const retryStore = yield* CompositionGoalLoopRetryStore;
      const taskId = "task-goal-loop-startup-prepared";
      const previousRunId = "run-goal-loop-startup-prepared-old";
      const newRunId = "run-goal-loop-startup-prepared-new";
      const parentTaskId = "task-goal-loop-startup-parent";
      yield* seedInterruptedGoalLoop({ store, taskId, runId: previousRunId, parentTaskId });
      yield* retryStore.prepareIntent({
        taskId,
        previousRunId,
        newRunId,
        createdAtUnixMs: 1_000,
      });
      const input = recoveryInput(taskId);
      const harness = yield* makeRecoveryOptions(store, retryStore, new Map([[taskId, input]]));

      const receipt = yield* recoverCompositionGoalLoopRetries(harness.options);

      assert.deepEqual(receipt.previousRunIds, [previousRunId]);
      assert.equal(
        Option.getOrThrow(yield* retryStore.getIntent(previousRunId)).phase,
        "dispatched",
      );
      assert.equal(Option.getOrThrow(yield* store.getRun(previousRunId)).status, "failed");
      assert.equal(Option.getOrThrow(yield* store.getRun(newRunId)).status, "running");
      assert.equal(Option.getOrThrow(yield* store.getTask(taskId)).status, "running");
      assert.deepEqual(harness.starts, [
        {
          taskId,
          runId: newRunId,
          prompt: input.prompt,
          workspaceRoot: input.workspaceRoot,
          capabilityGrantIds: [],
        },
      ]);
      const settlement = (yield* store.listEvents(taskId, previousRunId)).find((event) =>
        event.sourceEventId?.endsWith(":supervisor:redispatch"),
      );
      assert.equal(settlement?.parentTaskId, parentTaskId);
      assert.equal(settlement?.runtimeId, RUNTIME_ID);
    }),
  );

  it.effect("settled intent 在启动时跳过重复结算并直接恢复派发", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const retryStore = yield* CompositionGoalLoopRetryStore;
      const taskId = "task-goal-loop-startup-settled";
      const previousRunId = "run-goal-loop-startup-settled-old";
      const newRunId = "run-goal-loop-startup-settled-new";
      yield* seedInterruptedGoalLoop({ store, taskId, runId: previousRunId });
      yield* retryStore.prepareIntent({
        taskId,
        previousRunId,
        newRunId,
        createdAtUnixMs: 2_000,
      });
      yield* settleInterruptedGoalLoop({
        taskId,
        runId: previousRunId,
        agentId: AGENT_ID,
        runtimeId: RUNTIME_ID,
        store,
        nowUnixMs: 2_100,
        decision: "redispatch",
        staleFailureCode: "goal_loop_interrupted",
      });
      yield* retryStore.markSettled({ previousRunId, updatedAtUnixMs: 2_100 });
      const input = recoveryInput(taskId);
      const harness = yield* makeRecoveryOptions(store, retryStore, new Map([[taskId, input]]));

      const receipt = yield* recoverCompositionGoalLoopRetries(harness.options);

      assert.equal(receipt.recoveredCount, 1);
      assert.equal(Option.getOrThrow(yield* store.getRun(newRunId)).status, "running");
      assert.equal(
        (yield* store.listEvents(taskId, previousRunId)).filter((event) =>
          event.sourceEventId?.endsWith(":supervisor:redispatch"),
        ).length,
        1,
      );
    }),
  );

  it.effect("已有稳定 queued 新 Run 时复用原 Run 与 grant 并推进到 running", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const retryStore = yield* CompositionGoalLoopRetryStore;
      const taskId = "task-goal-loop-startup-queued";
      const previousRunId = "run-goal-loop-startup-queued-old";
      const newRunId = "run-goal-loop-startup-queued-new";
      yield* seedInterruptedGoalLoop({ store, taskId, runId: previousRunId });
      yield* retryStore.prepareIntent({
        taskId,
        previousRunId,
        newRunId,
        createdAtUnixMs: 3_000,
      });
      const settled = yield* settleInterruptedGoalLoop({
        taskId,
        runId: previousRunId,
        agentId: AGENT_ID,
        runtimeId: RUNTIME_ID,
        store,
        nowUnixMs: 3_100,
        decision: "redispatch",
        staleFailureCode: "goal_loop_interrupted",
      });
      yield* retryStore.markSettled({ previousRunId, updatedAtUnixMs: 3_100 });
      const { finishedAtUnixMs: _finishedAtUnixMs, ...taskWithoutFinishedAt } = settled.task;
      yield* store.upsertTask({
        ...taskWithoutFinishedAt,
        status: "queued",
        updatedAtUnixMs: 3_200,
      });
      yield* store.upsertRun({
        taskId,
        runId: newRunId,
        agentId: AGENT_ID,
        runtimeId: RUNTIME_ID,
        status: "queued",
        attempt: 2,
        capabilityGrantIds: ["grant-existing"],
      });
      const input = recoveryInput(taskId);
      const harness = yield* makeRecoveryOptions(store, retryStore, new Map([[taskId, input]]));

      yield* recoverCompositionGoalLoopRetries(harness.options);

      const recoveredRun = Option.getOrThrow(yield* store.getRun(newRunId));
      assert.equal(recoveredRun.status, "running");
      assert.deepEqual(recoveredRun.capabilityGrantIds, ["grant-existing"]);
      assert.deepEqual(
        harness.starts.map((start) => start.capabilityGrantIds),
        [["grant-existing"]],
      );
    }),
  );
});
