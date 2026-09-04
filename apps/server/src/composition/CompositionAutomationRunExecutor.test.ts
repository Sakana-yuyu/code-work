import * as NodeCrypto from "node:crypto";

import type {
  CompositionAutomation,
  CompositionAutomationRun,
  CompositionTask,
  CompositionTaskRun,
} from "@codework/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CompositionGoalLoopAutomationRunnerError } from "./CompositionGoalLoopAutomationRunner.ts";
import { CompositionTaskAlreadyExistsError } from "./CompositionOrchestrator.ts";
import {
  makeCompositionAutomationRunExecutor,
  type CompositionAutomationRunExecutorOptions,
} from "./CompositionAutomationRunExecutor.ts";

const sha256 = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

const makeAutomation = (
  executionContext: CompositionAutomation["target"]["executionContext"] = {
    mode: "isolated",
    workspaceRoot: "E:/workspace/automation-agent",
    archiveOnFinish: true,
  },
): CompositionAutomation => ({
  automationId: "automation-agent",
  projectId: "project-agent",
  name: "Agent Automation",
  prompt: "检查代码并修复问题",
  cadence: { type: "every", intervalMs: 60_000 },
  target: {
    type: "agent",
    agentId: "agent-codex",
    model: "gpt-5.6",
    capabilityIds: ["t3.workspace.read_file", "t3.workspace.write_file"],
    executionContext,
  },
  status: "active",
  revision: 1,
  maxRuns: 10,
  runCount: 1,
  createdAtUnixMs: 100,
  updatedAtUnixMs: 1_000,
  nextRunAtUnixMs: 61_000,
  lastRunAtUnixMs: 1_000,
  pausedAtUnixMs: null,
  expiresAtUnixMs: null,
});

const makeSquadAutomation = (): CompositionAutomation => ({
  ...makeAutomation(),
  automationId: "automation-squad",
  name: "Squad Automation",
  target: {
    type: "squad",
    squadId: "squad-review",
    squadRevision: 7,
    executionContext: { mode: "existing_thread", threadId: "thread-squad" },
  },
});

const makeGoalLoopAutomation = (): CompositionAutomation => ({
  ...makeAutomation(),
  automationId: "automation-goal-loop",
  name: "Goal Loop Automation",
  prompt: "持续修复问题，直到通过独立评审",
  target: {
    type: "goal_loop",
    agentId: "agent-codex",
    reviewerAgentId: "agent-reviewer",
    model: "gpt-5.6",
    capabilityIds: ["t3.workspace.read_file", "t3.workspace.write_file"],
    maxAttempts: 4,
    maxCostUnits: 8,
    stalePivotRounds: 2,
    deadlineDurationMs: 120_000,
    executionContext: { mode: "existing_thread", threadId: "thread-goal-loop" },
  },
});

const automationRun: CompositionAutomationRun = {
  automationRunId: "automation-run-agent",
  automationId: "automation-agent",
  automationRevision: 1,
  scheduledForUnixMs: 1_000,
  idempotencyKey: "automation-agent:1000",
  trigger: "scheduled",
  status: "running",
  attempt: 1,
  requestedAtUnixMs: 1_000,
  startedAtUnixMs: 1_100,
  finishedAtUnixMs: null,
  compositionTaskId: "automation-run-agent:task",
  compositionRunId: "automation-run-agent:run",
  outputSummary: null,
  errorCode: null,
  errorDetail: null,
};

const goalLoopAutomationRun: CompositionAutomationRun = {
  ...automationRun,
  automationRunId: "automation-run-goal-loop",
  automationId: "automation-goal-loop",
  idempotencyKey: "automation-goal-loop:1000",
  compositionTaskId: "automation-run-goal-loop:task",
  compositionRunId: "automation-run-goal-loop:run",
};

const makeTask = (overrides: Partial<CompositionTask> = {}): CompositionTask => ({
  taskId: "automation-run-agent:task",
  projectId: "project-agent",
  assigneeKind: "agent",
  assigneeId: "agent-codex",
  mode: "serial",
  status: "running",
  promptDigest: sha256("检查代码并修复问题"),
  dependsOnTaskIds: [],
  createdAtUnixMs: 1_100,
  updatedAtUnixMs: 1_100,
  ...overrides,
});

