import * as NodeCrypto from "node:crypto";

import { expect, it } from "@effect/vitest";
import type {
  CompositionSquad,
  CompositionTask,
  CompositionTaskEvent,
  CompositionTaskRun,
} from "@codework/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import {
  CompositionAgentDriverFailure,
  type CompositionDispatchInput,
  CompositionTaskAlreadyExistsError,
} from "./CompositionOrchestrator.ts";
import {
  encodeCompositionSquadPlanOutput,
  type CompositionSquadPlanNode,
} from "./CompositionSquadPlan.ts";
import {
  makeCompositionSquadPlanner,
  makeCompositionSquadPlanningPrompt,
  type CompositionSquadPlanningCancellationReceipt,
  type CompositionSquadPlanningInput,
} from "./CompositionSquadPlanner.ts";
import { CompositionTaskRuntimeWaitError } from "./CompositionTaskRuntimeProjectionService.ts";
import type { CompositionSquadModelBindingResolverShape } from "./CompositionSquadModelBindingResolver.ts";

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

const planningTaskId = "execution-planner-1:squad:squad-planner:r4:task:leader-plan";
const planningRunId = "execution-planner-1:squad:squad-planner:r4:run:leader-plan:1";

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

const makeHarness = (
  output = completedPlanJson,
  options?: {
    readonly modelBindings?: Pick<CompositionSquadModelBindingResolverShape, "resolveMember">;
  },
) => {
  const tasks = new Map<string, CompositionTask>();
  const runs = new Map<string, CompositionTaskRun>();
  const events = new Map<string, ReadonlyArray<CompositionTaskEvent>>();
  const dispatches: CompositionDispatchInput[] = [];

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
            ...(dispatch.modelSnapshot === undefined
              ? {}
              : { modelSnapshot: dispatch.modelSnapshot }),
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
      cancelTask: ({ taskId, runId }) =>
        Effect.sync(() => ({
          task: tasks.get(taskId)!,
          run: runs.get(runId)!,
          status: "already_terminal" as const,
        })),
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
    ...(options?.modelBindings === undefined ? {} : { modelBindings: options.modelBindings }),
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

it.effect("Leader 规划携带结构化模型快照，并拒绝配置漂移后的稳定身份重放", () =>
  Effect.gen(function* () {
    let configurationDigest = "sha256:leader-v1";
    const byokLeaderId = "provider:byok-planner";
    const structuredSquad: CompositionSquad = {
      ...squad,
      leaderAgentId: byokLeaderId,
      memberAgentIds: squad.memberAgentIds.map((agentId) =>
        agentId === squad.leaderAgentId ? byokLeaderId : agentId,
      ),
      members: squad.members?.map((item) =>
        item.role === "leader"
          ? {
              ...item,
              agentId: byokLeaderId,
              model: undefined,
              modelBinding: {
                kind: "byok" as const,
                providerInstanceId: "byok-planner",
                adapterId: "adapter-leader",
                modelId: "leader-model",
              },
            }
          : item,
      ),
      defaultModelBinding: {
        kind: "byok",
        providerInstanceId: "byok-planner",
        adapterId: "adapter-leader",
        modelId: "leader-model",
      },
    };
    const harness = makeHarness(completedPlanJson, {
      modelBindings: {
        resolveMember: () =>
          Effect.succeed({
            model: "adapter-leader",
            modelSnapshot: {
              kind: "byok" as const,
              providerInstanceId: "byok-planner",
              adapterId: "adapter-leader",
              modelId: "leader-model",
              adapterConfigDigest: configurationDigest,
            },
          }),
      },
    });
    const structuredInput = { ...input, squad: structuredSquad };

    yield* harness.planner.plan(structuredInput);

    expect(harness.dispatches[0]).toMatchObject({
      assigneeId: byokLeaderId,
      model: "adapter-leader",
      modelSnapshot: {
        kind: "byok",
        providerInstanceId: "byok-planner",
        adapterId: "adapter-leader",
        modelId: "leader-model",
        adapterConfigDigest: "sha256:leader-v1",
      },
    });

    configurationDigest = "sha256:leader-v2";
    const error = yield* Effect.flip(harness.planner.plan(structuredInput));

    expect(error.code).toBe("squad_plan_identity_conflict");
    expect(harness.dispatches).toHaveLength(1);
  }),
);

it.effect("复用稳定 Leader 规划 Run 等待中断时发布完整取消回执", () =>
  Effect.gen(function* () {
    const waiting = yield* Deferred.make<void>();
    const prompt = yield* makeCompositionSquadPlanningPrompt(squad, input.goal);
    const promptDigest = `sha256:${NodeCrypto.createHash("sha256")
      .update(prompt, "utf8")
      .digest("hex")}`;
    const task: CompositionTask = {
      taskId: planningTaskId,
      projectId: input.projectId,
      threadId: input.threadId,
      assigneeKind: "agent",
      assigneeId: squad.leaderAgentId,
      mode: "serial",
      status: "running",
      promptDigest,
      dependsOnTaskIds: [],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1,
    };
    const run: CompositionTaskRun = {
      runId: planningRunId,
      taskId: planningTaskId,
      agentId: squad.leaderAgentId,
      runtimeId: "runtime-leader",
      status: "running",
      attempt: 1,
      capabilityGrantIds: [],
    };
    let receipt: CompositionSquadPlanningCancellationReceipt | undefined;
    let cancelCalls = 0;
    const planner = makeCompositionSquadPlanner({
      orchestrator: {
        dispatchTask: () => Effect.die("稳定 Leader 规划 Run 不应重复派发"),
        cancelTask: () =>
          Effect.sync(() => {
            cancelCalls += 1;
            return {
              task: { ...task, status: "cancelled" as const, finishedAtUnixMs: 2 },
              run: { ...run, status: "cancelled" as const, finishedAtUnixMs: 2 },
              status: "cancelled" as const,
            };
          }),
      },
      runtime: {
        awaitTaskCompletion: () =>
          Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never)),
      },
      store: {
        getTask: () => Effect.succeed(Option.some(task)),
        getRun: () => Effect.succeed(Option.some(run)),
        listEvents: () => Effect.die("等待中的 Leader 规划 Run 不应读取输出"),
      },
    });
    const fiber = yield* Effect.forkChild(
      planner.plan(input, {
        onInterruptedCancellation: (value) =>
          Effect.sync(() => {
            receipt = value;
          }),
      }),
    );

    yield* Deferred.await(waiting);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);

    expect(cancelCalls).toBe(1);
    expect(receipt).toEqual({
      runs: [
        {
          taskId: planningTaskId,
          runId: planningRunId,
          outcome: "terminal",
          terminalStatus: "cancelled",
        },
      ],
      complete: true,
    });
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasFails(exit.cause)).toBe(false);
      expect(Cause.hasDies(exit.cause)).toBe(false);
      expect(Cause.interruptors(exit.cause).size).toBeGreaterThan(0);
    }
  }),
);

