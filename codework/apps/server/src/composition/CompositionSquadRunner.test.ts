import * as NodeCrypto from "node:crypto";

import { expect, it } from "@effect/vitest";
import type {
  CompositionSquad,
  CompositionSquadExecution,
  CompositionSquadExecutionStatus,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as References from "effect/References";

import { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";
import {
  type CompositionSquadExecutionClaimResult,
  CompositionSquadExecutionStoreDomainError,
  type CompositionSquadExecutionStoreShape,
} from "../persistence/Services/CompositionSquadExecutionStore.ts";
import { encodeCompositionSquadPlanOutput } from "./CompositionSquadPlan.ts";
import { CompositionSquadPlannerError } from "./CompositionSquadPlanner.ts";
import {
  compileCompositionSquadGraph,
  makeCompositionSquadRunner,
  type CompositionSquadExecutionInput,
} from "./CompositionSquadRunner.ts";
import {
  CompositionTaskGraphExecutionError,
  type CompositionTaskGraphExecutionInput,
  type CompositionTaskGraphExecutionResult,
} from "./CompositionTaskGraphExecutor.ts";

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
  approvalStages: [],
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

const sha256 = (value: string): string =>
  `sha256:${NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex")}`;

type RunnerExecutionStore = Pick<
  CompositionSquadExecutionStoreShape,
  "claimExecution" | "saveTransition"
>;

const makeStoreError = (
  executionId: string,
  detail: string,
  options?: {
    readonly code?: "squad_execution_conflict" | "squad_execution_revision_conflict";
    readonly expectedRevision?: number;
    readonly actualRevision?: number;
  },
) =>
  new CompositionSquadExecutionStoreDomainError({
    code: options?.code ?? "squad_execution_conflict",
    detail,
    executionId,
    ...(options?.expectedRevision === undefined
      ? {}
      : { expectedRevision: options.expectedRevision }),
    ...(options?.actualRevision === undefined ? {} : { actualRevision: options.actualRevision }),
  });

const makeExecutionStoreHarness = (options?: {
  readonly forceClaimedFalse?: boolean;
  readonly failClaim?: boolean;
  readonly failSaveStatus?: CompositionSquadExecutionStatus;
  readonly events?: string[];
}) => {
  let current: CompositionSquadExecution | undefined;
  const snapshots: CompositionSquadExecution[] = [];
  const events = options?.events ?? [];
  const store: RunnerExecutionStore = {
    claimExecution: (execution) =>
      Effect.gen(function* () {
        events.push(`store:claim:${execution.status}`);
        if (options?.failClaim === true) {
          return yield* makeStoreError(execution.executionId, "claim 写入失败");
        }
        if (options?.forceClaimedFalse === true) {
          return {
            execution,
            claimed: false,
          } satisfies CompositionSquadExecutionClaimResult;
        }
        current = execution;
        snapshots.push(execution);
        return {
          execution,
          claimed: true,
        } satisfies CompositionSquadExecutionClaimResult;
      }),
    saveTransition: ({ execution, expectedRevision }) =>
      Effect.suspend(() => {
        events.push(`store:save:${execution.status}`);
        if (options?.failSaveStatus === execution.status) {
          return Effect.fail(
            makeStoreError(execution.executionId, `${execution.status} 写入失败`, {
              code: "squad_execution_revision_conflict",
              expectedRevision,
              actualRevision: expectedRevision + 10,
            }),
          );
        }
        expect(current?.revision).toBe(expectedRevision);
        current = execution;
        snapshots.push(execution);
        return Effect.succeed(execution);
      }),
  };
  return {
    events,
    snapshots,
    store,
    read: () => current,
  };
};

const makeSquadLookup = (squad: CompositionSquad, events?: string[]) => ({
  getRunnable: () =>
    Effect.sync(() => {
      events?.push("squad:getRunnable");
      return squad;
    }),
  getRevision: (_squadId: string, _revision: number) =>
    Effect.sync(() => {
      events?.push("squad:getRevision");
      return squad;
    }),
});

const makeGraphResult = (
  input: CompositionTaskGraphExecutionInput,
  status: "completed" | "in_review" = "in_review",
  resultSummary?: string,
): CompositionTaskGraphExecutionResult => ({
  leader: {
    task: {
      taskId: input.leader.taskId,
      projectId: input.leader.projectId,
      assigneeKind: input.leader.assigneeKind,
      assigneeId: input.leader.assigneeId,
      mode: "review",
      status,
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
      status,
      attempt: 1,
      capabilityGrantIds: [],
      ...(resultSummary === undefined ? {} : { resultSummary }),
    },
  },
  children: [],
});

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

it.effect("为节点编译同角色且能力不降级的有序接管候选", () =>
  Effect.gen(function* () {
    const squad: CompositionSquad = {
      ...baseSquad,
      memberAgentIds: [
        ...baseSquad.memberAgentIds,
        "agent-worker-backup",
        "agent-worker-underqualified",
      ],
      members: [
        ...baseSquad.members!,
        {
          agentId: "agent-worker-backup",
          role: "worker",
          order: 4,
          required: false,
          model: "provider/backup-model",
          workspaceRoot: "C:/workspace/backup",
          capabilityIds: ["t3.workspace.read_file", "t3.workspace.write_file", "t3.git.status"],
          maxConcurrentTasks: 1,
        },
        {
          agentId: "agent-worker-underqualified",
          role: "worker",
          order: 5,
          required: false,
          model: "provider/underqualified-model",
          workspaceRoot: "C:/workspace/underqualified",
          capabilityIds: ["t3.workspace.read_file"],
          maxConcurrentTasks: 1,
        },
      ],
    };

    const graph = yield* compileCompositionSquadGraph({
      squad,
      input: {
        ...baseInput,
        plan: [
          {
            nodeId: "primary-work",
            agentId: "agent-worker",
            prompt: "完成主实现",
            dependsOnNodeIds: [],
          },
        ],
      },
    });

    expect(graph.children.find((node) => node.assigneeId === "agent-worker")).toMatchObject({
      failoverCandidates: [
        {
          assigneeId: "agent-worker-backup",
          model: "provider/backup-model",
          workspaceRoot: "C:/workspace/backup",
          capabilityIds: ["t3.workspace.read_file", "t3.workspace.write_file"],
        },
      ],
    });
  }),
);

it.effect("Reviewer 与 Critic 在评审角色池内互相接管", () =>
  Effect.gen(function* () {
    const graph = yield* compileCompositionSquadGraph({
      squad: { ...baseSquad, collaborationMode: "review_critic" },
      input: {
        ...baseInput,
        plan: [
          {
            nodeId: "review-only",
            agentId: "agent-reviewer",
            prompt: "审查实现证据",
            dependsOnNodeIds: [],
          },
        ],
      },
    });

    expect(graph.children[0]).toMatchObject({
      assigneeId: "agent-reviewer",
      failoverCandidates: [
        {
          assigneeId: "agent-critic",
          capabilityIds: ["t3.workspace.read_file"],
        },
      ],
    });
  }),
);

it.effect("已达到计划并发上限的成员不进入接管候选", () =>
  Effect.gen(function* () {
    const backup = {
      agentId: "agent-worker-backup",
      role: "worker" as const,
      order: 4,
      required: false,
      workspaceRoot: "C:/workspace/backup",
      capabilityIds: ["t3.workspace.read_file", "t3.workspace.write_file"],
      maxConcurrentTasks: 1,
    };
    const squad: CompositionSquad = {
      ...baseSquad,
      memberAgentIds: [...baseSquad.memberAgentIds, backup.agentId],
      members: [...baseSquad.members!, backup],
    };
    const graph = yield* compileCompositionSquadGraph({
      squad,
      input: {
        ...baseInput,
        plan: [
          {
            nodeId: "primary-work",
            agentId: "agent-worker",
            prompt: "完成主实现",
            dependsOnNodeIds: [],
          },
          {
            nodeId: "backup-own-work",
            agentId: backup.agentId,
            prompt: "完成备用成员自己的任务",
            dependsOnNodeIds: [],
          },
        ],
      },
    });

    expect(graph.children.find((node) => node.nodeId === "primary-work")?.failoverCandidates).toBe(
      undefined,
    );
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
    const reviewer = reviewCritic.children.find((node) => node.assigneeId === "agent-reviewer")!;
    const critic = reviewCritic.children.find((node) => node.assigneeId === "agent-critic")!;
    expect(reviewer.prompt).toContain("Reviewer");
    expect(reviewer.prompt).toContain("允许请求重做的 nodeId：member:1:agent-worker");
    expect(reviewer.prompt).toContain('"decision":"reject"');
    expect(critic).toMatchObject({ dependsOnNodeIds: ["member:1:agent-worker"] });
    expect(critic.prompt).toContain("Critic");
    expect(critic.prompt).toContain('"decision":"approve"');
    expect(reviewCritic.review).toEqual({
      reviewerNodeIds: ["member:2:agent-reviewer", "member:3:agent-critic"],
      reworkableNodeIds: ["member:1:agent-worker"],
      maxRevisions: 2,
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
    const events: string[] = [];
    const executionStore = makeExecutionStoreHarness({ events });
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad, events),
      executions: executionStore.store,
      now: (() => {
        let current = 1_000;
        return () => current++;
      })(),
      planner: {
        plan: () =>
          Effect.sync(() => {
            events.push("planner:plan");
            return [
              {
                nodeId: "planned-worker",
                agentId: "agent-worker",
                prompt: "由 Leader 拆解后的实现任务",
                dependsOnNodeIds: [],
              },
            ];
          }),
      },
      executor: {
        execute: (input) =>
          Effect.sync(() => {
            events.push("executor:execute");
            captured = input;
            return makeGraphResult(input);
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
    expect(executionStore.read()).toMatchObject({
      status: "in_review",
      revision: 4,
      nodes: [
        {
          nodeId: "planned-worker",
          agentId: "agent-worker",
          taskId: captured?.children[0]?.taskId,
          runId: captured?.children[0]?.runId,
          promptDigest: captured?.children[0]?.promptDigest,
          dependsOnNodeIds: [],
        },
      ],
    });
    expect(executionStore.read()).not.toHaveProperty("planDigest");
    expect(executionStore.read()?.nodes?.[0]).not.toHaveProperty("prompt");
    expect(events).toEqual([
      "squad:getRunnable",
      "store:claim:queued",
      "store:save:planning",
      "squad:getRevision",
      "planner:plan",
      "store:save:running",
      "executor:execute",
      "store:save:in_review",
    ]);
  }),
);

it.effect("显式用户计划绕过 Leader 自动规划", () =>
  Effect.gen(function* () {
    let captured: CompositionTaskGraphExecutionInput | undefined;
    const executionStore = makeExecutionStoreHarness();
    const explicitPlan = [
      {
        nodeId: "explicit-worker",
        agentId: "agent-worker",
        prompt: "执行用户明确给出的任务",
        dependsOnNodeIds: [],
      },
    ];
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: executionStore.store,
      planner: { plan: () => Effect.die("显式计划不应调用 Leader Planner") },
      executor: {
        execute: (graph) =>
          Effect.sync(() => {
            captured = graph;
            return makeGraphResult(graph);
          }),
      },
    });

    yield* runner.run({ ...baseInput, plan: explicitPlan });

    expect(captured?.children[0]).toMatchObject({
      nodeId: "explicit-worker",
      assigneeId: "agent-worker",
    });
    expect(executionStore.snapshots[0]?.planDigest).toBeDefined();
    expect(executionStore.snapshots[0]?.goalTaskId).toBe(
      "execution-1:squad:squad-core:r3:task:leader-plan",
    );
    expect(executionStore.snapshots[0]?.planDigest).toBe(
      sha256(
        `composition-squad-explicit-plan:v1\n${encodeCompositionSquadPlanOutput(explicitPlan)}`,
      ),
    );
  }),
);

it.effect("Runner 拒绝用陈旧 revision 启动运行", () =>
  Effect.gen(function* () {
    const executionStore = makeExecutionStoreHarness();
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: executionStore.store,
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

it.effect("Leader 完成时持久化结果摘要与终态时间", () =>
  Effect.gen(function* () {
    const executionStore = makeExecutionStoreHarness();
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: executionStore.store,
      now: (() => {
        let current = 2_000;
        return () => current++;
      })(),
      planner: {
        plan: () =>
          Effect.succeed([
            {
              nodeId: "completed-worker",
              agentId: "agent-worker",
              prompt: "完成实现并提供证据",
              dependsOnNodeIds: [],
            },
          ]),
      },
      executor: {
        execute: (input) =>
          Effect.succeed(makeGraphResult(input, "completed", "全部节点已验证通过")),
      },
    });

    yield* runner.run({ ...baseInput, executionId: "execution-completed" });

    expect(executionStore.read()).toMatchObject({
      status: "completed",
      revision: 4,
      resultSummary: "全部节点已验证通过",
      finishedAtUnixMs: 2_003,
    });
  }),
);

it.effect("未实现审批协调器时持久化失败并阻止 Planner 与 Executor", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const executionStore = makeExecutionStoreHarness({ events });
    const squad = { ...baseSquad, approvalStages: ["before_finalize" as const] };
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(squad, events),
      executions: executionStore.store,
      planner: { plan: () => Effect.die("审批未实现时不应调用 Planner") },
      executor: { execute: () => Effect.die("审批未实现时不应调用 Executor") },
    });

    const error = yield* Effect.flip(
      runner.run({ ...baseInput, executionId: "execution-approval-unsupported" }),
    );

    expect(error).toMatchObject({ code: "squad_approval_not_supported" });
    expect(executionStore.read()).toMatchObject({
      status: "failed",
      revision: 3,
      failureCode: "squad_approval_not_supported",
    });
    expect(events).toEqual([
      "squad:getRunnable",
      "store:claim:queued",
      "store:save:planning",
      "squad:getRevision",
      "store:save:failed",
    ]);
  }),
);

it.effect("Planner 与 Graph 编译失败都从 planning 状态收口为 failed", () =>
  Effect.gen(function* () {
    const plannerStore = makeExecutionStoreHarness();
    const plannerRunner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: plannerStore.store,
      planner: {
        plan: () =>
          Effect.fail(
            new CompositionSquadPlannerError({
              code: "leader_plan_failed",
              detail: "Leader 未生成有效计划",
              squadId: baseSquad.squadId,
            }),
          ),
      },
      executor: { execute: () => Effect.die("规划失败时不应执行") },
    });
    const plannerError = yield* Effect.flip(
      plannerRunner.run({ ...baseInput, executionId: "execution-planner-failed" }),
    );
    expect(plannerError).toMatchObject({ code: "leader_plan_failed" });
    expect(plannerStore.read()).toMatchObject({
      status: "failed",
      revision: 3,
      failureCode: "leader_plan_failed",
    });

    const compileStore = makeExecutionStoreHarness();
    const compileRunner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: compileStore.store,
      planner: {
        plan: () =>
          Effect.succeed([
            {
              nodeId: "foreign-worker",
              agentId: "agent-foreign",
              prompt: "不应被派发",
              dependsOnNodeIds: [],
            },
          ]),
      },
      executor: { execute: () => Effect.die("编译失败时不应执行") },
    });
    const compileError = yield* Effect.flip(
      compileRunner.run({ ...baseInput, executionId: "execution-compile-failed" }),
    );
    expect(compileError).toMatchObject({ code: "squad_member_missing" });
    expect(compileStore.read()).toMatchObject({
      status: "failed",
      revision: 3,
      failureCode: "squad_member_missing",
    });
  }),
);

