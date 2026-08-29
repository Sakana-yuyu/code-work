import type {
  CompositionTask,
  CompositionTaskEvent,
  CompositionTaskRun,
} from "@codework/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { CompositionDispatchInput } from "./CompositionOrchestrator.ts";
import {
  makeCompositionGoalLoopAutomationRunner,
  type CompositionGoalLoopAutomationRunnerOptions,
} from "./CompositionGoalLoopAutomationRunner.ts";

type Harness = {
  readonly options: CompositionGoalLoopAutomationRunnerOptions;
  readonly tasks: Map<string, CompositionTask>;
  readonly runs: Map<string, CompositionTaskRun>;
  readonly events: CompositionTaskEvent[];
  readonly dispatches: CompositionDispatchInput[];
};

const runtimeIds = new Map([
  ["agent-main", "runtime-main"],
  ["agent-reviewer", "runtime-reviewer"],
]);

const makeHarness = (
  outputFor: (input: CompositionDispatchInput) => string,
  now: () => number = () => 2_000,
): Harness => {
  const tasks = new Map<string, CompositionTask>();
  const runs = new Map<string, CompositionTaskRun>();
  const events: CompositionTaskEvent[] = [];
  const sourceEventIds = new Set<string>();
  const dispatches: CompositionDispatchInput[] = [];

  const options: CompositionGoalLoopAutomationRunnerOptions = {
    agents: {
      resolve: (agentId) =>
        Effect.succeed(
          Option.fromNullishOr(runtimeIds.get(agentId)).pipe(
            Option.map((runtimeId) => ({ agentId, runtimeId })),
          ),
        ),
    },
    orchestrator: {
      dispatchTask: (input) =>
        Effect.sync(() => {
          dispatches.push(input);
          const runtimeId = runtimeIds.get(input.assigneeId) ?? "runtime-unknown";
          const task: CompositionTask = {
            taskId: input.taskId,
            projectId: input.projectId,
            ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
            ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
            assigneeKind: input.assigneeKind,
            assigneeId: input.assigneeId,
            mode: input.mode,
            status: "completed",
            promptDigest: input.promptDigest,
            dependsOnTaskIds: [...input.dependsOnTaskIds],
            createdAtUnixMs: now(),
            updatedAtUnixMs: now(),
            finishedAtUnixMs: now(),
          };
          const output = outputFor(input);
          const run: CompositionTaskRun = {
            runId: input.runId,
            taskId: input.taskId,
            agentId: input.assigneeId,
            runtimeId,
            status: "completed",
            attempt: 1,
            capabilityGrantIds: [],
            startedAtUnixMs: now(),
            finishedAtUnixMs: now(),
            resultSummary: output,
          };
          tasks.set(task.taskId, task);
          runs.set(run.runId, run);
          events.push({
            taskId: task.taskId,
            runId: run.runId,
            parentTaskId: input.parentTaskId,
            agentId: run.agentId,
            runtimeId: run.runtimeId,
            status: "completed",
            sequence: 0,
            eventType: "message",
            summary: "模型输出",
            outputDelta: output,
          });
          return { task, run };
        }),
    },
    runtime: {
      awaitTaskCompletion: () => Effect.die("测试任务在派发时已进入终态"),
    },
    store: {
      getTask: (taskId) => Effect.succeed(Option.fromNullishOr(tasks.get(taskId))),
      getRun: (runId) => Effect.succeed(Option.fromNullishOr(runs.get(runId))),
      upsertTask: (task) =>
        Effect.sync(() => {
          tasks.set(task.taskId, task);
          return task;
        }),
      upsertRun: (run) =>
        Effect.sync(() => {
          runs.set(run.runId, run);
          return run;
        }),
      appendEventIfNew: (event) =>
        Effect.sync(() => {
          if (sourceEventIds.has(event.sourceEventId)) return false;
          sourceEventIds.add(event.sourceEventId);
          events.push(event);
          return true;
        }),
      listEvents: (taskId, runId) =>
        Effect.succeed(events.filter((event) => event.taskId === taskId && event.runId === runId)),
      withTransaction: (effect) => effect,
    },
    now,
  };

  return { options, tasks, runs, events, dispatches };
};

const input = {
  taskId: "automation-goal:task",
  runId: "automation-goal:run",
  projectId: "project-goal",
  threadId: "thread-goal",
  agentId: "agent-main",
  reviewerAgentId: "agent-reviewer",
  model: "gpt-5.6-sol",
  capabilityIds: ["t3.workspace.read_file", "t3.workspace.write_file"],
  workspaceRoot: "E:/workspace/goal",
  goal: "完成目标并提供验证证据",
  maxAttempts: 3,
  maxCostUnits: 3,
  stalePivotRounds: 3,
  deadlineDurationMs: 60_000,
  startedAtUnixMs: 1_000,
} as const;

