import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CompositionGoalLoopRetryStoreLive } from "../persistence/Layers/CompositionGoalLoopRetryStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CompositionGoalLoopRetryStore } from "../persistence/Services/CompositionGoalLoopRetryStore.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import type { CompositionTaskStoreShape } from "../persistence/Services/CompositionTaskStore.ts";
import { goalLoopEventPrefix } from "./CompositionGoalLoopRunner.ts";
import { settleAndRedispatchInterruptedGoalLoop } from "./CompositionGoalLoopRedispatch.ts";

const layer = it.layer(
  Layer.mergeAll(CompositionTaskStoreLive, CompositionGoalLoopRetryStoreLive).pipe(
    Layer.provide(SqlitePersistenceMemory),
  ),
);

const goalRowEffect = (input: {
  readonly store: CompositionTaskStoreShape;
  readonly taskId: string;
  readonly runId: string;
  readonly suffix: string;
  readonly summary: string;
}) =>
  input.store.appendEventIfNew({
    taskId: input.taskId,
    runId: input.runId,
    agentId: "agent-goal-redispatch",
    runtimeId: "runtime-goal-redispatch",
    sourceEventId: `${goalLoopEventPrefix(input.taskId, input.runId)}:${input.suffix}`,
    status: "running",
    sequence: 0,
    eventType: "status",
    summary: input.summary,
  });

const persistStartedRetry = (
  store: CompositionTaskStoreShape,
  input: {
    readonly taskId: string;
    readonly previousRunId: string;
    readonly newRunId: string;
    readonly nowUnixMs: number;
  },
) =>
  Effect.gen(function* () {
    const task = Option.getOrThrow(yield* store.getTask(input.taskId));
    const previousRun = Option.getOrThrow(yield* store.getRun(input.previousRunId));
    const { finishedAtUnixMs: _finishedAtUnixMs, ...taskWithoutFinishedAt } = task;
    yield* store.upsertTask({
      ...taskWithoutFinishedAt,
      status: "running",
      updatedAtUnixMs: input.nowUnixMs,
    });
    yield* store.upsertRun({
      taskId: input.taskId,
      runId: input.newRunId,
      agentId: previousRun.agentId,
      runtimeId: previousRun.runtimeId,
      status: "running",
      attempt: previousRun.attempt + 1,
      capabilityGrantIds: [],
    });
  });

