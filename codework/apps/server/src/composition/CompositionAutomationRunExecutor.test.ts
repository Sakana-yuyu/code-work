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
  ...overrides,
});

describe("CompositionAutomationRunExecutor", () => {
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
