import type {
  CompositionSquad,
  CompositionTaskSnapshot,
  CompositionTaskStatus,
} from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  advanceCompositionSquadRunDraft,
  buildCompositionSquadExecutionRequest,
  compositionSquadRunEnvironmentKey,
  parseCompositionSquadExecutionTaskId,
  projectCompositionSquadExecutionHistory,
  type CompositionSquadRunDraft,
} from "./CompositionSquadRunPanel.logic";

const dependencyGraphSquad: CompositionSquad = {
  squadId: "squad-build",
  name: "Build Squad",
  leaderAgentId: "agent-lead",
  memberAgentIds: ["agent-lead", "agent-build", "agent-review"],
  revision: 4,
  collaborationMode: "dependency_graph",
  members: [
    {
      agentId: "agent-lead",
      role: "leader",
      order: 0,
      required: true,
      capabilityIds: [],
      maxConcurrentTasks: 1,
    },
    {
      agentId: "agent-build",
      role: "worker",
      order: 1,
      required: true,
      capabilityIds: ["fs.write"],
      maxConcurrentTasks: 1,
    },
    {
      agentId: "agent-review",
      role: "reviewer",
      order: 2,
      required: true,
      capabilityIds: ["fs.read"],
      maxConcurrentTasks: 1,
    },
  ],
  maxConcurrency: 2,
  failurePolicy: "continue_independent",
  partialSuccessPolicy: "require_review",
};

const makeDraft = (
  overrides: Partial<CompositionSquadRunDraft> = {},
): CompositionSquadRunDraft => ({
  executionId: " execution-1 ",
  projectId: " project-1 ",
  threadId: " thread-1 ",
  goal: " implement the feature ",
  workspaceRoot: " E:\\workspace\\project ",
  planText: JSON.stringify([
    {
      nodeId: " build ",
      agentId: " agent-build ",
      prompt: " implement ",
      dependsOnNodeIds: [],
    },
    {
      nodeId: " review ",
      agentId: " agent-review ",
      prompt: " verify ",
      dependsOnNodeIds: [" build "],
    },
  ]),
  ...overrides,
});

const taskSnapshot = (input: {
  readonly taskId: string;
  readonly status: CompositionTaskStatus;
  readonly updatedAtUnixMs: number;
  readonly agentId: string;
  readonly resultSummary?: string;
  readonly failureCode?: string;
}): CompositionTaskSnapshot => ({
  task: {
    taskId: input.taskId,
    projectId: "project-1",
    assigneeKind: input.taskId.endsWith(":leader-finalize") ? "squad" : "agent",
    assigneeId: input.agentId,
    mode: input.taskId.endsWith(":leader-finalize") ? "review" : "parallel",
    status: input.status,
    promptDigest: `sha256:${input.taskId}`,
    dependsOnTaskIds: [],
    createdAtUnixMs: input.updatedAtUnixMs - 10,
    updatedAtUnixMs: input.updatedAtUnixMs,
  },
  latestRun: {
    runId: `${input.taskId}:run:1`,
    taskId: input.taskId,
    agentId: input.agentId,
    runtimeId: `runtime:${input.agentId}`,
    status: input.status,
    attempt: 1,
    capabilityGrantIds: [],
    ...(input.resultSummary === undefined ? {} : { resultSummary: input.resultSummary }),
    ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
  },
});