layer("CompositionGoalLoopRedispatchRecovery", (it) => {
  it.effect("结算后派发崩溃时保留 settled，并在重入时复用账本中的稳定 newRunId", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const retryStore = yield* CompositionGoalLoopRetryStore;
      const taskId = "task-goal-redispatch-resume";
      const runId = "run-goal-redispatch-resume-old";
      const newRunId = "run-goal-redispatch-resume-stable";
      yield* store.upsertTask({
        taskId,
        projectId: "project-goal-redispatch",
        assigneeKind: "agent",
        assigneeId: "agent-goal-redispatch",
        mode: "serial",
        status: "running",
        promptDigest: "sha256:goal-redispatch-resume",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
      });
      yield* store.upsertRun({
        taskId,
        runId,
        agentId: "agent-goal-redispatch",
        runtimeId: "runtime-goal-redispatch",
        status: "running",
        attempt: 1,
        capabilityGrantIds: [],
      });
      yield* goalRowEffect({ store, taskId, runId, suffix: "start", summary: "目标循环开始" });
      yield* goalRowEffect({ store, taskId, runId, suffix: "round:1", summary: "第 1 轮" });

      const first = yield* Effect.result(
        settleAndRedispatchInterruptedGoalLoop({
          taskId,
          runId,
          newRunId,
          agentId: "agent-goal-redispatch",
          runtimeId: "runtime-goal-redispatch",
          store,
          retryStore,
          nowUnixMs: 5_000,
          redispatch: () => Effect.fail("simulated_dispatch_crash"),
        }),
      );

      assert.equal(first._tag, "Failure");
      assert.equal(Option.getOrThrow(yield* retryStore.getIntent(runId)).phase, "settled");
      assert.equal(Option.getOrThrow(yield* store.getRun(runId)).status, "failed");

      let recoveredRunId: string | undefined;
      const recovered = yield* settleAndRedispatchInterruptedGoalLoop({
        taskId,
        runId,
        newRunId: "run-goal-redispatch-resume-ignored",
        agentId: "agent-goal-redispatch",
        runtimeId: "runtime-goal-redispatch",
        store,
        retryStore,
        nowUnixMs: 6_000,
        redispatch: (args) =>
          Effect.gen(function* () {
            recoveredRunId = args.newRunId;
            yield* persistStartedRetry(store, {
              taskId,
              previousRunId: args.previousRunId,
              newRunId: args.newRunId,
              nowUnixMs: 6_001,
            });
          }),
      });

      assert.equal(recovered.newRunId, newRunId);
      assert.equal(recoveredRunId, newRunId);
      assert.equal(Option.getOrThrow(yield* retryStore.getIntent(runId)).phase, "dispatched");
      assert.equal(
        (yield* store.listEvents(taskId, runId)).filter((event) =>
          event.sourceEventId?.endsWith(":supervisor:redispatch"),
        ).length,
        1,
      );
    }),
  );

  it.effect("重派回调返回但稳定新 Run 仍为 queued 时保持 settled", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const retryStore = yield* CompositionGoalLoopRetryStore;
      const taskId = "task-goal-redispatch-queued";
      const runId = "run-goal-redispatch-queued-old";
      const newRunId = "run-goal-redispatch-queued-new";
      yield* store.upsertTask({
        taskId,
        projectId: "project-goal-redispatch",
        assigneeKind: "agent",
        assigneeId: "agent-goal-redispatch",
        mode: "serial",
        status: "running",
        promptDigest: "sha256:goal-redispatch-queued",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
      });
      yield* store.upsertRun({
        taskId,
        runId,
        agentId: "agent-goal-redispatch",
        runtimeId: "runtime-goal-redispatch",
        status: "running",
        attempt: 1,
        capabilityGrantIds: [],
      });
      yield* goalRowEffect({ store, taskId, runId, suffix: "start", summary: "目标循环开始" });

      const error = yield* Effect.flip(
        settleAndRedispatchInterruptedGoalLoop({
          taskId,
          runId,
          newRunId,
          agentId: "agent-goal-redispatch",
          store,
          retryStore,
          nowUnixMs: 5_000,
          redispatch: () =>
            store.upsertRun({
              taskId,
              runId: newRunId,
              agentId: "agent-goal-redispatch",
              runtimeId: "runtime-goal-redispatch",
              status: "queued",
              attempt: 2,
              capabilityGrantIds: [],
            }),
        }),
      );

      if (error._tag !== "CompositionGoalLoopRedispatchError") {
        assert.fail("Expected a CompositionGoalLoopRedispatchError");
      }
      assert.equal(error.code, "goal_loop_redispatch_run_not_started");
      assert.equal(Option.getOrThrow(yield* retryStore.getIntent(runId)).phase, "settled");
    }),
  );

  it.effect("稳定新 Run 的 task/attempt 身份不一致时保持 settled", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const retryStore = yield* CompositionGoalLoopRetryStore;
      const taskId = "task-goal-redispatch-identity";
      const runId = "run-goal-redispatch-identity-old";
      const newRunId = "run-goal-redispatch-identity-new";
      yield* store.upsertTask({
        taskId,
        projectId: "project-goal-redispatch",
        assigneeKind: "agent",
        assigneeId: "agent-goal-redispatch",
        mode: "serial",
        status: "running",
        promptDigest: "sha256:goal-redispatch-identity",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
      });
      yield* store.upsertRun({
        taskId,
        runId,
        agentId: "agent-goal-redispatch",
        runtimeId: "runtime-goal-redispatch",
        status: "running",
        attempt: 3,
        capabilityGrantIds: [],
      });
      yield* goalRowEffect({ store, taskId, runId, suffix: "start", summary: "目标循环开始" });

      const error = yield* Effect.flip(
        settleAndRedispatchInterruptedGoalLoop({
          taskId,
          runId,
          newRunId,
          agentId: "agent-goal-redispatch",
          store,
          retryStore,
          nowUnixMs: 5_000,
          redispatch: () =>
            store.upsertRun({
              taskId,
              runId: newRunId,
              agentId: "agent-goal-redispatch",
              runtimeId: "runtime-goal-redispatch",
              status: "running",
              attempt: 3,
              capabilityGrantIds: [],
            }),
        }),
      );

      if (error._tag !== "CompositionGoalLoopRedispatchError") {
        assert.fail("Expected a CompositionGoalLoopRedispatchError");
      }
      assert.equal(error.code, "goal_loop_redispatch_run_identity_mismatch");
      assert.equal(Option.getOrThrow(yield* retryStore.getIntent(runId)).phase, "settled");
    }),
  );

  it.effect("已有同身份 running 新 Run 时直接推进 dispatched，不重复调用重派回调", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const retryStore = yield* CompositionGoalLoopRetryStore;
      const taskId = "task-goal-redispatch-existing";
      const runId = "run-goal-redispatch-existing-old";
      const newRunId = "run-goal-redispatch-existing-new";
      yield* store.upsertTask({
        taskId,
        projectId: "project-goal-redispatch",
        assigneeKind: "agent",
        assigneeId: "agent-goal-redispatch",
        mode: "serial",
        status: "failed",
        promptDigest: "sha256:goal-redispatch-existing",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
        finishedAtUnixMs: 2,
      });
      yield* store.upsertRun({
        taskId,
        runId,
        agentId: "agent-goal-redispatch",
        runtimeId: "runtime-goal-redispatch",
        status: "failed",
        attempt: 1,
        capabilityGrantIds: [],
        failureCode: "goal_loop_interrupted",
        finishedAtUnixMs: 2,
      });
      const prepared = yield* retryStore.prepareIntent({
        taskId,
        previousRunId: runId,
        newRunId,
        createdAtUnixMs: 3,
      });
      yield* retryStore.markSettled({
        previousRunId: runId,
        expectedRevision: prepared.revision,
        updatedAtUnixMs: 4,
      });
      yield* persistStartedRetry(store, {
        taskId,
        previousRunId: runId,
        newRunId,
        nowUnixMs: 5,
      });

      let invoked = false;
      const result = yield* settleAndRedispatchInterruptedGoalLoop({
        taskId,
        runId,
        newRunId: "run-goal-redispatch-existing-ignored",
        agentId: "agent-goal-redispatch",
        store,
        retryStore,
        nowUnixMs: 6,
        redispatch: () =>
          Effect.sync(() => {
            invoked = true;
          }),
      });

      assert.equal(result.newRunId, newRunId);
      assert.isFalse(invoked);
      assert.equal(Option.getOrThrow(yield* retryStore.getIntent(runId)).phase, "dispatched");
    }),
  );
});
