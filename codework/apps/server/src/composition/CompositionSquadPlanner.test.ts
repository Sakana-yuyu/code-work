import { expect, it } from "@effect/vitest";
import type {
  CompositionSquad,
  CompositionTask,
  CompositionTaskEvent,
  CompositionTaskRun,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CompositionTaskAlreadyExistsError } from "./CompositionOrchestrator.ts";
import {
  encodeCompositionSquadPlanOutput,
  type CompositionSquadPlanNode,
} from "./CompositionSquadPlan.ts";
import {
  makeCompositionSquadPlanner,
  type CompositionSquadPlanningInput,
} from "./CompositionSquadPlanner.ts";

const squad: CompositionSquad = {
  squadId: "squad-planner",
  name: "规划协同组",
  leaderAgentId: "agent-leader",
  memberAgentIds: ["agent-leader", "agent-worker", "agent-reviewer"],
  instructions: "实现完成后必须由 Reviewer 核对。",
  revision: 4,
  collaborationMode: "dependency_graph",
  members: [
    {
      agentId: "agent-leader",
      role: "leader",
      order: 0,
      required: true,
      model: "provider/leader-model",
      workspaceRoot: "C:/workspace/leader",
      capabilityIds: ["t3.workspace.read_file"],
      maxConcurrentTasks: 1,
    },
    {
      agentId: "agent-worker",
      role: "worker",
      order: 1,
      required: true,
      model: "provider/worker-model",
      workspaceRoot: "C:/workspace/worker",
      capabilityIds: ["t3.workspace.read_file", "t3.workspace.write_file"],
      maxConcurrentTasks: 2,
    },
    {
      agentId: "agent-reviewer",
      role: "reviewer",
      order: 2,
      required: true,
      model: "provider/reviewer-model",
      workspaceRoot: "C:/workspace/reviewer",
      capabilityIds: ["t3.workspace.read_file"],
      maxConcurrentTasks: 1,
    },
  ],
  maxConcurrency: 2,
  maxRetries: 1,
  failurePolicy: "fail_fast",
  partialSuccessPolicy: "reject",
  approvalStages: ["before_finalize"],
  createdAtUnixMs: 100,
  updatedAtUnixMs: 400,
};

const input: CompositionSquadPlanningInput = {
  executionId: "execution-planner-1",
  squad,
  projectId: "project-1",
  threadId: "thread-1",
  goal: "实现功能并完成独立审查",
  workspaceRoot: "C:/workspace/default",
};

const completedPlanJson = encodeCompositionSquadPlanOutput([
  {
    nodeId: "implement",
    agentId: "agent-worker",
    prompt: "完成实现并运行聚焦测试",
    dependsOnNodeIds: [],
  },
  {
    nodeId: "review",
    agentId: "agent-reviewer",
    prompt: "独立审查实现与测试证据",
    dependsOnNodeIds: ["implement"],
  },
]);

const encodePlan = (nodes: ReadonlyArray<CompositionSquadPlanNode>): string =>
  encodeCompositionSquadPlanOutput(nodes);

const invalidCases: ReadonlyArray<{
  readonly output: string;
  readonly code: string;
}> = [
  {
    output:
      '{"schemaVersion":1,"nodes":[{"nodeId":"invalid node","agentId":"agent-worker","prompt":"非法标识","dependsOnNodeIds":[]}]}',
    code: "squad_plan_output_invalid",
  },
  {
    output:
      '{"schemaVersion":1,"nodes":[{"nodeId":"empty","agentId":"agent-worker","prompt":"   ","dependsOnNodeIds":[]}]}',
    code: "squad_plan_output_invalid",
  },
  {
    output: encodePlan([
      {
        nodeId: "duplicate",
        agentId: "agent-worker",
        prompt: "第一次实现",
        dependsOnNodeIds: [],
      },
      {
        nodeId: "duplicate",
        agentId: "agent-reviewer",
        prompt: "重复节点",
        dependsOnNodeIds: [],
      },
    ]),
    code: "squad_plan_duplicate_node",
  },
  {
    output: encodePlan([
      {
        nodeId: "leader-work",
        agentId: "agent-leader",
        prompt: "错误地把执行任务派给 Leader",
        dependsOnNodeIds: [],
      },
    ]),
    code: "squad_member_missing",
  },
  {
    output: encodePlan([
      {
        nodeId: "foreign",
        agentId: "agent-foreign",
        prompt: "越权任务",
        dependsOnNodeIds: [],
      },
    ]),
    code: "squad_member_missing",
  },
  {
    output: encodePlan([
      {
        nodeId: "self",
        agentId: "agent-worker",
        prompt: "自依赖任务",
        dependsOnNodeIds: ["self"],
      },
    ]),
    code: "dependency_cycle",
  },
  {
    output: encodePlan([
      {
        nodeId: "review",
        agentId: "agent-reviewer",
        prompt: "审查",
        dependsOnNodeIds: ["missing"],
      },
    ]),
    code: "dependency_node_missing",
  },
  {
    output: encodePlan([
      {
        nodeId: "implement",
        agentId: "agent-worker",
        prompt: "实现",
        dependsOnNodeIds: ["review"],
      },
      {
        nodeId: "review",
        agentId: "agent-reviewer",
        prompt: "审查",
        dependsOnNodeIds: ["implement"],
      },
    ]),
    code: "dependency_cycle",
  },
];