it.effect("Executor 失败从 running 状态收口并保留节点索引", () =>
  Effect.gen(function* () {
    const executionStore = makeExecutionStoreHarness();
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: executionStore.store,
      planner: {
        plan: () =>
          Effect.succeed([
            {
              nodeId: "executor-worker",
              agentId: "agent-worker",
              prompt: "进入执行后失败",
              dependsOnNodeIds: [],
            },
          ]),
      },
      executor: {
        execute: () =>
          Effect.fail(
            new CompositionTaskGraphExecutionError({
              code: "runtime_unavailable",
              detail: "没有可用 Runtime",
              nodeId: "executor-worker",
            }),
          ),
      },
    });

    const error = yield* Effect.flip(
      runner.run({ ...baseInput, executionId: "execution-executor-failed" }),
    );

    expect(error).toMatchObject({ code: "runtime_unavailable", nodeId: "executor-worker" });
    expect(executionStore.read()).toMatchObject({
      status: "failed",
      revision: 4,
      failureCode: "runtime_unavailable",
      nodes: [{ nodeId: "executor-worker", agentId: "agent-worker" }],
    });
  }),
);

it.effect("claim 与状态 CAS 失败时停止后续派发", () =>
  Effect.gen(function* () {
    const claimEvents: string[] = [];
    const claimStore = makeExecutionStoreHarness({ failClaim: true, events: claimEvents });
    const claimRunner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad, claimEvents),
      executions: claimStore.store,
      planner: { plan: () => Effect.die("claim 失败时不应规划") },
      executor: { execute: () => Effect.die("claim 失败时不应执行") },
    });
    const claimError = yield* Effect.flip(
      claimRunner.run({ ...baseInput, executionId: "execution-claim-failed" }),
    );
    expect(claimError).toMatchObject({ code: "squad_execution_conflict" });
    expect(claimEvents).toEqual(["squad:getRunnable", "store:claim:queued"]);

    const planningEvents: string[] = [];
    const planningStore = makeExecutionStoreHarness({
      failSaveStatus: "planning",
      events: planningEvents,
    });
    const planningRunner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad, planningEvents),
      executions: planningStore.store,
      planner: { plan: () => Effect.die("planning CAS 失败时不应规划") },
      executor: { execute: () => Effect.die("planning CAS 失败时不应执行") },
    });
    const planningError = yield* Effect.flip(
      planningRunner.run({ ...baseInput, executionId: "execution-planning-cas-failed" }),
    );
    expect(planningError).toMatchObject({
      code: "squad_execution_revision_conflict",
      expectedRevision: 1,
      actualRevision: 11,
    });
    expect(planningEvents).toEqual([
      "squad:getRunnable",
      "store:claim:queued",
      "store:save:planning",
    ]);

    const runningEvents: string[] = [];
    const runningStore = makeExecutionStoreHarness({
      failSaveStatus: "running",
      events: runningEvents,
    });
    const runningRunner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad, runningEvents),
      executions: runningStore.store,
      planner: {
        plan: () =>
          Effect.sync(() => {
            runningEvents.push("planner:plan");
            return [
              {
                nodeId: "running-cas-worker",
                agentId: "agent-worker",
                prompt: "只允许规划，不允许派发",
                dependsOnNodeIds: [],
              },
            ];
          }),
      },
      executor: { execute: () => Effect.die("running CAS 失败时不应执行") },
    });
    const runningError = yield* Effect.flip(
      runningRunner.run({ ...baseInput, executionId: "execution-running-cas-failed" }),
    );
    expect(runningError).toMatchObject({
      code: "squad_execution_revision_conflict",
      expectedRevision: 2,
      actualRevision: 12,
    });
    expect(runningEvents).toEqual([
      "squad:getRunnable",
      "store:claim:queued",
      "store:save:planning",
      "squad:getRevision",
      "planner:plan",
      "store:save:running",
    ]);
  }),
);

