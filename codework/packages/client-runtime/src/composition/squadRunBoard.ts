import type {
  CompositionSquadExecution,
  CompositionSquadExecutionStatus,
  CompositionTaskEventsRequest,
  CompositionTaskSnapshot,
} from "@codework/contracts";

export interface CompositionSquadRunBoardNode {
  readonly nodeId: string;
  readonly taskId: string;
  readonly runId?: string;
  readonly agentId?: string;
  readonly snapshot?: CompositionTaskSnapshot;
}

export interface CompositionSquadRunBoardExecution {
  readonly executionId: string;
  readonly squadId: string;
  readonly squadRevision: number;
  readonly projectId: string;
  readonly status: CompositionSquadExecutionStatus;
  readonly pendingApprovalCount: number;
  readonly createdAtUnixMs: number;
  readonly updatedAtUnixMs: number;
  readonly resultSummary?: string;
  readonly failureCode?: string;
  readonly failureDetail?: string;
  readonly nodes: ReadonlyArray<CompositionSquadRunBoardNode>;
}

const attachTaskSnapshot = (
  node: Omit<CompositionSquadRunBoardNode, "snapshot">,
  snapshotsByTaskId: ReadonlyMap<string, CompositionTaskSnapshot>,
): CompositionSquadRunBoardNode => {
  const snapshot = snapshotsByTaskId.get(node.taskId);
  if (snapshot === undefined) return node;
  return {
    ...node,
    ...(snapshot.latestRun?.runId === undefined && node.runId === undefined
      ? {}
      : { runId: snapshot.latestRun?.runId ?? node.runId }),
    agentId: snapshot.latestRun?.agentId ?? node.agentId ?? snapshot.task.assigneeId,
    snapshot,
  };
};

/** 将持久化 execution 与最新 Task 快照关联为跨客户端可复用的 Run Board 读模型。 */
export const projectCompositionSquadRunBoard = (
  executions: ReadonlyArray<CompositionSquadExecution>,
  snapshots: ReadonlyArray<CompositionTaskSnapshot>,
): ReadonlyArray<CompositionSquadRunBoardExecution> => {
  const snapshotsByTaskId = new Map(
    snapshots.map((snapshot) => [snapshot.task.taskId, snapshot] as const),
  );
  return executions.map((execution) => ({
    executionId: execution.executionId,
    squadId: execution.squadId,
    squadRevision: execution.squadRevision,
    projectId: execution.projectId,
    status: execution.status,
    pendingApprovalCount: execution.pendingApprovals.length,
    createdAtUnixMs: execution.createdAtUnixMs,
    updatedAtUnixMs: execution.updatedAtUnixMs,
    ...(execution.resultSummary === undefined ? {} : { resultSummary: execution.resultSummary }),
    ...(execution.failureCode === undefined ? {} : { failureCode: execution.failureCode }),
    ...(execution.failureDetail === undefined ? {} : { failureDetail: execution.failureDetail }),
    nodes: [
      attachTaskSnapshot(
        { nodeId: "leader-plan", taskId: execution.goalTaskId },
        snapshotsByTaskId,
      ),
      ...(execution.nodes ?? []).map((node) =>
        attachTaskSnapshot(
          {
            nodeId: node.nodeId,
            taskId: node.taskId,
            runId: node.runId,
            agentId: node.agentId,
          },
          snapshotsByTaskId,
        ),
      ),
      attachTaskSnapshot(
        {
          nodeId: "leader-finalize",
          taskId: execution.leaderTaskId,
          runId: execution.leaderRunId,
        },
        snapshotsByTaskId,
      ),
    ],
  }));
};

/** 事件日志必须跟随最新 Run，避免节点重试后继续读取旧 Run。 */
export const resolveCompositionSquadNodeEventTarget = (
  node: CompositionSquadRunBoardNode | null,
): CompositionTaskEventsRequest | null => {
  const runId = node?.snapshot?.latestRun?.runId;
  return node === null || runId === undefined ? null : { taskId: node.taskId, runId };
};