const makeHarness = (output = completedPlanJson) => {
  const tasks = new Map<string, CompositionTask>();
  const runs = new Map<string, CompositionTaskRun>();
  const events = new Map<string, ReadonlyArray<CompositionTaskEvent>>();
  const dispatches: Array<{
    readonly taskId: string;
    readonly runId: string;
    readonly assigneeKind: "agent" | "squad";
    readonly assigneeId: string;
    readonly prompt?: string;
    readonly capabilityIds?: ReadonlyArray<string>;
  }> = [];

  const planner = makeCompositionSquadPlanner({
    orchestrator: {
      dispatchTask: (dispatch) =>
        Effect.sync(() => {
          dispatches.push(dispatch);
          const task: CompositionTask = {
            taskId: dispatch.taskId,
            projectId: dispatch.projectId,
            ...(dispatch.threadId === undefined ? {} : { threadId: dispatch.threadId }),
            assigneeKind: dispatch.assigneeKind,
            assigneeId: dispatch.assigneeId,
            mode: dispatch.mode,
            status: "running",
            promptDigest: dispatch.promptDigest,
            dependsOnTaskIds: [...dispatch.dependsOnTaskIds],
            createdAtUnixMs: 1,
            updatedAtUnixMs: 1,
          };
          const run: CompositionTaskRun = {
            runId: dispatch.runId,
            taskId: dispatch.taskId,
            agentId: dispatch.assigneeId,
            runtimeId: "runtime-leader",
            status: "running",
            attempt: 1,
            capabilityGrantIds: [],
          };
          tasks.set(task.taskId, task);
          runs.set(run.runId, run);
          events.set(`${task.taskId}\u0000${run.runId}`, [
            {
              taskId: task.taskId,
              runId: run.runId,
              agentId: run.agentId,
              runtimeId: run.runtimeId,
              status: "running",
              sequence: 1,
              eventType: "message",
              summary: "Leader 输出计划",
              outputDelta: output.slice(0, 30),
            },
            {
              taskId: task.taskId,
              runId: run.runId,
              agentId: run.agentId,
              runtimeId: run.runtimeId,
              status: "running",
              sequence: 2,
              eventType: "message",
              summary: "Leader 输出计划",
              outputDelta: output.slice(30),
            },
          ]);
          return { task, run };
        }),
    },
    runtime: {
      awaitTaskCompletion: ({ runId }) =>
        Effect.sync(() => {
          const current = runs.get(runId)!;
          const completed = {
            ...current,
            status: "completed" as const,
            finishedAtUnixMs: 2,
            resultSummary: "Provider Runtime 已完成任务",
          };
          runs.set(runId, completed);
          const task = tasks.get(current.taskId)!;
          tasks.set(task.taskId, {
            ...task,
            status: "completed",
            updatedAtUnixMs: 2,
            finishedAtUnixMs: 2,
          });
          return completed;
        }),
    },
    store: {
      getTask: (taskId) => Effect.succeed(Option.fromNullishOr(tasks.get(taskId))),
      getRun: (runId) => Effect.succeed(Option.fromNullishOr(runs.get(runId))),
      listEvents: (taskId, runId) => Effect.succeed(events.get(`${taskId}\u0000${runId}`) ?? []),
    },
  });

  return { planner, tasks, runs, events, dispatches };
};

it.effect("Leader 使用稳定 Task/Run 身份生成计划，并以最小权限直接派发给 Leader Agent", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const plan = yield* harness.planner.plan(input);

    expect(plan.map((node) => node.nodeId)).toEqual(["implement", "review"]);
    expect(harness.dispatches).toHaveLength(1);
    expect(harness.dispatches[0]).toMatchObject({
      taskId: "execution-planner-1:squad:squad-planner:r4:task:leader-plan",
      runId: "execution-planner-1:squad:squad-planner:r4:run:leader-plan:1",
      assigneeKind: "agent",
      assigneeId: "agent-leader",
      capabilityIds: [],
    });
    expect(harness.dispatches[0]?.prompt).toContain('"agentId":"agent-worker"');
    expect(harness.dispatches[0]?.prompt).toContain('"schemaVersion":1');
  }),
);

it.effect("重复规划请求复用已完成的稳定运行，不重复调用外部 Agent", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const first = yield* harness.planner.plan(input);
    const second = yield* harness.planner.plan(input);

    expect(second).toEqual(first);
    expect(harness.dispatches).toHaveLength(1);
  }),
);

