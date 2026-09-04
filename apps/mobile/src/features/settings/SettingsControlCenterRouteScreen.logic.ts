import {
  isByokDelegationControlTask,
  isByokResumeRedispatchable,
  type CompositionControlCenterByokResumeRedispatchRequest,
  type CompositionControlCenterRedispatchRequest,
  type CompositionControlCenterTask,
  type CompositionSquad,
  type CompositionSquadExecutionRequest,
  type CompositionSquadPlanNode,
  type CompositionTaskResumeRequest,
} from "@codework/contracts";

/** Goal Loop 五态 → i18n 标签键；未知状态返回 null，调用方回退为原始状态文本。 */
const GOAL_LOOP_STATE_LABEL_KEYS: Readonly<Record<string, string>> = {
  not_started: "controlCenter.state.notStarted",
  running: "controlCenter.state.running",
  converged: "controlCenter.state.converged",
  supervisor_settled: "controlCenter.state.supervisorSettled",
  interrupted: "controlCenter.state.interrupted",
};

export const goalLoopStateLabelKey = (state: string): string | null =>
  GOAL_LOOP_STATE_LABEL_KEYS[state] ?? null;

/** 与 Web 控制中心面板一致：仅这两种 Goal Loop 状态提供"自动重派"入口。 */
const REDISPATCHABLE_GOAL_LOOP_STATES: ReadonlySet<string> = new Set([
  "interrupted",
  "supervisor_settled",
]);

/** 与服务端投影的活跃 Run 状态集一致：仅这些 Run 提供取消入口。 */
const CANCELLABLE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "dispatched",
  "resuming",
  "running",
  "waiting_approval",
  "waiting_input",
  "in_review",
]);

const RESUMABLE_RUN_STATUSES: ReadonlySet<string> = new Set(["waiting_approval", "waiting_input"]);

export interface ControlCenterTaskActions {
  readonly redispatchable: boolean;
  readonly cancellable: boolean;
  readonly resumable: boolean;
  readonly reviewable: boolean;
  readonly abandonable: boolean;
  readonly byokResumable: boolean;
}

export const resolveControlCenterEventTarget = (
  tasks: ReadonlyArray<CompositionControlCenterTask>,
  selectedTaskId: string | null,
): { readonly taskId: string; readonly runId: string } | null => {
  if (selectedTaskId === null) return null;
  const task = tasks.find((candidate) => candidate.taskId === selectedTaskId);
  return task?.latestRun === undefined
    ? null
    : { taskId: task.taskId, runId: task.latestRun.runId };
};

export const sortControlCenterSquads = (
  squads: ReadonlyArray<CompositionSquad>,
): ReadonlyArray<CompositionSquad> =>
  squads
    .filter((squad) => squad.archivedAtUnixMs === undefined)
    // .sort() on the filtered copy, not .toSorted(): Hermes doesn't ship the
    // ES2023 change-by-copy array methods.
    .sort(
      (left, right) =>
        (right.updatedAtUnixMs ?? 0) - (left.updatedAtUnixMs ?? 0) ||
        left.name.localeCompare(right.name),
    );

export type ControlCenterSquadRunIssue =
  | "squad_missing"
  | "project_missing"
  | "goal_required"
  | "squad_archived"
  | "squad_configuration_incomplete"
  | "dependency_plan_required"
  | "dependency_plan_node_required"
  | "dependency_plan_duplicate_node"
  | "dependency_plan_agent_unknown"
  | "dependency_plan_dependency_unknown"
  | "dependency_plan_self_dependency"
  | "dependency_plan_cycle";

export interface ControlCenterSquadPlanNodeDraft {
  readonly clientId: string;
  readonly nodeId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly dependsOnNodeIdsText: string;
}

export const createControlCenterSquadPlanNodeDraft = (input: {
  readonly clientId: string;
  readonly agentId: string;
  readonly current: ReadonlyArray<ControlCenterSquadPlanNodeDraft>;
}): ControlCenterSquadPlanNodeDraft => {
  const occupiedNodeIds = new Set(input.current.map((node) => node.nodeId.trim()));
  let nextNodeNumber = 1;
  while (occupiedNodeIds.has(`node-${nextNodeNumber}`)) nextNodeNumber += 1;
  return {
    clientId: input.clientId,
    nodeId: `node-${nextNodeNumber}`,
    agentId: input.agentId,
    prompt: "",
    dependsOnNodeIdsText: "",
  };
};

const dependencyIdsFromText = (value: string): ReadonlyArray<string> => [
  ...new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  ),
];