it.effect("claim 返回 claimed:false 时失败关闭且不规划或派发", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const executionStore = makeExecutionStoreHarness({ forceClaimedFalse: true, events });
    const replayRunner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad, events),
      executions: executionStore.store,
      planner: { plan: () => Effect.die("重复 execution 不应重新规划") },
      executor: { execute: () => Effect.die("重复 execution 不应重新派发") },
    });
    const error = yield* Effect.flip(
      replayRunner.run({ ...baseInput, executionId: "execution-replay" }),
    );

    expect(error).toMatchObject({ code: "squad_execution_replay_unavailable" });
    expect(events).toEqual(["squad:getRunnable", "store:claim:queued"]);
  }),
);

it.effect("claim 后始终读取固定 revision 的历史 Squad 配置", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const executionStore = makeExecutionStoreHarness({ events });
    const historicalSquad = { ...baseSquad, instructions: "固定 revision 的历史协同说明" };
    let plannedWithInstructions: string | undefined;
    let revisionLookup: readonly [string, number] | undefined;
    const runner = makeCompositionSquadRunner({
      squads: {
        getRunnable: () =>
          Effect.sync(() => {
            events.push("squad:getRunnable");
            return baseSquad;
          }),
        getRevision: (squadId, revision) =>
          Effect.sync(() => {
            events.push("squad:getRevision");
            revisionLookup = [squadId, revision];
            return historicalSquad;
          }),
      },
      executions: executionStore.store,
      planner: {
        plan: ({ squad }) =>
          Effect.sync(() => {
            plannedWithInstructions = squad.instructions;
            return [
              {
                nodeId: "historical-worker",
                agentId: "agent-worker",
                prompt: "使用固定 revision 规划",
                dependsOnNodeIds: [],
              },
            ];
          }),
      },
      executor: { execute: (input) => Effect.succeed(makeGraphResult(input)) },
    });

    yield* runner.run({ ...baseInput, executionId: "execution-fixed-revision" });

    expect(plannedWithInstructions).toBe("固定 revision 的历史协同说明");
    expect(revisionLookup).toEqual([baseInput.squadId, baseInput.squadRevision]);
    expect(events.slice(0, 4)).toEqual([
      "squad:getRunnable",
      "store:claim:queued",
      "store:save:planning",
      "squad:getRevision",
    ]);
  }),
);