it.effect("Leader 规划派发响应丢失但稳定 Run 已落库时中断仍核验归属并取消", () =>
  Effect.gen(function* () {
    const dispatchPersisted = yield* Deferred.make<void>();
    const tasks = new Map<string, CompositionTask>();
    const runs = new Map<string, CompositionTaskRun>();
    let receipt: CompositionSquadPlanningCancellationReceipt | undefined;
    let cancelCalls = 0;
    const planner = makeCompositionSquadPlanner({
      orchestrator: {
        dispatchTask: (dispatch) =>
          Effect.sync(() => {
            tasks.set(dispatch.taskId, {
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
            });
            runs.set(dispatch.runId, {
              runId: dispatch.runId,
              taskId: dispatch.taskId,
              agentId: dispatch.assigneeId,
              runtimeId: "runtime-leader",
              status: "running",
              attempt: 1,
              capabilityGrantIds: [],
            });
          }).pipe(
            Effect.andThen(Deferred.succeed(dispatchPersisted, undefined)),
            Effect.andThen(Effect.never),
          ),
        cancelTask: ({ taskId, runId }) =>
          Effect.sync(() => {
            cancelCalls += 1;
            const task = tasks.get(taskId)!;
            const run = runs.get(runId)!;
            return {
              task: { ...task, status: "cancelled" as const, finishedAtUnixMs: 2 },
              run: { ...run, status: "cancelled" as const, finishedAtUnixMs: 2 },
              status: "cancelled" as const,
            };
          }),
      },
      runtime: { awaitTaskCompletion: () => Effect.die("派发响应丢失时不应进入等待") },
      store: {
        getTask: (taskId) => Effect.succeed(Option.fromNullishOr(tasks.get(taskId))),
        getRun: (runId) => Effect.succeed(Option.fromNullishOr(runs.get(runId))),
        listEvents: () => Effect.die("派发响应丢失时不应读取输出"),
      },
    });
    const fiber = yield* Effect.forkChild(
      planner.plan(input, {
        onInterruptedCancellation: (value) =>
          Effect.sync(() => {
            receipt = value;
          }),
      }),
    );

    yield* Deferred.await(dispatchPersisted);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);

    expect(cancelCalls).toBe(1);
    expect(receipt).toMatchObject({
      runs: [
        {
          taskId: planningTaskId,
          runId: planningRunId,
          outcome: "terminal",
          terminalStatus: "cancelled",
        },
      ],
      complete: true,
    });
    expect(exit._tag).toBe("Failure");
  }),
);