const makeRun = (overrides: Partial<CompositionTaskRun> = {}): CompositionTaskRun => ({
  runId: "automation-run-agent:run",
  taskId: "automation-run-agent:task",
  agentId: "agent-codex",
  runtimeId: "runtime-codex",
  status: "running",
  attempt: 1,
  capabilityGrantIds: ["grant-read", "grant-write"],
  startedAtUnixMs: 1_100,
  ...overrides,
});

const makeOptions = (
  overrides: Partial<CompositionAutomationRunExecutorOptions> = {},
): CompositionAutomationRunExecutorOptions => ({
  orchestrator: {
    dispatchTask: () => Effect.succeed({ task: makeTask(), run: makeRun() }),
  },
  store: {
    getTask: () => Effect.succeed(Option.none()),
    getRun: () => Effect.succeed(Option.none()),
  },
  contexts: {
    resolve: () => Effect.succeed({ workspaceRoot: "E:/workspace/automation-agent" }),
  },
  agent: {
    runtime: {
      awaitTaskCompletion: () => Effect.die("默认测试不应执行 Agent 后台观察任务"),
    },
    background: {
      ensure: () => Effect.succeed("started" as const),
    },
    runs: {
      saveRunTransition: (input) => Effect.succeed(input.run),
    },
  },
  ...overrides,
});