it.effect("并发创建竞争命中稳定 Task 后恢复既有运行，不发起第二次外部调用", () =>
  Effect.gen(function* () {
    const tasks = new Map<string, CompositionTask>();
    const runs = new Map<string, CompositionTaskRun>();
    const events = new Map<string, ReadonlyArray<CompositionTaskEvent>>();
    let dispatchCalls = 0;
    const planner = makeCompositionSquadPlanner({
      orchestrator: {
        dispatchTask: (dispatch) => {
          dispatchCalls += 1;
          const task: CompositionTask = {
            taskId: dispatch.taskId,
            projectId: dispatch.projectId,
            ...(dispatch.threadId === undefined ? {} : { threadId: dispatch.threadId }),
            assigneeKind: dispatch.assigneeKind,
            assigneeId: dispatch.assigneeId,
            mode: dispatch.mode,
            status: "completed",
            promptDigest: dispatch.promptDigest,
            dependsOnTaskIds: [],
            createdAtUnixMs: 1,
            updatedAtUnixMs: 2,
            finishedAtUnixMs: 2,
          };
          const run: CompositionTaskRun = {
            runId: dispatch.runId,
            taskId: dispatch.taskId,
            agentId: dispatch.assigneeId,
            runtimeId: "runtime-leader",
            status: "completed",
            attempt: 1,
            capabilityGrantIds: [],
            finishedAtUnixMs: 2,
          };
          tasks.set(task.taskId, task);
          runs.set(run.runId, run);
          events.set(`${task.taskId}\u0000${run.runId}`, [
            {
              taskId: task.taskId,
              runId: run.runId,
              agentId: run.agentId,
              runtimeId: run.runtimeId,
              status: "running",
              sequence: 1,
              eventType: "message",
              summary: "Leader 输出计划",
              outputDelta: completedPlanJson,
            },
          ]);
          return Effect.fail(new CompositionTaskAlreadyExistsError({ taskId: dispatch.taskId }));
        },
      },
      runtime: { awaitTaskCompletion: () => Effect.die("已完成 Run 不应等待") },
      store: {
        getTask: (taskId) => Effect.succeed(Option.fromNullishOr(tasks.get(taskId))),
        getRun: (runId) => Effect.succeed(Option.fromNullishOr(runs.get(runId))),
        listEvents: (taskId, runId) => Effect.succeed(events.get(`${taskId}\u0000${runId}`) ?? []),
      },
    });

    const plan = yield* planner.plan(input);

    expect(dispatchCalls).toBe(1);
    expect(plan.map((node) => node.nodeId)).toEqual(["implement", "review"]);
  }),
);

it.effect("Leader 输出越权 Agent、未知依赖或循环依赖时返回稳定结构化错误", () =>
  Effect.gen(function* () {
    for (const current of invalidCases) {
      const harness = makeHarness(current.output);
      const error = yield* Effect.flip(harness.planner.plan(input));
      expect(error.code).toBe(current.code);
    }
  }),
);

it.effect("Leader 输出非严格 JSON 或规划运行失败时拒绝继续派发子任务", () =>
  Effect.gen(function* () {
    const invalid = makeHarness("```json\n{}\n```");
    const parseError = yield* Effect.flip(invalid.planner.plan(input));
    expect(parseError.code).toBe("squad_plan_output_invalid");

    const failed = makeHarness();
    failed.planner = makeCompositionSquadPlanner({
      orchestrator: {
        dispatchTask: () =>
          Effect.succeed({
            task: {
              taskId: "execution-planner-1:squad:squad-planner:r4:task:leader-plan",
              projectId: "project-1",
              assigneeKind: "agent",
              assigneeId: "agent-leader",
              mode: "serial",
              status: "failed",
              promptDigest: "sha256:failed",
              dependsOnTaskIds: [],
              createdAtUnixMs: 1,
              updatedAtUnixMs: 2,
              finishedAtUnixMs: 2,
            },
            run: {
              runId: "execution-planner-1:squad:squad-planner:r4:run:leader-plan:1",
              taskId: "execution-planner-1:squad:squad-planner:r4:task:leader-plan",
              agentId: "agent-leader",
              runtimeId: "runtime-leader",
              status: "failed",
              attempt: 1,
              capabilityGrantIds: [],
              failureCode: "provider_turn_failed",
              resultSummary: "模型调用失败",
              finishedAtUnixMs: 2,
            },
          }),
      },
      runtime: { awaitTaskCompletion: () => Effect.die("终态 Run 不应等待") },
      store: {
        getTask: () => Effect.succeed(Option.none()),
        getRun: () => Effect.succeed(Option.none()),
        listEvents: () => Effect.die("失败 Run 不应读取输出"),
      },
    });
    const runError = yield* Effect.flip(failed.planner.plan(input));
    expect(runError).toMatchObject({
      code: "squad_plan_execution_failed",
      detail: expect.stringContaining("provider_turn_failed"),
    });
  }),
);