it.effect("Leader 规划派发成功后 Store 查询失败仍按已确认归属取消", () =>
  Effect.gen(function* () {
    const waiting = yield* Deferred.make<void>();
    const tasks = new Map<string, CompositionTask>();
    const runs = new Map<string, CompositionTaskRun>();
    let dispatchReturned = false;
    let receipt: CompositionSquadPlanningCancellationReceipt | undefined;
    let cancelCalls = 0;
    const planner = makeCompositionSquadPlanner({
      orchestrator: {
        dispatchTask: (dispatch) =>
          Effect.sync(() => {
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
            dispatchReturned = true;
            return { task, run };
          }),
        cancelTask: ({ taskId, runId }) =>
          Effect.sync(() => {
            cancelCalls += 1;
            return {
              task: { ...tasks.get(taskId)!, status: "cancelled" as const, finishedAtUnixMs: 2 },
              run: { ...runs.get(runId)!, status: "cancelled" as const, finishedAtUnixMs: 2 },
              status: "cancelled" as const,
            };
          }),
      },
      runtime: {
        awaitTaskCompletion: () =>
          Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never)),
      },
      store: {
        getTask: (taskId) =>
          dispatchReturned
            ? Effect.fail(
                new PersistenceSqlError({
                  operation: "load confirmed planning task",
                  detail: "派发成功后的临时查询故障",
                  cause: new Error("temporary store failure"),
                }),
              )
            : Effect.succeed(Option.fromNullishOr(tasks.get(taskId))),
        getRun: (runId) =>
          dispatchReturned
            ? Effect.fail(
                new PersistenceSqlError({
                  operation: "load confirmed planning run",
                  detail: "派发成功后的临时查询故障",
                  cause: new Error("temporary store failure"),
                }),
              )
            : Effect.succeed(Option.fromNullishOr(runs.get(runId))),
        listEvents: () => Effect.die("等待中的 Leader 规划 Run 不应读取输出"),
      },
    });
    const fiber = yield* Effect.forkChild(
      planner.plan(input, {
        onInterruptedCancellation: (value) =>
          Effect.sync(() => {
            receipt = value;
          }),
      }),
    );

    yield* Deferred.await(waiting);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);

    expect(cancelCalls).toBe(1);
    expect(receipt).toEqual({
      runs: [
        {
          taskId: planningTaskId,
          runId: planningRunId,
          outcome: "terminal",
          terminalStatus: "cancelled",
        },
      ],
      complete: true,
    });
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasFails(exit.cause)).toBe(false);
      expect(Cause.interruptors(exit.cause).size).toBeGreaterThan(0);
    }
  }),
);

