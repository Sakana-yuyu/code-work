import { expect, it } from "@effect/vitest";
import type { CompositionSquad } from "@codework/contracts";
import * as Effect from "effect/Effect";

import {
  compileCompositionSquadGraph,
  makeCompositionSquadRunner,
  type CompositionSquadExecutionInput,
} from "./CompositionSquadRunner.ts";
import type { CompositionTaskGraphExecutionInput } from "./CompositionTaskGraphExecutor.ts";

const baseSquad: CompositionSquad = {
  squadId: "squad-core",
  name: "核心协同组",
  leaderAgentId: "agent-leader",
  memberAgentIds: ["agent-leader", "agent-worker", "agent-reviewer", "agent-critic"],
  instructions: "先实现，再审查，最后由 Leader 汇总。",
  revision: 3,
  collaborationMode: "leader_workers",
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
    {
      agentId: "agent-critic",
      role: "critic",
      order: 3,
      required: false,
      model: "provider/critic-model",
      workspaceRoot: "C:/workspace/critic",
      capabilityIds: ["t3.workspace.read_file"],
      maxConcurrentTasks: 1,
    },
  ],
  maxConcurrency: 3,
  maxRetries: 2,
  failurePolicy: "fail_fast",
  partialSuccessPolicy: "reject",
  approvalStages: ["before_finalize"],
  createdAtUnixMs: 100,
  updatedAtUnixMs: 300,
};

const baseInput: CompositionSquadExecutionInput = {
  executionId: "execution-1",
  squadId: baseSquad.squadId,
  squadRevision: 3,
  projectId: "project-1",
  threadId: "thread-1",
  goal: "完成多 Agent 协同实现并给出验证证据",
  workspaceRoot: "C:/workspace/default",
};

const compile = (
  collaborationMode: CompositionSquad["collaborationMode"],
  input: CompositionSquadExecutionInput = baseInput,
) =>
  compileCompositionSquadGraph({
    squad: { ...baseSquad, collaborationMode },
    input,
  });

it.effect("把 Squad 成员模型、工作目录、能力和重试策略编译进真实 Graph 节点", () =>
  Effect.gen(function* () {
    const graph = yield* compile("leader_workers");

    expect(graph.maxConcurrency).toBe(3);
    expect(graph.schedule).toBe("parallel");
    expect(graph.failurePolicy).toBe("fail_fast");
    expect(graph.partialSuccessPolicy).toBe("reject");
    expect(graph.leader).toMatchObject({
      assigneeKind: "squad",
      assigneeId: baseSquad.squadId,
      model: "provider/leader-model",
      workspaceRoot: "C:/workspace/leader",
      capabilityIds: ["t3.workspace.read_file"],
    });
    expect(graph.children.map((node) => node.assigneeId)).toEqual([
      "agent-worker",
      "agent-reviewer",
      "agent-critic",
    ]);
    expect(graph.children[0]).toMatchObject({
      model: "provider/worker-model",
      workspaceRoot: "C:/workspace/worker",
      capabilityIds: ["t3.workspace.read_file", "t3.workspace.write_file"],
      maxAttempts: 3,
    });
  }),
);

it.effect("五种协同模式生成各自的调度与依赖语义", () =>
  Effect.gen(function* () {
    const serial = yield* compile("serial");
    const parallel = yield* compile("parallel");
    const reviewCritic = yield* compile("review_critic");
    const leaderWorkers = yield* compile("leader_workers");
    const dependencyGraph = yield* compile("dependency_graph", {
      ...baseInput,
      plan: [
        {
          nodeId: "implement",
          agentId: "agent-worker",
          prompt: "完成实现",
          dependsOnNodeIds: [],
        },
        {
          nodeId: "review",
          agentId: "agent-reviewer",
          prompt: "审查实现",
          dependsOnNodeIds: ["implement"],
        },
      ],
    });

    expect(serial.schedule).toBe("serial");
    expect(serial.children.map((node) => node.dependsOnNodeIds)).toEqual([
      [],
      [serial.children[0]!.nodeId],
      [serial.children[1]!.nodeId],
    ]);
    expect(parallel.children.every((node) => node.dependsOnNodeIds?.length === 0)).toBe(true);
    expect(
      reviewCritic.children.find((node) => node.assigneeId === "agent-reviewer"),
    ).toMatchObject({ dependsOnNodeIds: ["member:1:agent-worker"] });
    expect(reviewCritic.children.find((node) => node.assigneeId === "agent-critic")).toMatchObject({
      dependsOnNodeIds: ["member:1:agent-worker"],
    });
    expect(leaderWorkers.schedule).toBe("parallel");
    expect(dependencyGraph.children.map((node) => node.dependsOnNodeIds)).toEqual([
      [],
      ["implement"],
    ]);
  }),
);