describe("CompositionAutomationRunExecutor", () => {
  it.effect("Agent Automation 后台等待 Composition 终态并回写成功历史", () =>
    Effect.gen(function* () {
      let backgroundWork: Effect.Effect<void, never> | undefined;
      let waitInput: { readonly taskId: string; readonly runId: string } | undefined;
      let transition:
        | Parameters<
            NonNullable<
              CompositionAutomationRunExecutorOptions["agent"]
            >["runs"]["saveRunTransition"]
          >[0]
        | undefined;
      const executor = makeCompositionAutomationRunExecutor(
        makeOptions({
          agent: {
            runtime: {
              awaitTaskCompletion: (input) =>
                Effect.sync(() => {
                  waitInput = input;
                  return makeRun({
                    status: "completed",
                    finishedAtUnixMs: 1_900,
                    resultSummary: "Agent 已完成检查并修复问题",
                  });
                }),
            },
            background: {
              ensure: (automationRunId, work) =>
                Effect.sync(() => {
                  assert.equal(automationRunId, automationRun.automationRunId);
                  backgroundWork = work;
                  return "started" as const;
                }),
            },
            runs: {
              saveRunTransition: (input) =>
                Effect.sync(() => {
                  transition = input;
                  return input.run;
                }),
            },
            now: () => 2_000,
          },
        }),
      );

      yield* executor.ensureStarted({ automation: makeAutomation(), run: automationRun });

      assert.isUndefined(waitInput);
      assert.isDefined(backgroundWork);
      yield* backgroundWork!;
      assert.deepEqual(waitInput, {
        taskId: "automation-run-agent:task",
        runId: "automation-run-agent:run",
      });
      assert.deepEqual(transition, {
        expectedStatus: "running",
        run: {
          ...automationRun,
          status: "succeeded",
          finishedAtUnixMs: 2_000,
          outputSummary: "Agent 已完成检查并修复问题",
          errorCode: null,
          errorDetail: null,
        },
      });
    }),
  );

  it.effect("恢复已完成的 Agent Composition Run 时不重复派发并立即回写", () =>
    Effect.gen(function* () {
      let dispatches = 0;
      let backgroundWork: Effect.Effect<void, never> | undefined;
      let transition: CompositionAutomationRun | undefined;
      const completedRun = makeRun({
        status: "completed",
        finishedAtUnixMs: 1_900,
        resultSummary: "已持久化的 Agent 完成结果",
      });
      const executor = makeCompositionAutomationRunExecutor(
        makeOptions({
          orchestrator: {
            dispatchTask: () =>
              Effect.sync(() => void (dispatches += 1)).pipe(
                Effect.as({ task: makeTask(), run: makeRun() }),
              ),
          },
          store: {
            getTask: () => Effect.succeed(Option.some(makeTask({ status: "completed" }))),
            getRun: () => Effect.succeed(Option.some(completedRun)),
          },
          agent: {
            runtime: {
              awaitTaskCompletion: () => Effect.die("已完成 Run 不应再次等待"),
            },
            background: {
              ensure: (_automationRunId, work) =>
                Effect.sync(() => {
                  backgroundWork = work;
                  return "started" as const;
                }),
            },
            runs: {
              saveRunTransition: (input) =>
                Effect.sync(() => {
                  transition = input.run;
                  return input.run;
                }),
            },
            now: () => 2_000,
          },
        }),
      );

      yield* executor.ensureStarted({ automation: makeAutomation(), run: automationRun });

      assert.equal(dispatches, 0);
      assert.isDefined(backgroundWork);
      yield* backgroundWork!;
      assert.deepEqual(transition, {
        ...automationRun,
        status: "succeeded",
        finishedAtUnixMs: 2_000,
        outputSummary: "已持久化的 Agent 完成结果",
        errorCode: null,
        errorDetail: null,
      });
    }),
  );

  it.effect("Agent 取消、待评审和超时终态不会继续停留 running", () =>
    Effect.gen(function* () {
      const terminalRuns = [
        makeRun({
          status: "cancelled",
          failureCode: "user_cancelled",
          resultSummary: "用户取消了 Agent 任务",
        }),
        makeRun({
          status: "in_review",
          resultSummary: "Agent 已提交结果，等待人工评审",
        }),
        makeRun({
          status: "timed_out",
          failureCode: "agent_deadline_exceeded",
          resultSummary: "Agent 执行超过截止时间",
        }),
      ];
      const transitions: CompositionAutomationRun[] = [];
      let terminalIndex = 0;
      const executor = makeCompositionAutomationRunExecutor(
        makeOptions({
          agent: {
            runtime: {
              awaitTaskCompletion: () => Effect.succeed(terminalRuns[terminalIndex++]!),
            },
            background: {
              ensure: (_automationRunId, work) => work.pipe(Effect.as("started" as const)),
            },
            runs: {
              saveRunTransition: (input) =>
                Effect.sync(() => {
                  transitions.push(input.run);
                  return input.run;
                }),
            },
            now: () => 2_000 + terminalIndex,
          },
        }),
      );

      yield* executor.ensureStarted({ automation: makeAutomation(), run: automationRun });
      yield* executor.ensureStarted({ automation: makeAutomation(), run: automationRun });
      yield* executor.ensureStarted({ automation: makeAutomation(), run: automationRun });

      assert.deepEqual(
        transitions.map((run) => ({
          status: run.status,
          outputSummary: run.outputSummary,
          errorCode: run.errorCode,
          errorDetail: run.errorDetail,
        })),
        [
          {
            status: "cancelled",
            outputSummary: "用户取消了 Agent 任务",
            errorCode: "user_cancelled",
            errorDetail: "用户取消了 Agent 任务",
          },
          {
            status: "failed",
            outputSummary: "Agent 已提交结果，等待人工评审",
            errorCode: "automation_agent_review_required",
            errorDetail: "Agent 已提交结果，等待人工评审",
          },
          {
            status: "failed",
            outputSummary: "Agent 执行超过截止时间",
            errorCode: "agent_deadline_exceeded",
            errorDetail: "Agent 执行超过截止时间",
          },
        ],
      );
    }),
  );

  it.effect("Goal Loop Automation 在后台启动并把稳定身份、预算和评审配置传入运行器", () =>
    Effect.gen(function* () {
      let backgroundWork: Effect.Effect<void, never> | undefined;
      let goalLoopInput:
        | Parameters<
            NonNullable<CompositionAutomationRunExecutorOptions["goalLoop"]>["runner"]["run"]
          >[0]
        | undefined;
      let transition:
        | Parameters<
            NonNullable<
              CompositionAutomationRunExecutorOptions["goalLoop"]
            >["runs"]["saveRunTransition"]
          >[0]
        | undefined;
      const executor = makeCompositionAutomationRunExecutor(
        makeOptions({
          contexts: {
            resolve: () =>
              Effect.succeed({
                workspaceRoot: "E:/workspace/goal-loop",
                threadId: "thread-goal-loop",
              }),
          },
          goalLoop: {
            runner: {
              run: (input) =>
                Effect.sync(() => {
                  goalLoopInput = input;
                  return {
                    goalStatus: "completed" as const,
                    automationStatus: "succeeded" as const,
                    summary: "目标循环完成（2 轮，独立评审通过）",
                  };
                }),
            },
            background: {
              ensure: (automationRunId, work) =>
                Effect.sync(() => {
                  assert.equal(automationRunId, goalLoopAutomationRun.automationRunId);
                  backgroundWork = work;
                  return "started" as const;
                }),
            },
            runs: {
              saveRunTransition: (input) =>
                Effect.sync(() => {
                  transition = input;
                  return input.run;
                }),
            },
            now: () => 2_000,
          },
        }),
      );

      yield* executor.ensureStarted({
        automation: makeGoalLoopAutomation(),
        run: goalLoopAutomationRun,
      });

      assert.isUndefined(goalLoopInput);
      assert.isDefined(backgroundWork);
      yield* backgroundWork!;
      assert.deepEqual(goalLoopInput, {
        taskId: "automation-run-goal-loop:task",
        runId: "automation-run-goal-loop:run",
        projectId: "project-agent",
        threadId: "thread-goal-loop",
        agentId: "agent-codex",
        reviewerAgentId: "agent-reviewer",
        model: "gpt-5.6",
        capabilityIds: ["t3.workspace.read_file", "t3.workspace.write_file"],
        workspaceRoot: "E:/workspace/goal-loop",
        goal: "持续修复问题，直到通过独立评审",
        maxAttempts: 4,
        maxCostUnits: 8,
        stalePivotRounds: 2,
        deadlineDurationMs: 120_000,
        startedAtUnixMs: 1_100,
      });
      assert.deepEqual(transition, {
        expectedStatus: "running",
        run: {
          ...goalLoopAutomationRun,
          status: "succeeded",
          finishedAtUnixMs: 2_000,
          outputSummary: "目标循环完成（2 轮，独立评审通过）",
          errorCode: null,
          errorDetail: null,
        },
      });
    }),
  );

  it.effect("Goal Loop 预算耗尽和取消保留稳定终态与错误码", () =>
    Effect.gen(function* () {
      const transitions: CompositionAutomationRun[] = [];
      const results = [
        {
          goalStatus: "budget_exhausted" as const,
          automationStatus: "failed" as const,
          summary: "目标循环因预算耗尽收敛（4 轮）",
          errorCode: "goal_loop_budget_exhausted",
        },
        {
          goalStatus: "cancelled" as const,
          automationStatus: "cancelled" as const,
          summary: "目标循环已取消（2 轮）",
          errorCode: "goal_loop_cancelled",
        },
      ];
      let resultIndex = 0;
      const executor = makeCompositionAutomationRunExecutor(
        makeOptions({
          goalLoop: {
            runner: {
              run: () => Effect.succeed(results[resultIndex++]!),
            },
            background: {
              ensure: (_automationRunId, work) => work.pipe(Effect.as("started" as const)),
            },
            runs: {
              saveRunTransition: (input) =>
                Effect.sync(() => {
                  transitions.push(input.run);
                  return input.run;
                }),
            },
            now: () => 2_000 + resultIndex,
          },
        }),
      );

      yield* executor.ensureStarted({
        automation: makeGoalLoopAutomation(),
        run: goalLoopAutomationRun,
      });
      yield* executor.ensureStarted({
        automation: makeGoalLoopAutomation(),
        run: { ...goalLoopAutomationRun, automationRunId: "automation-run-goal-loop-cancelled" },
      });

      assert.deepEqual(
        transitions.map((run) => ({
          status: run.status,
          outputSummary: run.outputSummary,
          errorCode: run.errorCode,
          errorDetail: run.errorDetail,
        })),
        [
          {
            status: "failed",
            outputSummary: "目标循环因预算耗尽收敛（4 轮）",
            errorCode: "goal_loop_budget_exhausted",
            errorDetail: "目标循环因预算耗尽收敛（4 轮）",
          },
          {
            status: "cancelled",
            outputSummary: "目标循环已取消（2 轮）",
            errorCode: "goal_loop_cancelled",
            errorDetail: "目标循环已取消（2 轮）",
          },
        ],
      );
    }),
  );

  it.effect("Goal Loop 执行异常回写原始稳定错误码和详情", () =>
    Effect.gen(function* () {
      let transition: CompositionAutomationRun | undefined;
      const executor = makeCompositionAutomationRunExecutor(
        makeOptions({
          goalLoop: {
            runner: {
              run: () =>
                Effect.fail(
                  new CompositionGoalLoopAutomationRunnerError({
                    code: "goal_loop_agent_driver_unavailable",
                    detail: "执行 Agent Driver 当前离线。",
                    retryable: true,
                  }),
                ),
            },
            background: {
              ensure: (_automationRunId, work) => work.pipe(Effect.as("started" as const)),
            },
            runs: {
              saveRunTransition: (input) =>
                Effect.sync(() => {
                  transition = input.run;
                  return input.run;
                }),
            },
            now: () => 2_000,
          },
        }),
      );

      yield* executor.ensureStarted({
        automation: makeGoalLoopAutomation(),
        run: goalLoopAutomationRun,
      });

      assert.deepEqual(transition, {
        ...goalLoopAutomationRun,
        status: "failed",
        finishedAtUnixMs: 2_000,
        outputSummary: null,
        errorCode: "goal_loop_agent_driver_unavailable",
        errorDetail: "执行 Agent Driver 当前离线。",
      });
    }),
  );

  it.effect("Squad Automation 固定 revision 后台启动并在完成后回写运行结果", () =>
    Effect.gen(function* () {
      let backgroundWork: Effect.Effect<void, never> | undefined;
      let squadInput:
        | Parameters<
            NonNullable<CompositionAutomationRunExecutorOptions["squad"]>["runner"]["run"]
          >[0]
        | undefined;
      let transition:
        | Parameters<
            NonNullable<
              CompositionAutomationRunExecutorOptions["squad"]
            >["runs"]["saveRunTransition"]
          >[0]
        | undefined;
      const executor = makeCompositionAutomationRunExecutor(
        makeOptions({
          contexts: {
            resolve: () =>
              Effect.succeed({
                workspaceRoot: "E:/workspace/squad",
                threadId: "thread-squad",
              }),
          },
          squad: {
            runner: {
              run: (input) =>
                Effect.sync(() => {
                  squadInput = input;
                  const leaderTask = makeTask({ taskId: "squad-leader-task" });
                  const leaderRun = makeRun({
                    runId: "squad-leader-run",
                    taskId: leaderTask.taskId,
                    resultSummary: "Squad 已完成代码审查并给出结论",
                  });
                  return {
                    executionId: input.executionId,
                    squadId: input.squadId,
                    squadRevision: input.squadRevision,
                    graph: { leader: { task: leaderTask, run: leaderRun }, children: [] },
                  };
                }),
            },
            background: {
              ensure: (automationRunId, work) =>
                Effect.sync(() => {
                  assert.equal(automationRunId, automationRun.automationRunId);
                  backgroundWork = work;
                  return "started" as const;
                }),
            },
            runs: {
              saveRunTransition: (input) =>
                Effect.sync(() => {
                  transition = input;
                  return input.run;
                }),
            },
            now: () => 2_000,
          },
        }),
      );

      yield* executor.ensureStarted({ automation: makeSquadAutomation(), run: automationRun });

      assert.isUndefined(squadInput);
      assert.isDefined(backgroundWork);
      yield* backgroundWork!;
      assert.deepEqual(squadInput, {
        executionId: automationRun.automationRunId,
        squadId: "squad-review",
        squadRevision: 7,
        projectId: "project-agent",
        threadId: "thread-squad",
        goal: "检查代码并修复问题",
        workspaceRoot: "E:/workspace/squad",
      });
      assert.deepEqual(transition, {
        expectedStatus: "running",
        run: {
          ...automationRun,
          status: "succeeded",
          finishedAtUnixMs: 2_000,
          outputSummary: "Squad 已完成代码审查并给出结论",
          errorCode: null,
          errorDetail: null,
        },
      });
    }),
  );

  it.effect("Agent Automation 使用稳定身份和解析后的上下文派发 Composition Task", () =>
    Effect.gen(function* () {
      const dispatches: Parameters<
        CompositionAutomationRunExecutorOptions["orchestrator"]["dispatchTask"]
      >[0][] = [];
      const executor = makeCompositionAutomationRunExecutor(
        makeOptions({
          orchestrator: {
            dispatchTask: (input) =>
              Effect.sync(() => {
                dispatches.push(input);
                return { task: makeTask({ threadId: "thread-existing" }), run: makeRun() };
              }),
          },
          contexts: {
            resolve: () =>
              Effect.succeed({
                workspaceRoot: "E:/workspace/worktree",
                threadId: "thread-existing",
              }),
          },
        }),
      );

      yield* executor.ensureStarted({
        automation: makeAutomation({ mode: "existing_thread", threadId: "thread-existing" }),
        run: automationRun,
      });

      assert.deepEqual(dispatches, [
        {
          taskId: "automation-run-agent:task",
          runId: "automation-run-agent:run",
          projectId: "project-agent",
          threadId: "thread-existing",
          assigneeKind: "agent",
          assigneeId: "agent-codex",
          mode: "serial",
          promptDigest: sha256("检查代码并修复问题"),
          dependsOnTaskIds: [],
          workspaceRoot: "E:/workspace/worktree",
          prompt: "检查代码并修复问题",
          model: "gpt-5.6",
          capabilityIds: ["t3.workspace.read_file", "t3.workspace.write_file"],
        },
      ]);
    }),
  );

  it.effect("同一稳定 Task/Run 已存在时不重复派发", () =>
    Effect.gen(function* () {
      let dispatches = 0;
      const executor = makeCompositionAutomationRunExecutor(
        makeOptions({
          orchestrator: {
            dispatchTask: () =>
              Effect.sync(() => void (dispatches += 1)).pipe(
                Effect.as({
                  task: makeTask(),
                  run: makeRun(),
                }),
              ),
          },
          store: {
            getTask: () => Effect.succeed(Option.some(makeTask())),
            getRun: () => Effect.succeed(Option.some(makeRun())),
          },
        }),
      );

      yield* executor.ensureStarted({ automation: makeAutomation(), run: automationRun });

      assert.equal(dispatches, 0);
    }),
  );

  it.effect("仅存在一侧或持久化身份不一致时拒绝重放", () =>
    Effect.gen(function* () {
      const executor = makeCompositionAutomationRunExecutor(
        makeOptions({
          store: {
            getTask: () => Effect.succeed(Option.some(makeTask({ assigneeId: "agent-other" }))),
            getRun: () => Effect.succeed(Option.none()),
          },
        }),
      );

      const error = yield* executor
        .ensureStarted({ automation: makeAutomation(), run: automationRun })
        .pipe(Effect.flip);

      assert.equal(error.code, "automation_composition_identity_conflict");
      assert.equal(error.retryable, false);
    }),
  );

  it.effect("并发派发已创建 Task 后重读匹配身份并幂等成功", () =>
    Effect.gen(function* () {
      let task: CompositionTask | undefined;
      let run: CompositionTaskRun | undefined;
      const executor = makeCompositionAutomationRunExecutor(
        makeOptions({
          orchestrator: {
            dispatchTask: () =>
              Effect.gen(function* () {
                task = makeTask();
                run = makeRun();
                return yield* new CompositionTaskAlreadyExistsError({
                  taskId: "automation-run-agent:task",
                });
              }),
          },
          store: {
            getTask: () => Effect.succeed(Option.fromNullishOr(task)),
            getRun: () => Effect.succeed(Option.fromNullishOr(run)),
          },
        }),
      );

      yield* executor.ensureStarted({ automation: makeAutomation(), run: automationRun });
    }),
  );

  it.effect("派发得到可重试失败 Run 时保留失败分类", () =>
    Effect.gen(function* () {
      const executor = makeCompositionAutomationRunExecutor(
        makeOptions({
          orchestrator: {
            dispatchTask: () =>
              Effect.succeed({
                task: makeTask({ status: "failed" }),
                run: makeRun({
                  status: "failed",
                  failureCode: "capacity_exceeded",
                  resultSummary: "当前并发槽已满",
                }),
              }),
          },
        }),
      );

      const error = yield* executor
        .ensureStarted({ automation: makeAutomation(), run: automationRun })
        .pipe(Effect.flip);

      assert.equal(error.code, "capacity_exceeded");
      assert.equal(error.detail, "当前并发槽已满");
      assert.equal(error.retryable, true);
    }),
  );
});
