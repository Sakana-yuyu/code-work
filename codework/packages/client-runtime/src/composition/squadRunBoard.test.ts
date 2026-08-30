import type {
  CompositionSquadExecution,
  CompositionTaskSnapshot,
  CompositionTaskStatus,
} from "@codework/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildCompositionSquadCancelRequest,
  buildCompositionSquadRetryRequest,
  buildCompositionSquadReviewRequest,
  executeCompositionSquadNodeCommandWithRefresh,
  resolveCompositionSquadFailedNodeActions,
  resolveCompositionSquadNodeCancellable,
  resolveCompositionSquadNodeActionContext,
  projectCompositionSquadRunBoard,
  resolveCompositionSquadNodeEventTarget,
  resolveCompositionSquadReviewActions,
} from "./squadRunBoard.ts";

const makeSnapshot = (input: {
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly status?: CompositionTaskStatus;
}): CompositionTaskSnapshot => ({
  task: {
    taskId: input.taskId,
    projectId: "project-1",
    assigneeKind: "agent",
    assigneeId: input.agentId,
    mode: "parallel",
    status: input.status ?? "running",
    promptDigest: `digest-${input.taskId}`,
    dependsOnTaskIds: [],
    createdAtUnixMs: 100,
    updatedAtUnixMs: 200,
  },
  latestRun: {
    runId: input.runId,
    taskId: input.taskId,
    agentId: input.agentId,
    runtimeId: "runtime-1",
    status: input.status ?? "running",
    attempt: 1,
    capabilityGrantIds: [],
  },
});

const execution: CompositionSquadExecution = {
  executionId: "execution-1",
  squadId: "squad-1",
  squadRevision: 3,
  projectId: "project-1",
  goalDigest: "goal-digest",
  planDigest: "plan-digest",
  goalTaskId: "task-plan",
  workspaceRootDigest: "workspace-digest",
  status: "running",
  revision: 4,
  nodes: [
    {
      nodeId: "implement",
      agentId: "agent-worker",
      taskId: "task-worker",
      runId: "run-worker",
      promptDigest: "worker-digest",
      dependsOnNodeIds: [],
    },
  ],
  leaderTaskId: "task-finalize",
  leaderRunId: "run-finalize",
  pendingApprovals: [],
  createdAtUnixMs: 100,
  updatedAtUnixMs: 200,
  startedAtUnixMs: 110,
};

describe("projectCompositionSquadRunBoard", () => {
  it("按 execution 真实节点身份关联 Task 快照并保留没有快照的节点", () => {
    const plan = makeSnapshot({
      taskId: "task-plan",
      runId: "run-plan",
      agentId: "agent-leader",
      status: "completed",
    });
    const worker = makeSnapshot({
      taskId: "task-worker",
      runId: "run-worker",
      agentId: "agent-worker",
    });

    const [board] = projectCompositionSquadRunBoard([execution], [worker, plan]);

    expect(board?.nodes.map((node) => node.nodeId)).toEqual([
      "leader-plan",
      "implement",
      "leader-finalize",
    ]);
    expect(board?.nodes[0]?.snapshot).toBe(plan);
    expect(board?.nodes[1]?.snapshot).toBe(worker);
    expect(board?.nodes[2]).toMatchObject({
      nodeId: "leader-finalize",
      taskId: "task-finalize",
      runId: "run-finalize",
    });
    expect(board?.nodes[2]?.snapshot).toBeUndefined();
  });
});

describe("resolveCompositionSquadNodeEventTarget", () => {
  it("只为带最新 Run 的节点返回真实事件查询身份", () => {
    const snapshot = makeSnapshot({
      taskId: "task-worker",
      runId: "run-worker-latest",
      agentId: "agent-worker",
    });

    expect(
      resolveCompositionSquadNodeEventTarget({
        nodeId: "implement",
        taskId: "task-worker",
        runId: "run-worker-old",
        agentId: "agent-worker",
        snapshot,
      }),
    ).toEqual({ taskId: "task-worker", runId: "run-worker-latest" });
    expect(
      resolveCompositionSquadNodeEventTarget({
        nodeId: "leader-finalize",
        taskId: "task-finalize",
        runId: "run-finalize",
      }),
    ).toBeNull();
  });
});

