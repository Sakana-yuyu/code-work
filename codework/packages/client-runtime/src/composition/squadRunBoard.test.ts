import type { CompositionSquadExecution, CompositionTaskSnapshot } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  projectCompositionSquadRunBoard,
  resolveCompositionSquadNodeEventTarget,
} from "./squadRunBoard.ts";

const makeSnapshot = (input: {
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly status?: "running" | "completed";
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