it.effect("显式 plan 摘要基于规范编码且保留有业务意义的数组顺序", () =>
  Effect.gen(function* () {
    const digestFor = (
      executionId: string,
      plan: NonNullable<CompositionSquadExecutionInput["plan"]>,
    ) => {
      const executionStore = makeExecutionStoreHarness();
      const runner = makeCompositionSquadRunner({
        squads: makeSquadLookup(baseSquad),
        executions: executionStore.store,
        planner: { plan: () => Effect.die("显式计划不应自动规划") },
        executor: { execute: (input) => Effect.succeed(makeGraphResult(input)) },
      });
      return runner
        .run({ ...baseInput, executionId, plan })
        .pipe(Effect.map(() => executionStore.snapshots[0]?.planDigest));
    };
    const canonicalPlan = [
      {
        nodeId: "worker",
        agentId: "agent-worker",
        prompt: "完成实现",
        dependsOnNodeIds: [],
      },
      {
        nodeId: "review",
        agentId: "agent-reviewer",
        prompt: "审查实现",
        dependsOnNodeIds: ["worker"],
      },
    ];
    const equivalentPlan = [
      {
        dependsOnNodeIds: [],
        prompt: "  完成实现  ",
        agentId: "  agent-worker  ",
        nodeId: "  worker  ",
      },
      {
        dependsOnNodeIds: ["  worker  "],
        prompt: "  审查实现  ",
        agentId: "agent-reviewer",
        nodeId: "review",
      },
    ];
    const changedPrompt = [
      canonicalPlan[0]!,
      { ...canonicalPlan[1]!, prompt: "审查实现与测试日志" },
    ];
    const reorderedNodes = [canonicalPlan[1]!, canonicalPlan[0]!];

    const [canonical, equivalent, changed, reordered] = yield* Effect.all(
      [
        digestFor("execution-plan-canonical", canonicalPlan),
        digestFor("execution-plan-equivalent", equivalentPlan),
        digestFor("execution-plan-changed", changedPrompt),
        digestFor("execution-plan-reordered", reorderedNodes),
      ],
      { concurrency: 1 },
    );

    expect(canonical).toBeDefined();
    expect(equivalent).toBe(canonical);
    expect(changed).not.toBe(canonical);
    expect(reordered).not.toBe(canonical);
  }),
);