it.effect("Leader 规划派发成功但返回串线身份时拒绝升级归属", () =>
  Effect.gen(function* () {
    for (const status of ["running", "completed"] as const) {
      const foreignTask: CompositionTask = {
        taskId: `${planningTaskId}:foreign`,
        projectId: input.projectId,
        threadId: input.threadId,
        assigneeKind: "agent",
        assigneeId: squad.leaderAgentId,
        mode: "serial",
        status,
        promptDigest: "sha256:foreign-response",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1,
        ...(status === "completed" ? { finishedAtUnixMs: 2 } : {}),
      };
      const foreignRun: CompositionTaskRun = {
        runId: `${planningRunId}:foreign`,
        taskId: foreignTask.taskId,
        agentId: squad.leaderAgentId,
        runtimeId: "runtime-foreign",
        status,
        attempt: 1,
        capabilityGrantIds: [],
        ...(status === "completed" ? { finishedAtUnixMs: 2 } : {}),
      };
      let cancellationReceipt: CompositionSquadPlanningCancellationReceipt | undefined;
      let cancellationTrigger: "interrupted" | "business_failure" | undefined;
      let cancelCalls = 0;
      const planner = makeCompositionSquadPlanner({
        orchestrator: {
          dispatchTask: () => Effect.succeed({ task: foreignTask, run: foreignRun }),
          cancelTask: () =>
            Effect.sync(() => {
              cancelCalls += 1;
              return {
                task: { ...foreignTask, status: "cancelled" as const, finishedAtUnixMs: 3 },
                run: { ...foreignRun, status: "cancelled" as const, finishedAtUnixMs: 3 },
                status: "cancelled" as const,
              };
            }),
        },
        runtime: {
          awaitTaskCompletion: () =>
            Effect.fail(
              new CompositionTaskRuntimeWaitError({
                taskId: planningTaskId,
                runId: planningRunId,
                reason: "串线派发响应不应进入等待",
              }),
            ),
        },
        store: {
          getTask: () => Effect.succeed(Option.none<CompositionTask>()),
          getRun: () => Effect.succeed(Option.none<CompositionTaskRun>()),
          listEvents: () =>
            Effect.fail(
              new PersistenceSqlError({
                operation: "list foreign planning events",
                detail: "串线派发响应不应读取输出",
                cause: new Error("foreign dispatch response"),
              }),
            ),
        },
      });

      const error = yield* Effect.flip(
        planner.plan(input, {
          onCancellationReceipt: (report) =>
            Effect.sync(() => {
              cancellationTrigger = report.trigger;
              cancellationReceipt = report.receipt;
            }),
        }),
      );

      expect(error.code).toBe("squad_plan_identity_conflict");
      expect(cancelCalls).toBe(0);
      expect(cancellationTrigger).toBe("business_failure");
      expect(cancellationReceipt).toEqual({
        runs: [
          {
            taskId: planningTaskId,
            runId: planningRunId,
            outcome: "not_owned",
          },
        ],
        complete: true,
      });
    }
  }),
);