describe("Squad failed node actions", () => {
  it("仅为失败节点开放原成员重试和具备能力的其他成员重派", () => {
    const failedNode = projectCompositionSquadRunBoard(
      [execution],
      [
        makeSnapshot({
          taskId: "task-worker",
          runId: "run-worker",
          agentId: "agent-worker",
          status: "failed",
        }),
      ],
    )[0]!.nodes[1]!;
    const squad = {
      members: [
        {
          agentId: "agent-worker",
          capabilityIds: ["shell", "git"],
          maxConcurrentTasks: 1,
        },
        {
          agentId: "agent-backup",
          capabilityIds: ["shell"],
          maxConcurrentTasks: 1,
        },
        {
          agentId: "agent-disabled",
          capabilityIds: ["shell"],
          maxConcurrentTasks: 0,
        },
      ],
    };

    const context = resolveCompositionSquadNodeActionContext(failedNode, squad);

    expect(context).toEqual({
      retryCapabilityIds: ["shell", "git"],
      reassignTargets: [{ agentId: "agent-backup", capabilityIds: ["shell"] }],
    });
    expect(resolveCompositionSquadFailedNodeActions(failedNode, context)).toEqual([
      "retry",
      "reassign",
    ]);
    expect(
      resolveCompositionSquadFailedNodeActions(
        {
          ...failedNode,
          snapshot: makeSnapshot({ ...failedNode.snapshot!.latestRun!, status: "running" }),
        },
        context,
      ),
    ).toEqual([]);
  });

  it("构造去重 capability 的新 Run 重试或指定 Agent 重派请求", () => {
    const failedNode = {
      nodeId: "implement",
      taskId: "task-worker",
      runId: "run-worker",
      snapshot: makeSnapshot({
        taskId: "task-worker",
        runId: "run-worker",
        agentId: "agent-worker",
        status: "failed",
      }),
    };

    expect(
      buildCompositionSquadRetryRequest({
        node: failedNode,
        capabilityIds: [" shell ", "git", "shell", ""],
        nextRunId: " run-next ",
        reason: " 重试失败节点 ",
      }),
    ).toEqual({
      taskId: "task-worker",
      previousRunId: "run-worker",
      runId: "run-next",
      reason: "重试失败节点",
      capabilityIds: ["shell", "git"],
    });
    expect(
      buildCompositionSquadRetryRequest({
        node: failedNode,
        capabilityIds: ["shell"],
        nextRunId: "run-reassign",
        reason: "重新分派",
        reassignAgentId: "agent-backup",
      }),
    ).toMatchObject({ runId: "run-reassign", agentId: "agent-backup" });
  });
});

describe("executeCompositionSquadNodeCommandWithRefresh", () => {
  it.each([
    ["Success", 1],
    ["Failure", 0],
  ] as const)("命令返回 %s 时刷新次数为 %s", async (_tag, refreshCount) => {
    const refreshExecutions = vi.fn();
    const refreshTasks = vi.fn();
    const refreshEvents = vi.fn();

    const result = await executeCompositionSquadNodeCommandWithRefresh(async () => ({ _tag }), {
      refreshExecutions,
      refreshTasks,
      refreshEvents,
    });

    expect(result).toEqual({ _tag });
    expect(refreshExecutions).toHaveBeenCalledTimes(refreshCount);
    expect(refreshTasks).toHaveBeenCalledTimes(refreshCount);
    expect(refreshEvents).toHaveBeenCalledTimes(refreshCount);
  });
});

describe("Squad review node actions", () => {
  it("只为 in_review 最新 Run 开放通过与驳回", () => {
    const reviewNode = {
      nodeId: "leader-finalize",
      taskId: "task-review",
      snapshot: makeSnapshot({
        taskId: "task-review",
        runId: "run-review",
        agentId: "agent-leader",
        status: "in_review",
      }),
    };

    expect(resolveCompositionSquadReviewActions(reviewNode)).toEqual(["approve", "reject"]);
    expect(
      resolveCompositionSquadReviewActions({
        ...reviewNode,
        snapshot: makeSnapshot({
          taskId: "task-review",
          runId: "run-review",
          agentId: "agent-leader",
          status: "waiting_approval",
        }),
      }),
    ).toEqual([]);
  });

  it("构造绑定最新 Run 的人工通过与驳回请求", () => {
    const node = {
      nodeId: "leader-finalize",
      taskId: "task-review",
      snapshot: makeSnapshot({
        taskId: "task-review",
        runId: "run-review",
        agentId: "agent-leader",
        status: "in_review",
      }),
    };

    expect(
      buildCompositionSquadReviewRequest({
        node,
        decision: "approve",
        reason: " 复核通过 ",
      }),
    ).toEqual({
      taskId: "task-review",
      runId: "run-review",
      decision: "approve",
      reason: "复核通过",
    });
    expect(
      buildCompositionSquadReviewRequest({ node, decision: "reject", reason: " " }),
    ).toBeNull();
  });
});

describe("Squad node cancellation", () => {
  it.each([
    ["running", true],
    ["waiting_approval", true],
    ["in_review", true],
    ["completed", false],
    ["failed", false],
    ["cancelled", false],
  ] as const)("最新 Run 为 %s 时可取消=%s", (status, expected) => {
    const node = {
      nodeId: "implement",
      taskId: "task-worker",
      snapshot: makeSnapshot({
        taskId: "task-worker",
        runId: "run-worker",
        agentId: "agent-worker",
        status,
      }),
    };
    expect(resolveCompositionSquadNodeCancellable(node)).toBe(expected);
  });

  it("构造绑定最新 Run 的取消请求并拒绝空理由", () => {
    const node = {
      nodeId: "implement",
      taskId: "task-worker",
      snapshot: makeSnapshot({
        taskId: "task-worker",
        runId: "run-worker",
        agentId: "agent-worker",
        status: "running",
      }),
    };

    expect(buildCompositionSquadCancelRequest({ node, reason: " 停止当前节点 " })).toEqual({
      taskId: "task-worker",
      runId: "run-worker",
      reason: "停止当前节点",
    });
    expect(buildCompositionSquadCancelRequest({ node, reason: " " })).toBeNull();
  });
});