it.effect("空显式计划在 claim 前被拒绝", () =>
  Effect.gen(function* () {
    const executionStore = makeExecutionStoreHarness();
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: executionStore.store,
      planner: { plan: () => Effect.die("空显式计划不应自动规划") },
      executor: { execute: () => Effect.die("空显式计划不应执行") },
    });

    const error = yield* Effect.flip(
      runner.run({ ...baseInput, executionId: "execution-empty-plan", plan: [] }),
    );

    expect(error).toMatchObject({ code: "squad_plan_output_invalid" });
    expect(executionStore.snapshots).toEqual([]);
  }),
);

it.effect("Leader completed 缺少摘要时从 running 收口为 failed", () =>
  Effect.gen(function* () {
    const executionStore = makeExecutionStoreHarness();
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad),
      executions: executionStore.store,
      planner: {
        plan: () =>
          Effect.succeed([
            {
              nodeId: "missing-summary-worker",
              agentId: "agent-worker",
              prompt: "执行完成但 Leader 未给摘要",
              dependsOnNodeIds: [],
            },
          ]),
      },
      executor: { execute: (input) => Effect.succeed(makeGraphResult(input, "completed")) },
    });

    const error = yield* Effect.flip(
      runner.run({ ...baseInput, executionId: "execution-missing-summary" }),
    );

    expect(error).toMatchObject({ code: "squad_execution_result_invalid" });
    expect(executionStore.read()).toMatchObject({
      status: "failed",
      revision: 4,
      failureCode: "squad_execution_result_invalid",
      nodes: [{ nodeId: "missing-summary-worker" }],
    });
  }),
);