const dependencyPlanHasCycle = (plan: ReadonlyArray<CompositionSquadPlanNode>): boolean => {
  const dependenciesByNodeId = new Map(plan.map((node) => [node.nodeId, node.dependsOnNodeIds]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const dependencyId of dependenciesByNodeId.get(nodeId) ?? []) {
      if (visit(dependencyId)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };

  return plan.some((node) => visit(node.nodeId));
};

export const buildControlCenterSquadRunRequest = (input: {
  readonly executionId: string;
  readonly squad: CompositionSquad | null;
  readonly project: { readonly id: string; readonly workspaceRoot: string } | null;
  readonly goal: string;
  readonly planDrafts?: ReadonlyArray<ControlCenterSquadPlanNodeDraft>;
}): {
  readonly request: CompositionSquadExecutionRequest | null;
  readonly issue: ControlCenterSquadRunIssue | null;
} => {
  const { squad, project } = input;
  const goal = input.goal.trim();
  if (squad === null) return { request: null, issue: "squad_missing" };
  if (project === null) return { request: null, issue: "project_missing" };
  if (goal.length === 0) return { request: null, issue: "goal_required" };
  if (squad.archivedAtUnixMs !== undefined) {
    return { request: null, issue: "squad_archived" };
  }
  if (
    squad.collaborationMode === undefined ||
    squad.members === undefined ||
    squad.maxConcurrency === undefined ||
    squad.failurePolicy === undefined ||
    squad.partialSuccessPolicy === undefined
  ) {
    return { request: null, issue: "squad_configuration_incomplete" };
  }
  let plan: ReadonlyArray<CompositionSquadPlanNode> | undefined;
  if (squad.collaborationMode === "dependency_graph") {
    const drafts = input.planDrafts ?? [];
    if (drafts.length === 0) return { request: null, issue: "dependency_plan_required" };
    plan = drafts.map((draft) => ({
      nodeId: draft.nodeId.trim(),
      agentId: draft.agentId.trim(),
      prompt: draft.prompt.trim(),
      dependsOnNodeIds: dependencyIdsFromText(draft.dependsOnNodeIdsText),
    }));
    if (plan.some((node) => node.nodeId === "" || node.agentId === "" || node.prompt === "")) {
      return { request: null, issue: "dependency_plan_node_required" };
    }
    const nodeIds = new Set(plan.map((node) => node.nodeId));
    if (nodeIds.size !== plan.length) {
      return { request: null, issue: "dependency_plan_duplicate_node" };
    }
    const squadAgentIds = new Set(squad.members.map((member) => member.agentId));
    if (plan.some((node) => !squadAgentIds.has(node.agentId))) {
      return { request: null, issue: "dependency_plan_agent_unknown" };
    }
    if (
      plan.some((node) => node.dependsOnNodeIds.some((dependencyId) => !nodeIds.has(dependencyId)))
    ) {
      return { request: null, issue: "dependency_plan_dependency_unknown" };
    }
    if (plan.some((node) => node.dependsOnNodeIds.includes(node.nodeId))) {
      return { request: null, issue: "dependency_plan_self_dependency" };
    }
    if (dependencyPlanHasCycle(plan)) {
      return { request: null, issue: "dependency_plan_cycle" };
    }
  }
  return {
    request: {
      executionId: input.executionId,
      squadId: squad.squadId,
      squadRevision: squad.revision ?? 1,
      projectId: project.id,
      goal,
      workspaceRoot: project.workspaceRoot,
      ...(plan === undefined ? {} : { plan }),
    },
    issue: null,
  };
};

/**
 * 行操作渲染门槛，与 Web 控制中心面板逐条对齐：
 * - 重派：goalLoop interrupted/supervisor_settled 且存在最新 Run；
 * - 取消：最新 Run 处于活跃状态；
 * - 审批：任务状态 in_review 且存在最新 Run（后端对非 in_review 显式报错）；
 * - 放弃：仅 goalLoop interrupted（supervisor_settled 已有结算行，再落 abandon 会被拒）；
 * - 恢复并重派：与 Web 共用 `isByokResumeRedispatchable`（存在最新 Run、排除已结算，
 *   接受 byok_resume_interrupted 或可恢复 checkpoint 链）；
 * - BYOK 委派行不套 Goal Loop 五态，只在最新 Run 活跃时复用 composition cancel。
 */
export const resolveControlCenterTaskActions = (
  task: CompositionControlCenterTask,
): ControlCenterTaskActions => {
  if (isByokDelegationControlTask(task)) {
    return {
      redispatchable: false,
      cancellable:
        task.latestRun !== undefined && CANCELLABLE_RUN_STATUSES.has(task.latestRun.status),
      resumable: false,
      reviewable: false,
      abandonable: false,
      byokResumable: false,
    };
  }
  return {
    redispatchable:
      task.latestRun !== undefined &&
      task.goalLoop !== undefined &&
      REDISPATCHABLE_GOAL_LOOP_STATES.has(task.goalLoop.state),
    cancellable:
      task.latestRun !== undefined && CANCELLABLE_RUN_STATUSES.has(task.latestRun.status),
    resumable:
      task.latestRun !== undefined &&
      task.latestRun.runtimeTaskId !== undefined &&
      task.latestRun.status === task.status &&
      RESUMABLE_RUN_STATUSES.has(task.status),
    reviewable: task.status === "in_review" && task.latestRun !== undefined,
    abandonable: task.latestRun !== undefined && task.goalLoop?.state === "interrupted",
    byokResumable: isByokResumeRedispatchable(task),
  };
};

export const buildResumeInput = (input: {
  readonly taskId: string;
  readonly runId: string;
  readonly reason: string;
}): CompositionTaskResumeRequest => ({
  taskId: input.taskId,
  runId: input.runId,
  reason: input.reason,
});

/** 控制中心"自动重派"请求输入：capabilityIds 按逗号拆分并去除空白项，与 Web 面板一致。 */
export const buildRedispatchInput = (input: {
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly newRunId: string;
  readonly capabilityIdsText: string;
}): CompositionControlCenterRedispatchRequest => ({
  taskId: input.taskId,
  runId: input.runId,
  agentId: input.agentId,
  newRunId: input.newRunId,
  capabilityIds: input.capabilityIdsText
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
});

/** 恢复并重派请求：移动端不提供 capabilityIds 输入，固定空数组。 */
export const buildByokResumeRedispatchInput = (input: {
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly newRunId: string;
  readonly note: string;
}): CompositionControlCenterByokResumeRedispatchRequest => ({
  ...buildRedispatchInput({ ...input, capabilityIdsText: "" }),
  note: input.note,
});

/** Goal Loop 摘要行：轮次固定展示，拒绝数仅在 >0 时追加。 */
export const formatGoalLoopMeta = (
  labels: { readonly rounds: string; readonly rejected: string },
  goalLoop: { readonly completedRounds: number; readonly rejectedCompletions: number },
): string =>
  goalLoop.rejectedCompletions > 0
    ? `${labels.rounds}: ${goalLoop.completedRounds} · ${labels.rejected}: ${goalLoop.rejectedCompletions}`
    : `${labels.rounds}: ${goalLoop.completedRounds}`;

/** Grant 摘要行：事件总数固定展示，撤销数仅在 >0 时追加。 */
export const formatGrantMeta = (
  labels: { readonly grants: string; readonly revoked: string },
  grants: { readonly totalEvents: number; readonly revokedEvents: number },
): string =>
  grants.revokedEvents > 0
    ? `${labels.grants}: ${grants.totalEvents} · ${labels.revoked}: ${grants.revokedEvents}`
    : `${labels.grants}: ${grants.totalEvents}`;

/** BYOK 恢复摘要行：段数固定展示，可恢复时追加字节数，否则标记不可恢复。 */
export const formatByokResumeMeta = (
  labels: {
    readonly checkpoints: string;
    readonly recoveredBytes: string;
    readonly unrecoverable: string;
  },
  byokResume: {
    readonly checkpointCount: number;
    readonly recoveredUtf8Bytes: number;
    readonly recoverable: boolean;
  },
): string =>
  byokResume.recoverable
    ? `${labels.checkpoints}: ${byokResume.checkpointCount} · ${labels.recoveredBytes}: ${byokResume.recoveredUtf8Bytes}`
    : `${labels.checkpoints}: ${byokResume.checkpointCount} · ${labels.unrecoverable}`;

/** BYOK 委派摘要行：agentId 与轮次固定展示，错误码仅在存在时追加。 */
export const formatByokDelegationMeta = (
  labels: { readonly rounds: string; readonly errorCode: string },
  input: {
    readonly agentId: string;
    readonly attempt: number;
    readonly failureCode?: string;
  },
): string =>
  input.failureCode === undefined
    ? `${input.agentId} · ${labels.rounds}: ${input.attempt}`
    : `${input.agentId} · ${labels.rounds}: ${input.attempt} · ${labels.errorCode}: ${input.failureCode}`;

/** Squad 名册摘要行：队长与成员数。 */
export const formatSquadMeta = (
  labels: { readonly leader: string; readonly members: string },
  squad: { readonly leaderAgentId: string; readonly memberAgentIds: readonly string[] },
): string =>
  `${labels.leader}: ${squad.leaderAgentId} · ${labels.members}: ${squad.memberAgentIds.length}`;