describe("CompositionGoalLoopAutomationRunner", () => {
  it.effect("用稳定子任务执行 attempt，并由独立 reviewer 验证完成声明", () =>
    Effect.gen(function* () {
      const harness = makeHarness((dispatch) => {
        if (dispatch.taskId.endsWith(":review:2")) return "[[GOAL_VALID]]";
        if (dispatch.taskId.endsWith(":attempt:2")) {
          return "修复和测试已经完成 [[GOAL_COMPLETE: 聚焦测试通过]]";
        }
        return "已完成第一部分，继续处理";
      });
      const runner = makeCompositionGoalLoopAutomationRunner(harness.options);

      const result = yield* runner.run(input);

      assert.deepEqual(result, {
        goalStatus: "completed",
        automationStatus: "succeeded",
        summary: "目标循环完成（2 轮，原因：聚焦测试通过）",
      });
      assert.deepEqual(
        harness.dispatches.map((dispatch) => ({
          taskId: dispatch.taskId,
          runId: dispatch.runId,
          parentTaskId: dispatch.parentTaskId,
          assigneeId: dispatch.assigneeId,
          model: dispatch.model,
          capabilityIds: dispatch.capabilityIds,
        })),
        [
          {
            taskId: "automation-goal:task:attempt:1",
            runId: "automation-goal:run:attempt:1",
            parentTaskId: "automation-goal:task",
            assigneeId: "agent-main",
            model: "gpt-5.6-sol",
            capabilityIds: ["t3.workspace.read_file", "t3.workspace.write_file"],
          },
          {
            taskId: "automation-goal:task:attempt:2",
            runId: "automation-goal:run:attempt:2",
            parentTaskId: "automation-goal:task",
            assigneeId: "agent-main",
            model: "gpt-5.6-sol",
            capabilityIds: ["t3.workspace.read_file", "t3.workspace.write_file"],
          },
          {
            taskId: "automation-goal:task:review:2",
            runId: "automation-goal:run:review:2",
            parentTaskId: "automation-goal:task",
            assigneeId: "agent-reviewer",
            model: "gpt-5.6-sol",
            capabilityIds: [],
          },
        ],
      );
      assert.equal(harness.runs.get(input.runId)?.status, "completed");
      assert.deepEqual(
        harness.events
          .flatMap((event) => event.sourceEventId ?? [])
          .filter((sourceEventId) => sourceEventId.startsWith("goalloop:")),
        [
          "goalloop:automation-goal:task:automation-goal:run:start",
          "goalloop:automation-goal:task:automation-goal:run:round:1",
          "goalloop:automation-goal:task:automation-goal:run:round:2",
          "goalloop:automation-goal:task:automation-goal:run:terminal:completed",
        ],
      );
    }),
  );

  it.effect("reviewer 拒绝完成声明后继续下一轮并保留拒绝台账", () =>
    Effect.gen(function* () {
      const harness = makeHarness((dispatch) => {
        if (dispatch.taskId.endsWith(":review:1")) return "[[GOAL_INVALID: 缺少测试证据]]";
        if (dispatch.taskId.endsWith(":review:2")) return "[[GOAL_VALID]]";
        return `第 ${dispatch.taskId.endsWith(":attempt:1") ? 1 : 2} 轮完成 [[GOAL_COMPLETE]]`;
      });
      const runner = makeCompositionGoalLoopAutomationRunner(harness.options);

      const result = yield* runner.run(input);

      assert.equal(result.goalStatus, "completed");
      assert.deepEqual(
        harness.events.flatMap((event) => event.sourceEventId ?? []).filter((id) => id.includes(":reject:")),
        ["goalloop:automation-goal:task:automation-goal:run:reject:1"],
      );
      assert.deepEqual(
        harness.dispatches.filter((dispatch) => dispatch.taskId.includes(":review:")).map((dispatch) => dispatch.assigneeId),
        ["agent-reviewer", "agent-reviewer"],
      );
    }),
  );

  it.effect("成本耗尽与停滞 pivot 映射为可审计的父 Run 终态", () =>
    Effect.gen(function* () {
      const budgetHarness = makeHarness(() => "仍在处理");
      const budgetRunner = makeCompositionGoalLoopAutomationRunner(budgetHarness.options);
      const {
        reviewerAgentId: _budgetReviewerAgentId,
        maxCostUnits: _budgetMaxCostUnits,
        ...withoutReviewerAndCost
      } = input;
      const budget = yield* budgetRunner.run({
        ...withoutReviewerAndCost,
        maxCostUnits: 1,
      });
      assert.deepEqual(budget, {
        goalStatus: "budget_exhausted",
        automationStatus: "failed",
        summary: "目标循环因预算耗尽收敛（1 轮）",
        errorCode: "goal_loop_budget_exhausted",
      });
      assert.equal(budgetHarness.runs.get(input.runId)?.failureCode, "goal_loop_budget_exhausted");

      const pivotHarness = makeHarness(() => "输出没有变化");
      const pivotRunner = makeCompositionGoalLoopAutomationRunner(pivotHarness.options);
      const pivot = yield* pivotRunner.run({
        ...withoutReviewerAndCost,
        stalePivotRounds: 2,
      });
      assert.deepEqual(pivot, {
        goalStatus: "pivot_required",
        automationStatus: "failed",
        summary: "目标循环停滞待改派（连续 2 轮无进展）",
        errorCode: "goal_loop_pivot_required",
      });
      assert.equal(pivotHarness.runs.get(input.runId)?.status, "blocked");
    }),
  );

  it.effect("父 Run 已终态时恢复调用直接复用结果，不重复派发子任务或台账", () =>
    Effect.gen(function* () {
      const harness = makeHarness((dispatch) =>
        dispatch.taskId.includes(":review:")
          ? "[[GOAL_VALID]]"
          : "已经完成 [[GOAL_COMPLETE: 可重放]]",
      );
      const runner = makeCompositionGoalLoopAutomationRunner(harness.options);

      const first = yield* runner.run(input);
      const dispatchCount = harness.dispatches.length;
      const eventCount = harness.events.length;
      const replay = yield* makeCompositionGoalLoopAutomationRunner({
        ...harness.options,
        agents: { resolve: () => Effect.succeed(Option.none()) },
      }).run(input);

      assert.deepEqual(replay, first);
      assert.equal(harness.dispatches.length, dispatchCount);
      assert.equal(harness.events.length, eventCount);
    }),
  );
});
