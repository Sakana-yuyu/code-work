import type {
  CompositionSquadExecution,
  CompositionSquadExecutionStatus,
  CompositionTaskEventsRequest,
  CompositionTaskRetryRequest,
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

export interface CompositionSquadNodeActionMember {
  readonly agentId: string;
  readonly capabilityIds: ReadonlyArray<string>;
  readonly maxConcurrentTasks: number;
}

export interface CompositionSquadNodeActionSource {
  readonly members?: ReadonlyArray<CompositionSquadNodeActionMember>;
}

export interface CompositionSquadReassignTarget {
  readonly agentId: string;
  readonly capabilityIds: ReadonlyArray<string>;
}

export interface CompositionSquadNodeActionContext {
  readonly retryCapabilityIds: ReadonlyArray<string>;
  readonly reassignTargets: ReadonlyArray<CompositionSquadReassignTarget>;
}

export type CompositionSquadFailedNodeAction = "retry" | "reassign";

export interface CompositionSquadRunBoardRefreshers {
  readonly refreshExecutions: () => void;
  readonly refreshTasks: () => void;
  readonly refreshEvents: () => void;
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

const normalizeCapabilityIds = (capabilityIds: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Set(capabilityIds.map((capabilityId) => capabilityId.trim()).filter(Boolean)),
];

/** 从 Squad 成员配置中提取当前节点重试能力和可用重派目标。 */
export const resolveCompositionSquadNodeActionContext = (
  node: CompositionSquadRunBoardNode,
  squad: CompositionSquadNodeActionSource | null,
): CompositionSquadNodeActionContext => {
  const currentAgentId =
    node.snapshot?.latestRun?.agentId ?? node.agentId ?? node.snapshot?.task.assigneeId;
  if (currentAgentId === undefined || squad?.members === undefined) {
    return { retryCapabilityIds: [], reassignTargets: [] };
  }
  const currentMember = squad.members.find((member) => member.agentId === currentAgentId);
  return {
    retryCapabilityIds: normalizeCapabilityIds(currentMember?.capabilityIds ?? []),
    reassignTargets: squad.members.flatMap((member) => {
      const capabilityIds = normalizeCapabilityIds(member.capabilityIds);
      return member.agentId === currentAgentId ||
        member.maxConcurrentTasks <= 0 ||
        capabilityIds.length === 0
        ? []
        : [{ agentId: member.agentId, capabilityIds }];
    }),
  };
};

export const resolveCompositionSquadFailedNodeActions = (
  node: CompositionSquadRunBoardNode,
  context: CompositionSquadNodeActionContext,
): ReadonlyArray<CompositionSquadFailedNodeAction> => {
  const status = node.snapshot?.latestRun?.status;
  if (status !== "failed" && status !== "timed_out") return [];
  const actions: CompositionSquadFailedNodeAction[] = [];
  if (context.retryCapabilityIds.length > 0) actions.push("retry");
  if (context.reassignTargets.length > 0) actions.push("reassign");
  return actions;
};

/** 构造服务端现有 retry RPC 输入；指定 reassignAgentId 即为重新分派。 */
export const buildCompositionSquadRetryRequest = (input: {
  readonly node: CompositionSquadRunBoardNode;
  readonly capabilityIds: ReadonlyArray<string>;
  readonly nextRunId: string;
  readonly reason: string;
  readonly reassignAgentId?: string;
}): CompositionTaskRetryRequest | null => {
  const run = input.node.snapshot?.latestRun;
  const capabilityIds = normalizeCapabilityIds(input.capabilityIds);
  const runId = input.nextRunId.trim();
  const reason = input.reason.trim();
  const reassignAgentId = input.reassignAgentId?.trim();
  if (
    run === undefined ||
    (run.status !== "failed" && run.status !== "timed_out") ||
    capabilityIds.length === 0 ||
    runId.length === 0 ||
    reason.length === 0 ||
    (input.reassignAgentId !== undefined &&
      (reassignAgentId === undefined ||
        reassignAgentId.length === 0 ||
        reassignAgentId === run.agentId))
  ) {
    return null;
  }
  return {
    taskId: input.node.taskId,
    previousRunId: run.runId,
    runId,
    ...(reassignAgentId === undefined ? {} : { agentId: reassignAgentId }),
    reason,
    capabilityIds,
  };
};

/** 节点命令只在服务端确认成功后刷新 execution、Task 和当前事件。 */
export const executeCompositionSquadNodeCommandWithRefresh = async <
  Result extends { readonly _tag: "Success" | "Failure" },
>(
  execute: () => Promise<Result>,
  refreshers: CompositionSquadRunBoardRefreshers,
): Promise<Result> => {
  const result = await execute();
  if (result._tag === "Success") {
    refreshers.refreshExecutions();
    refreshers.refreshTasks();
    refreshers.refreshEvents();
  }
  return result;
};
