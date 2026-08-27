import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import { goalLoopEventPrefix } from "./CompositionGoalLoopRunner.ts";
import {
  settleAndAbandonInterruptedGoalLoop,
  settleAndRedispatchInterruptedGoalLoop,
} from "./CompositionGoalLoopRedispatch.ts";
import { makeCompositionOrchestrator } from "./CompositionOrchestrator.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import type { CompositionTaskStoreShape } from "../persistence/Services/CompositionTaskStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

const layer = it.layer(CompositionTaskStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

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

const makeRedispatchable = (store: CompositionTaskStoreShape) =>
  Effect.gen(function* () {
    const driverRegistry = makeCompositionAgentDriverRegistry();
    yield* driverRegistry.register({
      agentId: "agent-goal-redispatch",
      runtimeId: "runtime-goal-redispatch",
      startTask: () => Effect.succeed({ runtimeTaskId: "runtime-task-goal-redispatch" }),
      cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
    });
    return makeCompositionOrchestrator(store, driverRegistry, undefined, {
      save: () => Effect.void,
      get: () =>
        Effect.succeed(
          Option.some({
            taskId: "task-goal-redispatch",
            prompt: "跨重启自动重派目标",
            workspaceRoot: "C:/workspace/goal-redispatch",
          }),
        ),
      remove: () => Effect.void,
    });
  });

layer("CompositionGoalLoopRedispatch", (it) => {
  it.effect("未收敛循环结算后自动重派：陈旧 run/task 落 failed 并创建新 Run", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const taskId = "task-goal-redispatch";
      const runId = "run-goal-redispatch-stale";
      yield* store.upsertTask({
        taskId,
        projectId: "project-goal-redispatch",
        assigneeKind: "agent",
        assigneeId: "agent-goal-redispatch",
        mode: "serial",
        status: "running",
        promptDigest: "sha256:goal-redispatch",
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
      yield* goalRowEffect({ store, taskId, runId, suffix: "round:2", summary: "第 2 轮" });
      yield* goalRowEffect({ store, taskId, runId, suffix: "reject:1", summary: "被拒" });

      let redispatchArgs:
        | { readonly previousRunId: string; readonly interruptedRounds: number }
        | undefined;
      const result = yield* settleAndRedispatchInterruptedGoalLoop({
        taskId,
        runId,
        agentId: "agent-goal-redispatch",
        runtimeId: "runtime-goal-redispatch",
        store,
        nowUnixMs: 5_000,
        note: "跨重启自动重派",
        redispatch: (args) =>
          Effect.sync(() => {
            redispatchArgs = args;
          }),
      });

      assert.equal(result.scan.interrupted, true);
      assert.equal(result.run.status, "failed");
      assert.equal(result.run.failureCode, "goal_loop_interrupted");
      assert.equal(result.task.status, "failed");
      assert.deepEqual(redispatchArgs, { previousRunId: runId, interruptedRounds: 2 });

      const events = yield* store.listEvents(taskId, runId);
      const supervisorRow = events.find((event) =>
        event.sourceEventId?.endsWith(":supervisor:redispatch"),
      );
      assert.isDefined(supervisorRow);
      assert.equal(supervisorRow?.status, "blocked");
      assert.isTrue(supervisorRow?.summary.includes("已完成 2 轮"));
      assert.isTrue(supervisorRow?.summary.includes("跨重启自动重派"));
    }),
  );

  it.effect("重派回调接入真实 orchestrator.retryTask 时能创建新 Run 并重新派发", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const taskId = "task-goal-redispatch-real";
      const runId = "run-goal-redispatch-real-stale";
      yield* store.upsertTask({
        taskId,
        projectId: "project-goal-redispatch",
        assigneeKind: "agent",
        assigneeId: "agent-goal-redispatch",
        mode: "serial",
        status: "running",
        promptDigest: "sha256:goal-redispatch-real",
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
      yield* goalRowEffect({ store, taskId, runId, suffix: "round:3", summary: "第 3 轮" });

      const orchestrator = yield* makeRedispatchable(store);
      yield* settleAndRedispatchInterruptedGoalLoop({
        taskId,
        runId,
        agentId: "agent-goal-redispatch",
        runtimeId: "runtime-goal-redispatch",
        store,
        nowUnixMs: 5_000,
        redispatch: (args) =>
          Effect.asVoid(
            orchestrator.retryTask({
              taskId,
              previousRunId: args.previousRunId,
              runId: "run-goal-redispatch-real-next",
              reason: "supervisor 自动重派",
              capabilityIds: ["t3.workspace.read_file"],
            }),
          ),
      });

      const nextRun = yield* store.getRun("run-goal-redispatch-real-next");
      assert.isTrue(Option.isSome(nextRun));
      const staleRun = (yield* store.getRun(runId)).pipe(Option.getOrThrow);
      assert.equal(staleRun.status, "failed");
      assert.equal(staleRun.failureCode, "goal_loop_interrupted");
      const task = (yield* store.getTask(taskId)).pipe(Option.getOrThrow);
      // 重派成功后任务从 failed 回到进行态。
      assert.equal(task.status, "running");
    }),
  );

  it.effect("已收敛循环拒绝自动重派且不落任何结算行", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const taskId = "task-goal-redispatch-converged";
      const runId = "run-goal-redispatch-converged";
      yield* store.upsertTask({
        taskId,
        projectId: "project-goal-redispatch",
        assigneeKind: "agent",
        assigneeId: "agent-goal-redispatch",
        mode: "serial",
        status: "running",
        promptDigest: "sha256:goal-converged",
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
      yield* goalRowEffect({
        store,
        taskId,
        runId,
        suffix: "terminal:completed",
        summary: "目标循环完成",
      });

      let invoked = false;
      const error = yield* Effect.flip(
        settleAndRedispatchInterruptedGoalLoop({
          taskId,
          runId,
          agentId: "agent-goal-redispatch",
          store,
          nowUnixMs: 5_000,
          redispatch: () =>
            Effect.sync(() => {
              invoked = true;
            }),
        }),
      );
      if (error._tag !== "CompositionGoalLoopSupervisorError") {
        assert.fail("Expected a CompositionGoalLoopSupervisorError");
      }
      assert.equal(error.code, "goal_loop_supervisor_not_interrupted");
      assert.isFalse(invoked);
      const events = yield* store.listEvents(taskId, runId);
      assert.equal(
        events.filter((event) => event.sourceEventId?.includes(":supervisor:")).length,
        0,
      );
    }),
  );

  it.effect("不是最新 Run 时拒绝自动重派且不落结算行", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const taskId = "task-goal-redispatch-stale-latest";
      const runId = "run-goal-redispatch-old";
      yield* store.upsertTask({
        taskId,
        projectId: "project-goal-redispatch",
        assigneeKind: "agent",
        assigneeId: "agent-goal-redispatch",
        mode: "serial",
        status: "running",
        promptDigest: "sha256:goal-stale-latest",
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
      yield* store.upsertRun({
        taskId,
        runId: "run-goal-redispatch-newer",
        agentId: "agent-goal-redispatch",
        runtimeId: "runtime-goal-redispatch",
        status: "running",
        attempt: 2,
        capabilityGrantIds: [],
      });
      yield* goalRowEffect({ store, taskId, runId, suffix: "start", summary: "目标循环开始" });
      yield* goalRowEffect({ store, taskId, runId, suffix: "round:1", summary: "第 1 轮" });

      let invoked = false;
      const error = yield* Effect.flip(
        settleAndRedispatchInterruptedGoalLoop({
          taskId,
          runId,
          agentId: "agent-goal-redispatch",
          store,
          nowUnixMs: 5_000,
          redispatch: () =>
            Effect.sync(() => {
              invoked = true;
            }),
        }),
      );
      if (error._tag !== "CompositionGoalLoopRedispatchError") {
        assert.fail("Expected a CompositionGoalLoopRedispatchError");
      }
      assert.equal(error.code, "goal_loop_redispatch_not_latest");
      assert.isFalse(invoked);
      const events = yield* store.listEvents(taskId, runId);
      assert.equal(
        events.filter((event) => event.sourceEventId?.includes(":supervisor:")).length,
        0,
      );
      // 陈旧 Run 未被动过。
      const staleRun = (yield* store.getRun(runId)).pipe(Option.getOrThrow);
      assert.equal(staleRun.status, "running");
    }),
  );

  it.effect("放弃结算落 supervisor:abandon 行并把陈旧 run/task 落 failed 且不创建新 Run", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const taskId = "task-goal-abandon";
      const runId = "run-goal-abandon-stale";
      yield* store.upsertTask({
        taskId,
        projectId: "project-goal-redispatch",
        assigneeKind: "agent",
        assigneeId: "agent-goal-redispatch",
        mode: "serial",
        status: "running",
        promptDigest: "sha256:goal-abandon",
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
      yield* goalRowEffect({ store, taskId, runId, suffix: "round:2", summary: "第 2 轮" });

      const result = yield* settleAndAbandonInterruptedGoalLoop({
        taskId,
        runId,
        agentId: "agent-goal-redispatch",
        runtimeId: "runtime-goal-redispatch",
        store,
        nowUnixMs: 5_000,
        note: "控制中心放弃结算",
      });

      assert.equal(result.scan.interrupted, true);
      assert.equal(result.run.status, "failed");
      assert.equal(result.run.failureCode, "goal_loop_abandoned");
      assert.equal(result.task.status, "failed");

      const events = yield* store.listEvents(taskId, runId);
      const supervisorRow = events.find((event) =>
        event.sourceEventId?.endsWith(":supervisor:abandon"),
      );
      assert.isDefined(supervisorRow);
      // abandon 结算行按监督语义落 failed（区别于 redispatch 的 blocked）。
      assert.equal(supervisorRow?.status, "failed");
      assert.isTrue(supervisorRow?.summary.includes("已完成 2 轮"));
      assert.isTrue(supervisorRow?.summary.includes("控制中心放弃结算"));

      // 放弃结算不创建新 Run，最新 Run 仍是被收口的陈旧 Run。
      const latestRun = yield* store.getLatestRun(taskId);
      if (Option.isNone(latestRun)) {
        assert.fail("Expected the stale run to stay latest");
      }
      assert.equal(latestRun.value.runId, runId);
    }),
  );

  it.effect("已收敛循环拒绝放弃结算且不落任何结算行", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const taskId = "task-goal-abandon-converged";
      const runId = "run-goal-abandon-converged";
      yield* store.upsertTask({
        taskId,
        projectId: "project-goal-redispatch",
        assigneeKind: "agent",
        assigneeId: "agent-goal-redispatch",
        mode: "serial",
        status: "running",
        promptDigest: "sha256:goal-abandon-converged",
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
      yield* goalRowEffect({
        store,
        taskId,
        runId,
        suffix: "terminal:completed",
        summary: "目标循环完成",
      });

      const error = yield* Effect.flip(
        settleAndAbandonInterruptedGoalLoop({
          taskId,
          runId,
          agentId: "agent-goal-redispatch",
          store,
          nowUnixMs: 5_000,
        }),
      );
      if (error._tag !== "CompositionGoalLoopSupervisorError") {
        assert.fail("Expected a CompositionGoalLoopSupervisorError");
      }
      assert.equal(error.code, "goal_loop_supervisor_not_interrupted");
      const events = yield* store.listEvents(taskId, runId);
      assert.equal(
        events.filter((event) => event.sourceEventId?.includes(":supervisor:")).length,
        0,
      );
      const staleRun = (yield* store.getRun(runId)).pipe(Option.getOrThrow);
      assert.equal(staleRun.status, "running");
    }),
  );
});