it.effect("Leader 规划等待返回 foreign terminal 时拒绝伪造终态", () =>
  Effect.gen(function* () {
    const tasks = new Map<string, CompositionTask>();
    const runs = new Map<string, CompositionTaskRun>();
    let cancelCalls = 0;
    const planner = makeCompositionSquadPlanner({
      orchestrator: {
        dispatchTask: (dispatch) =>
          Effect.sync(() => {
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
            return { task, run };
          }),
        cancelTask: ({ taskId, runId }) =>
          Effect.sync(() => {
            cancelCalls += 1;
            return {
              task: { ...tasks.get(taskId)!, status: "cancelled" as const, finishedAtUnixMs: 3 },
              run: { ...runs.get(runId)!, status: "cancelled" as const, finishedAtUnixMs: 3 },
              status: "cancelled" as const,
            };
          }),
      },
      runtime: {
        awaitTaskCompletion: () =>
          Effect.succeed({
            ...runs.get(planningRunId)!,
            runtimeId: "foreign-runtime",
            status: "completed" as const,
            attempt: 99,
            resultSummary: "串线终态结果",
            finishedAtUnixMs: 2,
          }),
      },
      store: {
        getTask: () => Effect.succeed(Option.none<CompositionTask>()),
        getRun: () => Effect.succeed(Option.none<CompositionTaskRun>()),
        listEvents: () =>
          Effect.fail(
            new PersistenceSqlError({
              operation: "list events after foreign terminal",
              detail: "foreign terminal 不应进入输出读取",
              cause: new Error("foreign terminal accepted"),
            }),
          ),
      },
    });

    const error = yield* Effect.flip(planner.plan(input));

    expect(error.code).toBe("squad_plan_identity_conflict");
    expect(cancelCalls).toBe(1);
  }),
);

it.effect("Leader 规划派发响应未返回且归属查询失败时保持不完整回执", () =>
  Effect.gen(function* () {
    const dispatchStarted = yield* Deferred.make<void>();
    let receipt: CompositionSquadPlanningCancellationReceipt | undefined;
    let cancelCalls = 0;
    let dispatching = false;
    const lookupFailure = () =>
      Effect.fail(
        new PersistenceSqlError({
          operation: "load candidate planning run",
          detail: "third-party-secret-lookup-detail",
          cause: new Error("third-party-secret-store-cause"),
        }),
      );
    const planner = makeCompositionSquadPlanner({
      orchestrator: {
        dispatchTask: () =>
          Effect.sync(() => {
            dispatching = true;
          }).pipe(
            Effect.andThen(Deferred.succeed(dispatchStarted, undefined)),
            Effect.andThen(Effect.never),
          ),
        cancelTask: () =>
          Effect.sync(() => {
            cancelCalls += 1;
            return {
              task: {} as CompositionTask,
              run: {} as CompositionTaskRun,
              status: "cancelled" as const,
            };
          }),
      },
      runtime: { awaitTaskCompletion: () => Effect.die("派发响应未返回时不应进入等待") },
      store: {
        getTask: () =>
          dispatching ? lookupFailure() : Effect.succeed(Option.none<CompositionTask>()),
        getRun: () =>
          dispatching ? lookupFailure() : Effect.succeed(Option.none<CompositionTaskRun>()),
        listEvents: () => Effect.die("派发响应未返回时不应读取输出"),
      },
    });
    const fiber = yield* Effect.forkChild(
      planner.plan(input, {
        onInterruptedCancellation: (value) =>
          Effect.sync(() => {
            receipt = value;
          }),
      }),
    );

    yield* Deferred.await(dispatchStarted);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);

    expect(cancelCalls).toBe(0);
    expect(receipt).toMatchObject({
      runs: [
        {
          taskId: planningTaskId,
          runId: planningRunId,
          outcome: "ownership_unverified",
          failureCode: "ownership_lookup_failed",
        },
      ],
      complete: false,
    });
    expect(receipt?.runs.flatMap((run) => Object.values(run).map(String)).join("\n")).not.toContain(
      "third-party-secret",
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasFails(exit.cause)).toBe(true);
      expect(Cause.interruptors(exit.cause).size).toBeGreaterThan(0);
    }
  }),
);