describe("CompositionSquadRunPanel logic", () => {
  it("将运行请求绑定到 executionId、Squad 和当前 revision，并修剪可选字段", () => {
    const result = buildCompositionSquadExecutionRequest(makeDraft(), dependencyGraphSquad);

    expect(result).toEqual({
      request: {
        executionId: "execution-1",
        squadId: "squad-build",
        squadRevision: 4,
        projectId: "project-1",
        threadId: "thread-1",
        goal: "implement the feature",
        workspaceRoot: "E:\\workspace\\project",
        plan: [
          {
            nodeId: "build",
            agentId: "agent-build",
            prompt: "implement",
            dependsOnNodeIds: [],
          },
          {
            nodeId: "review",
            agentId: "agent-review",
            prompt: "verify",
            dependsOnNodeIds: ["build"],
          },
        ],
      },
      issues: [],
    });
  });

  it("空 threadId 不进入请求", () => {
    const result = buildCompositionSquadExecutionRequest(
      makeDraft({ threadId: "  " }),
      dependencyGraphSquad,
    );

    expect(result.request).not.toHaveProperty("threadId");
  });

  it.each([
    ["executionId", "execution_id_required"],
    ["projectId", "project_id_required"],
    ["goal", "goal_required"],
    ["workspaceRoot", "workspace_root_required"],
  ] as const)("拒绝空白必填字段 %s", (field, code) => {
    const result = buildCompositionSquadExecutionRequest(
      makeDraft({ [field]: "  " }),
      dependencyGraphSquad,
    );

    expect(result.request).toBeNull();
    expect(result.issues).toContainEqual({ code, path: field });
  });

  it("dependency_graph 模式拒绝缺失的显式计划", () => {
    const result = buildCompositionSquadExecutionRequest(
      makeDraft({ planText: "  " }),
      dependencyGraphSquad,
    );

    expect(result.request).toBeNull();
    expect(result.issues).toContainEqual({ code: "plan_required", path: "plan" });
  });

  it("拒绝无法解析的计划 JSON", () => {
    const result = buildCompositionSquadExecutionRequest(
      makeDraft({ planText: "[{" }),
      dependencyGraphSquad,
    );

    expect(result.request).toBeNull();
    expect(result.issues).toContainEqual({ code: "plan_invalid_json", path: "plan" });
  });

  it.each([
    [
      "重复 nodeId",
      [
        { nodeId: "same", agentId: "agent-build", prompt: "one", dependsOnNodeIds: [] },
        { nodeId: "same", agentId: "agent-review", prompt: "two", dependsOnNodeIds: [] },
      ],
      "plan_duplicate_node",
      "plan[1].nodeId",
    ],
    [
      "未知 agentId",
      [{ nodeId: "build", agentId: "agent-other", prompt: "one", dependsOnNodeIds: [] }],
      "plan_unknown_agent",
      "plan[0].agentId",
    ],
    [
      "Leader 作为子节点执行者",
      [{ nodeId: "build", agentId: "agent-lead", prompt: "one", dependsOnNodeIds: [] }],
      "plan_unknown_agent",
      "plan[0].agentId",
    ],
    [
      "未知依赖",
      [
        {
          nodeId: "build",
          agentId: "agent-build",
          prompt: "one",
          dependsOnNodeIds: ["missing"],
        },
      ],
      "plan_unknown_dependency",
      "plan[0].dependsOnNodeIds[0]",
    ],
    [
      "自依赖",
      [
        {
          nodeId: "build",
          agentId: "agent-build",
          prompt: "one",
          dependsOnNodeIds: ["build"],
        },
      ],
      "plan_self_dependency",
      "plan[0].dependsOnNodeIds[0]",
    ],
    [
      "循环依赖",
      [
        {
          nodeId: "build",
          agentId: "agent-build",
          prompt: "one",
          dependsOnNodeIds: ["review"],
        },
        {
          nodeId: "review",
          agentId: "agent-review",
          prompt: "two",
          dependsOnNodeIds: ["build"],
        },
      ],
      "plan_cycle",
      "plan",
    ],
  ] as const)("拒绝%s", (_label, plan, code, path) => {
    const result = buildCompositionSquadExecutionRequest(
      makeDraft({ planText: JSON.stringify(plan) }),
      dependencyGraphSquad,
    );

    expect(result.request).toBeNull();
    expect(result.issues).toContainEqual({ code, path });
  });

  it("非依赖图模式可以让服务端按协同策略生成默认计划", () => {
    const result = buildCompositionSquadExecutionRequest(makeDraft({ planText: "" }), {
      ...dependencyGraphSquad,
      collaborationMode: "parallel",
    });

    expect(result.issues).toEqual([]);
    expect(result.request).not.toHaveProperty("plan");
  });

  it("成功后只轮换下一次运行的 executionId", () => {
    const draft = makeDraft();

    expect(advanceCompositionSquadRunDraft(draft, " execution-2 ")).toEqual({
      ...draft,
      executionId: "execution-2",
    });
  });

  it("环境键区分断开状态和不同服务器，供面板切换时完整重置本地状态", () => {
    expect(compositionSquadRunEnvironmentKey(null)).toBe("disconnected");
    expect(compositionSquadRunEnvironmentKey("env-a")).toBe("environment:env-a");
    expect(compositionSquadRunEnvironmentKey("env-b")).toBe("environment:env-b");
  });

  it("从稳定 taskId 解析 execution、Squad revision 和节点，并支持 ID 中包含冒号", () => {
    expect(
      parseCompositionSquadExecutionTaskId(
        "execution:west:squad:squad:build:r4:task:review",
        "squad:build",
      ),
    ).toEqual({
      executionId: "execution:west",
      squadRevision: 4,
      nodeId: "review",
    });
  });

  it.each([
    ["其他 Squad", "execution-1:squad:squad-other:r4:task:build"],
    ["revision 非正整数", "execution-1:squad:squad-build:r0:task:build"],
    ["缺少节点", "execution-1:squad:squad-build:r4:task:"],
  ])("拒绝%s的 taskId", (_label, taskId) => {
    expect(parseCompositionSquadExecutionTaskId(taskId, "squad-build")).toBeNull();
  });

  it("从持久化 Task/Run 快照恢复 Squad execution 历史并按最新活动排序", () => {
    const history = projectCompositionSquadExecutionHistory("squad-build", [
      taskSnapshot({
        taskId: "execution-old:squad:squad-build:r3:task:leader-finalize",
        status: "completed",
        updatedAtUnixMs: 100,
        agentId: "agent-lead",
        resultSummary: "旧运行已完成",
      }),
      taskSnapshot({
        taskId: "execution-new:squad:squad-build:r4:task:review",
        status: "failed",
        updatedAtUnixMs: 220,
        agentId: "agent-review",
        failureCode: "provider_timeout",
      }),
      taskSnapshot({
        taskId: "execution-new:squad:squad-build:r4:task:build",
        status: "completed",
        updatedAtUnixMs: 210,
        agentId: "agent-build",
        resultSummary: "实现完成",
      }),
      taskSnapshot({
        taskId: "execution-new:squad:squad-build:r4:task:leader-finalize",
        status: "in_review",
        updatedAtUnixMs: 230,
        agentId: "agent-lead",
      }),
      taskSnapshot({
        taskId: "execution-new:squad:squad-build:r4:task:leader-plan",
        status: "completed",
        updatedAtUnixMs: 200,
        agentId: "agent-lead",
      }),
      taskSnapshot({
        taskId: "execution-other:squad:squad-other:r1:task:build",
        status: "running",
        updatedAtUnixMs: 999,
        agentId: "agent-other",
      }),
    ]);

    expect(history.map((execution) => execution.executionId)).toEqual([
      "execution-new",
      "execution-old",
    ]);
    expect(history[0]).toMatchObject({
      squadId: "squad-build",
      squadRevision: 4,
      status: "in_review",
      updatedAtUnixMs: 230,
    });
    expect(history[0]?.nodes.map((node) => node.nodeId)).toEqual([
      "leader-plan",
      "build",
      "review",
      "leader-finalize",
    ]);
    expect(history[0]?.nodes[2]?.snapshot.latestRun).toMatchObject({
      agentId: "agent-review",
      failureCode: "provider_timeout",
    });
  });

  it.each([
    [
      "空 nodeId",
      [{ nodeId: " ", agentId: "agent-build", prompt: "one", dependsOnNodeIds: [] }],
      "plan[0].nodeId",
    ],
    [
      "空 agentId",
      [{ nodeId: "build", agentId: " ", prompt: "one", dependsOnNodeIds: [] }],
      "plan[0].agentId",
    ],
    [
      "空 prompt",
      [{ nodeId: "build", agentId: "agent-build", prompt: " ", dependsOnNodeIds: [] }],
      "plan[0].prompt",
    ],
    [
      "空依赖项",
      [{ nodeId: "build", agentId: "agent-build", prompt: "one", dependsOnNodeIds: [" "] }],
      "plan[0].dependsOnNodeIds[0]",
    ],
  ] as const)("拒绝%s", (_label, plan, path) => {
    const result = buildCompositionSquadExecutionRequest(
      makeDraft({ planText: JSON.stringify(plan) }),
      dependencyGraphSquad,
    );

    expect(result.request).toBeNull();
    expect(result.issues).toContainEqual({ code: "plan_invalid_shape", path });
  });

  it.each([
    ["对象", JSON.stringify({ nodeId: "build" })],
    ["空数组", "[]"],
  ])("dependency_graph 拒绝%s计划形状", (_label, planText) => {
    const result = buildCompositionSquadExecutionRequest(
      makeDraft({ planText }),
      dependencyGraphSquad,
    );

    expect(result.request).toBeNull();
    expect(result.issues).toContainEqual({ code: "plan_invalid_shape", path: "plan" });
  });
});