it.effect("dependency_graph 没有显式计划时拒绝猜测依赖", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(compile("dependency_graph"));
    expect(error).toMatchObject({ code: "squad_plan_required" });
  }),
);

it.effect("拒绝计划把任务分派给 Squad 之外的 Agent", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      compile("dependency_graph", {
        ...baseInput,
        plan: [
          {
            nodeId: "foreign",
            agentId: "agent-foreign",
            prompt: "越权任务",
            dependsOnNodeIds: [],
          },
        ],
      }),
    );
    expect(error).toMatchObject({ code: "squad_member_missing", nodeId: "foreign" });
  }),
);

it.effect("Runner 固定 revision 后调用现有 TaskGraphExecutor", () =>
  Effect.gen(function* () {
    let captured: CompositionTaskGraphExecutionInput | undefined;
    const runner = makeCompositionSquadRunner({
      squads: { getRunnable: () => Effect.succeed(baseSquad) },
      planner: {
        plan: () =>
          Effect.succeed([
            {
              nodeId: "planned-worker",
              agentId: "agent-worker",
              prompt: "由 Leader 拆解后的实现任务",
              dependsOnNodeIds: [],
            },
          ]),
      },
      executor: {
        execute: (input) =>
          Effect.sync(() => {
            captured = input;
            return {
              leader: {
                task: {
                  taskId: input.leader.taskId,
                  projectId: input.leader.projectId,
                  assigneeKind: input.leader.assigneeKind,
                  assigneeId: input.leader.assigneeId,
                  mode: "review" as const,
                  status: "in_review" as const,
                  promptDigest: input.leader.promptDigest,
                  dependsOnTaskIds: [],
                  createdAtUnixMs: 1,
                  updatedAtUnixMs: 2,
                },
                run: {
                  runId: input.leader.runId,
                  taskId: input.leader.taskId,
                  agentId: baseSquad.leaderAgentId,
                  runtimeId: "runtime-leader",
                  status: "in_review" as const,
                  attempt: 1,
                  capabilityGrantIds: [],
                },
              },
              children: [],
            };
          }),
      },
    });

    const result = yield* runner.run(baseInput);

    expect(result.squadId).toBe(baseSquad.squadId);
    expect(result.squadRevision).toBe(3);
    expect(captured?.children[0]).toMatchObject({
      nodeId: "planned-worker",
      assigneeId: "agent-worker",
    });
  }),
);

it.effect("显式用户计划绕过 Leader 自动规划", () =>
  Effect.gen(function* () {
    let captured: CompositionTaskGraphExecutionInput | undefined;
    const explicitPlan = [
      {
        nodeId: "explicit-worker",
        agentId: "agent-worker",
        prompt: "执行用户明确给出的任务",
        dependsOnNodeIds: [],
      },
    ];
    const runner = makeCompositionSquadRunner({
      squads: { getRunnable: () => Effect.succeed(baseSquad) },
      planner: { plan: () => Effect.die("显式计划不应调用 Leader Planner") },
      executor: {
        execute: (graph) =>
          Effect.sync(() => {
            captured = graph;
            return {
              leader: {
                task: {
                  taskId: graph.leader.taskId,
                  projectId: graph.leader.projectId,
                  assigneeKind: graph.leader.assigneeKind,
                  assigneeId: graph.leader.assigneeId,
                  mode: "review" as const,
                  status: "in_review" as const,
                  promptDigest: graph.leader.promptDigest,
                  dependsOnTaskIds: [],
                  createdAtUnixMs: 1,
                  updatedAtUnixMs: 2,
                },
                run: {
                  runId: graph.leader.runId,
                  taskId: graph.leader.taskId,
                  agentId: baseSquad.leaderAgentId,
                  runtimeId: "runtime-leader",
                  status: "in_review" as const,
                  attempt: 1,
                  capabilityGrantIds: [],
                },
              },
              children: [],
            };
          }),
      },
    });

    yield* runner.run({ ...baseInput, plan: explicitPlan });

    expect(captured?.children[0]).toMatchObject({
      nodeId: "explicit-worker",
      assigneeId: "agent-worker",
    });
  }),
);

it.effect("Runner 拒绝用陈旧 revision 启动运行", () =>
  Effect.gen(function* () {
    const runner = makeCompositionSquadRunner({
      squads: { getRunnable: () => Effect.succeed(baseSquad) },
      planner: { plan: () => Effect.die("revision 冲突时不应规划") },
      executor: { execute: () => Effect.die("revision 冲突时不应执行") },
    });

    const error = yield* Effect.flip(runner.run({ ...baseInput, squadRevision: 2 }));

    expect(error).toMatchObject({
      code: "squad_revision_conflict",
      expectedRevision: 2,
      actualRevision: 3,
    });
  }),
);