it.effect("Leader 规划中断清理失败只发布受控不完整回执且不泄露第三方详情", () =>
  Effect.gen(function* () {
    const cases = [
      {
        name: "cancel_failed",
        expectedOutcome: "cancel_failed",
        expectedFailureCode: "cancel_failed",
      },
      {
        name: "pending",
        expectedOutcome: "pending",
        expectedFailureCode: "cancel_confirmation_failed",
      },
      {
        name: "timeout",
        expectedOutcome: "timeout",
        expectedFailureCode: "cancel_timeout",
      },
    ] as const;

    for (const currentCase of cases) {
      const waiting = yield* Deferred.make<void>();
      const prompt = yield* makeCompositionSquadPlanningPrompt(squad, input.goal);
      const promptDigest = `sha256:${NodeCrypto.createHash("sha256")
        .update(prompt, "utf8")
        .digest("hex")}`;
      const task: CompositionTask = {
        taskId: planningTaskId,
        projectId: input.projectId,
        threadId: input.threadId,
        assigneeKind: "agent",
        assigneeId: squad.leaderAgentId,
        mode: "serial",
        status: "running",
        promptDigest,
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1,
      };
      const run: CompositionTaskRun = {
        runId: planningRunId,
        taskId: planningTaskId,
        agentId: squad.leaderAgentId,
        runtimeId: "runtime-leader",
        status: "running",
        attempt: 1,
        capabilityGrantIds: [],
      };
      let waitCount = 0;
      let receipt: CompositionSquadPlanningCancellationReceipt | undefined;
      const planner = makeCompositionSquadPlanner({
        orchestrator: {
          dispatchTask: () => Effect.die("稳定 Leader 规划 Run 不应重复派发"),
          cancelTask: () =>
            currentCase.name === "cancel_failed"
              ? Effect.fail(
                  new CompositionAgentDriverFailure({
                    code: "provider_secret_cancel_failure",
                    detail: "third-party-secret-cancel-detail",
                  }),
                )
              : currentCase.name === "timeout"
                ? Effect.never
                : Effect.succeed({ task, run, status: "cancel_requested" as const }),
        },
        runtime: {
          awaitTaskCompletion: () => {
            waitCount += 1;
            if (waitCount === 1) {
              return Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never));
            }
            return Effect.fail(
              new CompositionTaskRuntimeWaitError({
                taskId: planningTaskId,
                runId: planningRunId,
                reason: "third-party-secret-confirmation-detail",
              }),
            );
          },
        },
        store: {
          getTask: () => Effect.succeed(Option.some(task)),
          getRun: () => Effect.succeed(Option.some(run)),
          listEvents: () => Effect.die("等待中的 Leader 规划 Run 不应读取输出"),
        },
        cancelTimeoutMs: 5,
      });
      const fiber = yield* Effect.forkChild(
        planner.plan(input, {
          onInterruptedCancellation: (value) =>
            Effect.sync(() => {
              receipt = value;
            }),
        }),
      );

      yield* Deferred.await(waiting);
      if (currentCase.name === "timeout") {
        const interruptFiber = yield* Effect.forkChild(Fiber.interrupt(fiber), {
          startImmediately: true,
        });
        yield* TestClock.adjust("5 millis");
        yield* Fiber.join(interruptFiber);
      } else {
        yield* Fiber.interrupt(fiber);
      }
      const exit = yield* Fiber.await(fiber);

      expect(receipt).toMatchObject({
        complete: false,
      });
      expect(receipt?.runs[0]).toMatchObject({
        taskId: planningTaskId,
        runId: planningRunId,
        outcome: currentCase.expectedOutcome,
        failureCode: currentCase.expectedFailureCode,
      });
      expect(
        receipt?.runs.flatMap((run) => Object.values(run).map(String)).join("\n"),
      ).not.toContain("third-party-secret");
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.hasFails(exit.cause)).toBe(true);
        expect(Cause.hasDies(exit.cause)).toBe(false);
        expect(Cause.interruptors(exit.cause).size).toBeGreaterThan(0);
      }
    }
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
        cancelTask: () => Effect.die("已完成竞争 Run 不应取消"),
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
    const failedPrompt = yield* makeCompositionSquadPlanningPrompt(squad, input.goal);
    const failedPromptDigest = `sha256:${NodeCrypto.createHash("sha256")
      .update(failedPrompt, "utf8")
      .digest("hex")}`;
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
              promptDigest: failedPromptDigest,
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
        cancelTask: () => Effect.die("已失败终态 Run 不应取消"),
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