it.effect("最终 CAS 失败时保留 running 状态且不伪造 failed", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const executionStore = makeExecutionStoreHarness({
      failSaveStatus: "completed",
      events,
    });
    const runner = makeCompositionSquadRunner({
      squads: makeSquadLookup(baseSquad, events),
      executions: executionStore.store,
      planner: {
        plan: () =>
          Effect.succeed([
            {
              nodeId: "final-cas-worker",
              agentId: "agent-worker",
              prompt: "完成后触发最终 CAS 失败",
              dependsOnNodeIds: [],
            },
          ]),
      },
      executor: {
        execute: (input) => Effect.succeed(makeGraphResult(input, "completed", "已完成")),
      },
    });

    const error = yield* Effect.flip(
      runner.run({ ...baseInput, executionId: "execution-final-cas-failed" }),
    );

    expect(error).toMatchObject({
      code: "squad_execution_revision_conflict",
      expectedRevision: 3,
      actualRevision: 13,
    });
    expect(executionStore.read()).toMatchObject({ status: "running", revision: 3 });
    expect(events.at(-1)).toBe("store:save:completed");
    expect(events).not.toContain("store:save:failed");
  }),
);

it.effect("failed 状态保存失败时保留当前状态并写入脱敏审计", () => {
  const logs: Array<{ readonly message: string; readonly annotations: Record<string, unknown> }> =
    [];
  const logger = Logger.make<unknown, void>(({ fiber, message }) => {
    logs.push({
      message: String(message),
      annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
    });
  });
  const events: string[] = [];
  const executionStore = makeExecutionStoreHarness({ failSaveStatus: "failed", events });
  const runner = makeCompositionSquadRunner({
    squads: makeSquadLookup(baseSquad, events),
    executions: executionStore.store,
    planner: {
      plan: () =>
        Effect.fail(
          new CompositionSquadPlannerError({
            code: "leader_planning_failed",
            detail: "敏感规划失败详情 secret-plan",
            squadId: baseSquad.squadId,
          }),
        ),
    },
    executor: { execute: () => Effect.die("规划失败时不应执行") },
  });

  return Effect.gen(function* () {
    const error = yield* Effect.flip(
      runner.run({
        ...baseInput,
        executionId: "execution-failed-save-audit",
        goal: "敏感目标 secret-goal",
      }),
    );

    expect(error).toMatchObject({
      code: "squad_execution_revision_conflict",
      expectedRevision: 2,
      actualRevision: 12,
    });
    expect(executionStore.read()).toMatchObject({ status: "planning", revision: 2 });
    expect(events.at(-1)).toBe("store:save:failed");
    const audit = logs.find((entry) => entry.message.includes("失败状态持久化失败"));
    expect(audit?.annotations).toEqual({
      executionId: "execution-failed-save-audit",
      currentStatus: "planning",
      originalErrorCode: "leader_planning_failed",
    });
    const loggedText = [
      audit?.message ?? "",
      ...Object.values(audit?.annotations ?? {}).map(String),
    ].join("\n");
    expect(loggedText).not.toContain("secret-goal");
    expect(loggedText).not.toContain("secret-plan");
    expect(loggedText).not.toContain("failed 写入失败");
  }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
});

it.effect("SQL 与解码类持久化错误对 RPC 返回稳定脱敏信息", () =>
  Effect.gen(function* () {
    const runFailure = (
      executionId: string,
      error: PersistenceSqlError | PersistenceDecodeError,
    ) => {
      const runner = makeCompositionSquadRunner({
        squads: makeSquadLookup(baseSquad),
        executions: {
          claimExecution: () => Effect.fail(error),
          saveTransition: () => Effect.die("claim 失败后不应保存状态"),
        },
        planner: { plan: () => Effect.die("claim 失败后不应规划") },
        executor: { execute: () => Effect.die("claim 失败后不应执行") },
      });
      return Effect.flip(runner.run({ ...baseInput, executionId }));
    };
    const errors = yield* Effect.all(
      [
        runFailure(
          "execution-sql-redaction",
          new PersistenceSqlError({
            operation: "INSERT secret_execution_table",
            detail: "SELECT token FROM private_credentials",
            cause: new Error("plaintext-sql-secret"),
          }),
        ),
        runFailure(
          "execution-decode-redaction",
          new PersistenceDecodeError({
            operation: "DECODE secret_execution_payload",
            issue: "secret-schema-issue",
            cause: new Error("plaintext-decode-secret"),
          }),
        ),
      ],
      { concurrency: 1 },
    );

    for (const error of errors) {
      expect(error).toMatchObject({ code: "squad_execution_persistence_failed" });
      expect(error.detail).not.toContain("secret_execution");
      expect(error.detail).not.toContain("private_credentials");
      expect(error.detail).not.toContain("secret-schema-issue");
      expect(error.detail).not.toContain("plaintext-sql-secret");
      expect(error.detail).not.toContain("plaintext-decode-secret");
    }
  }),
);
