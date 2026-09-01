import {
  ThreadId,
  type CompositionSquad,
  type CompositionSquadExecution,
  type CompositionSquadExecutionRequest,
  type CompositionSquadExecutionStatus,
  type CompositionSquadPlanNode,
  type CompositionTaskCancelRequest,
  type CompositionTaskResumeRequest,
  type CompositionTaskRetryRequest,
  type CompositionTaskReviewRequest,
  type CompositionTaskSnapshot,
  type CompositionTaskStatus,
} from "@codework/contracts";

export interface CompositionSquadRunDraft {
  readonly executionId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly goal: string;
  readonly workspaceRoot: string;
  readonly planText: string;
}

export type CompositionSquadRunIssueCode =
  | "execution_id_required"
  | "project_id_required"
  | "goal_required"
  | "workspace_root_required"
  | "squad_archived"
  | "squad_configuration_incomplete"
  | "plan_required"
  | "plan_invalid_json"
  | "plan_invalid_shape"
  | "plan_duplicate_node"
  | "plan_unknown_agent"
  | "plan_unknown_dependency"
  | "plan_self_dependency"
  | "plan_cycle";

export interface CompositionSquadRunIssue {
  readonly code: CompositionSquadRunIssueCode;
  readonly path: string;
}

export interface CompositionSquadRunBuildResult {
  readonly request: CompositionSquadExecutionRequest | null;
  readonly issues: ReadonlyArray<CompositionSquadRunIssue>;
}

export interface CompositionSquadExecutionTaskIdentity {
  readonly executionId: string;
  readonly squadRevision: number;
  readonly nodeId: string;
}

export interface CompositionSquadExecutionHistoryNode {
  readonly nodeId: string;
  readonly taskId: string;
  readonly runId?: string;
  readonly agentId?: string;
  readonly snapshot?: CompositionTaskSnapshot;
}

export interface CompositionSquadExecutionHistoryItem {
  readonly source: "execution_record" | "legacy_tasks";
  readonly executionId: string;
  readonly squadId: string;
  readonly squadRevision: number;
  readonly projectId: string;
  readonly status: CompositionSquadExecutionStatus | CompositionTaskStatus;
  readonly failureCode?: string;
  readonly failureDetail?: string;
  readonly updatedAtUnixMs: number;
  readonly nodes: ReadonlyArray<CompositionSquadExecutionHistoryNode>;
}

export type CompositionSquadNodeAction =
  | "cancel"
  | "resume"
  | "approve"
  | "reject"
  | "retry"
  | "reassign";

export interface CompositionSquadReassignTarget {
  readonly agentId: string;
  readonly capabilityIds: ReadonlyArray<string>;
}

export type CompositionSquadNodeActionRequest =
  | { readonly kind: "cancel"; readonly input: CompositionTaskCancelRequest }
  | { readonly kind: "resume"; readonly input: CompositionTaskResumeRequest }
  | { readonly kind: "review"; readonly input: CompositionTaskReviewRequest }
  | { readonly kind: "retry"; readonly input: CompositionTaskRetryRequest };

export const compositionSquadRunEnvironmentKey = (environmentId: string | null): string =>
  environmentId === null ? "disconnected" : `environment:${environmentId}`;

export interface CompositionSquadRunHistoryRefreshers {
  readonly refreshExecutions: () => void;
  readonly refreshTasks: () => void;
}

export interface CompositionSquadNodeActionHistoryRefreshers extends CompositionSquadRunHistoryRefreshers {
  readonly refreshEvents: () => void;
}

export const executeCompositionSquadRunWithHistoryRefresh = async <Result>(
  execute: () => Promise<Result>,
  refreshers: CompositionSquadRunHistoryRefreshers,
): Promise<Result> => {
  try {
    return await execute();
  } finally {
    refreshers.refreshExecutions();
    refreshers.refreshTasks();
  }
};

export const executeCompositionSquadNodeActionWithHistoryRefresh = async <
  Result extends { readonly _tag: "Success" | "Failure" },
>(
  execute: () => Promise<Result>,
  refreshers: CompositionSquadNodeActionHistoryRefreshers,
): Promise<Result> => {
  const result = await execute();
  if (result._tag === "Success") {
    refreshers.refreshExecutions();
    refreshers.refreshTasks();
    refreshers.refreshEvents();
  }
  return result;
};

export const advanceCompositionSquadRunDraft = (
  draft: CompositionSquadRunDraft,
  nextExecutionId: string,
): CompositionSquadRunDraft => ({
  ...draft,
  executionId: nextExecutionId.trim(),
});

export const parseCompositionSquadExecutionTaskId = (
  taskId: string,
  squadId: string,
): CompositionSquadExecutionTaskIdentity | null => {
  const marker = `:squad:${squadId}:r`;
  const markerIndex = taskId.lastIndexOf(marker);
  if (markerIndex <= 0) return null;

  const executionId = taskId.slice(0, markerIndex);
  const suffix = taskId.slice(markerIndex + marker.length);
  const taskSeparator = suffix.indexOf(":task:");
  if (taskSeparator <= 0) return null;

  const revisionText = suffix.slice(0, taskSeparator);
  const nodeId = suffix.slice(taskSeparator + ":task:".length);
  if (!/^[1-9]\d*$/.test(revisionText) || nodeId.length === 0) return null;

  const squadRevision = Number(revisionText);
  if (!Number.isSafeInteger(squadRevision)) return null;
  return { executionId, squadRevision, nodeId };
};

const squadHistoryNodeOrder = (nodeId: string): number => {
  if (nodeId === "leader-plan") return 0;
  if (nodeId === "leader-finalize") return 2;
  return 1;
};

export const projectCompositionSquadExecutionHistory = (
  squadId: string,
  executions: ReadonlyArray<CompositionSquadExecution>,
  snapshots: ReadonlyArray<CompositionTaskSnapshot>,
): ReadonlyArray<CompositionSquadExecutionHistoryItem> => {
  const snapshotsByTaskId = new Map(
    snapshots.map((snapshot) => [snapshot.task.taskId, snapshot] as const),
  );
  const executionKeys = new Set<string>();
  const history: CompositionSquadExecutionHistoryItem[] = [];

  const withSnapshot = (
    node: Omit<CompositionSquadExecutionHistoryNode, "snapshot">,
  ): CompositionSquadExecutionHistoryNode => {
    const snapshot = snapshotsByTaskId.get(node.taskId);
    if (snapshot === undefined) return node;
    return {
      ...node,
      ...(node.runId === undefined && snapshot.latestRun !== undefined
        ? { runId: snapshot.latestRun.runId }
        : {}),
      ...(node.agentId === undefined
        ? { agentId: snapshot.latestRun?.agentId ?? snapshot.task.assigneeId }
        : {}),
      snapshot,
    };
  };

  for (const execution of executions) {
    if (execution.squadId !== squadId) continue;
    const key = `${execution.executionId}\u0000${execution.squadRevision}`;
    executionKeys.add(key);
    history.push({
      source: "execution_record",
      executionId: execution.executionId,
      squadId: execution.squadId,
      squadRevision: execution.squadRevision,
      projectId: execution.projectId,
      status: execution.status,
      ...(execution.failureCode === undefined ? {} : { failureCode: execution.failureCode }),
      ...(execution.failureDetail === undefined ? {} : { failureDetail: execution.failureDetail }),
      updatedAtUnixMs: execution.updatedAtUnixMs,
      nodes: [
        withSnapshot({ nodeId: "leader-plan", taskId: execution.goalTaskId }),
        ...(execution.nodes ?? []).map((node) =>
          withSnapshot({
            nodeId: node.nodeId,
            taskId: node.taskId,
            runId: node.runId,
            agentId: node.agentId,
          }),
        ),
        withSnapshot({
          nodeId: "leader-finalize",
          taskId: execution.leaderTaskId,
          runId: execution.leaderRunId,
        }),
      ],
    });
  }

  const legacyGroups = new Map<
    string,
    {
      readonly executionId: string;
      readonly squadRevision: number;
      readonly projectId: string;
      readonly nodes: CompositionSquadExecutionHistoryNode[];
    }
  >();

  for (const snapshot of snapshots) {
    const identity = parseCompositionSquadExecutionTaskId(snapshot.task.taskId, squadId);
    if (identity === null) continue;
    const key = `${identity.executionId}\u0000${identity.squadRevision}`;
    if (executionKeys.has(key)) continue;
    const execution = legacyGroups.get(key) ?? {
      executionId: identity.executionId,
      squadRevision: identity.squadRevision,
      projectId: snapshot.task.projectId,
      nodes: [],
    };
    execution.nodes.push({
      nodeId: identity.nodeId,
      taskId: snapshot.task.taskId,
      ...(snapshot.latestRun === undefined ? {} : { runId: snapshot.latestRun.runId }),
      agentId: snapshot.latestRun?.agentId ?? snapshot.task.assigneeId,
      snapshot,
    });
    legacyGroups.set(key, execution);
  }

  history.push(
    ...[...legacyGroups.values()].map((execution): CompositionSquadExecutionHistoryItem => {
      const nodes = [...execution.nodes].sort((left, right) => {
        const order = squadHistoryNodeOrder(left.nodeId) - squadHistoryNodeOrder(right.nodeId);
        if (order !== 0) return order;
        const createdAt =
          left.snapshot!.task.createdAtUnixMs - right.snapshot!.task.createdAtUnixMs;
        return createdAt !== 0 ? createdAt : left.nodeId.localeCompare(right.nodeId);
      });
      const updatedAtUnixMs = Math.max(...nodes.map((node) => node.snapshot!.task.updatedAtUnixMs));
      const statusNode =
        nodes.find((node) => node.nodeId === "leader-finalize") ??
        [...nodes].sort(
          (left, right) =>
            right.snapshot!.task.updatedAtUnixMs - left.snapshot!.task.updatedAtUnixMs ||
            right.taskId.localeCompare(left.taskId),
        )[0]!;
      return {
        source: "legacy_tasks",
        executionId: execution.executionId,
        squadId,
        squadRevision: execution.squadRevision,
        projectId: execution.projectId,
        status: statusNode.snapshot!.task.status,
        ...(statusNode.snapshot!.latestRun?.failureCode === undefined
          ? {}
          : { failureCode: statusNode.snapshot!.latestRun.failureCode }),
        updatedAtUnixMs,
        nodes,
      };
    }),
  );

  return history.sort(
    (left, right) =>
      right.updatedAtUnixMs - left.updatedAtUnixMs ||
      right.executionId.localeCompare(left.executionId),
  );
};

const cancellableStatuses: ReadonlySet<CompositionTaskStatus> = new Set([
  "queued",
  "dispatched",
  "resuming",
  "running",
  "waiting_approval",
  "waiting_input",
  "blocked",
  "in_review",
]);

export const getCompositionSquadNodeActions = (
  snapshot: CompositionTaskSnapshot,
  capabilityIds: ReadonlyArray<string>,
  reassignTarget?: CompositionSquadReassignTarget,
): ReadonlyArray<CompositionSquadNodeAction> => {
  const run = snapshot.latestRun;
  if (run === undefined) return [];

  if (run.status === "failed" || run.status === "timed_out") {
    const actions: CompositionSquadNodeAction[] = [];
    if (capabilityIds.some((capabilityId) => capabilityId.trim().length > 0)) {
      actions.push("retry");
    }
    if (
      reassignTarget !== undefined &&
      reassignTarget.agentId.trim().length > 0 &&
      reassignTarget.agentId.trim() !== run.agentId &&
      reassignTarget.capabilityIds.some((capabilityId) => capabilityId.trim().length > 0)
    ) {
      actions.push("reassign");
    }
    return actions;
  }

  const actions: CompositionSquadNodeAction[] = [];
  if (cancellableStatuses.has(run.status)) actions.push("cancel");
  if (
    (run.status === "waiting_approval" || run.status === "waiting_input") &&
    run.runtimeTaskId !== undefined
  ) {
    actions.push("resume");
  }
  if (run.status === "in_review") actions.push("approve", "reject");
  return actions;
};

export const buildCompositionSquadNodeActionRequest = (
  action: CompositionSquadNodeAction,
  snapshot: CompositionTaskSnapshot,
  capabilityIds: ReadonlyArray<string>,
  nextRunId: string,
  reason: string,
  reassignAgentId?: string,
): CompositionSquadNodeActionRequest | null => {
  const run = snapshot.latestRun;
  const normalizedReason = reason.trim();
  const normalizedReassignAgentId = reassignAgentId?.trim();
  if (
    run === undefined ||
    normalizedReason.length === 0 ||
    !getCompositionSquadNodeActions(
      snapshot,
      capabilityIds,
      action === "reassign" && normalizedReassignAgentId !== undefined
        ? { agentId: normalizedReassignAgentId, capabilityIds }
        : undefined,
    ).includes(action)
  ) {
    return null;
  }

  const taskId = snapshot.task.taskId;
  if (action === "cancel") {
    return { kind: "cancel", input: { taskId, runId: run.runId, reason: normalizedReason } };
  }
  if (action === "resume") {
    return { kind: "resume", input: { taskId, runId: run.runId, reason: normalizedReason } };
  }
  if (action === "approve" || action === "reject") {
    return {
      kind: "review",
      input: {
        taskId,
        runId: run.runId,
        decision: action === "approve" ? "approve" : "reject",
        reason: normalizedReason,
      },
    };
  }

  const normalizedCapabilities = [
    ...new Set(capabilityIds.map((capabilityId) => capabilityId.trim()).filter(Boolean)),
  ];
  const normalizedRunId = nextRunId.trim();
  if (normalizedCapabilities.length === 0 || normalizedRunId.length === 0) return null;
  return {
    kind: "retry",
    input: {
      taskId,
      previousRunId: run.runId,
      runId: normalizedRunId,
      ...(action === "reassign" ? { agentId: normalizedReassignAgentId! } : {}),
      reason: normalizedReason,
      capabilityIds: normalizedCapabilities,
    },
  };
};

const addRequiredIssue = (
  value: string,
  code: CompositionSquadRunIssueCode,
  path: string,
  issues: CompositionSquadRunIssue[],
): string => {
  const normalized = value.trim();
  if (normalized.length === 0) issues.push({ code, path });
  return normalized;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readPlanString = (
  value: unknown,
  path: string,
  issues: CompositionSquadRunIssue[],
): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({ code: "plan_invalid_shape", path });
    return "";
  }
  return value.trim();
};

const readDependencies = (
  value: unknown,
  path: string,
  issues: CompositionSquadRunIssue[],
): string[] => {
  if (!Array.isArray(value)) {
    issues.push({ code: "plan_invalid_shape", path });
    return [];
  }
  const dependencies: string[] = [];
  value.forEach((dependency, index) => {
    const dependencyPath = `${path}[${index}]`;
    if (typeof dependency !== "string" || dependency.trim().length === 0) {
      issues.push({ code: "plan_invalid_shape", path: dependencyPath });
      return;
    }
    dependencies.push(dependency.trim());
  });
  return dependencies;
};

const hasDependencyCycle = (nodes: ReadonlyArray<CompositionSquadPlanNode>): boolean => {
  const dependenciesByNode = new Map(
    nodes.map((node) => [node.nodeId, node.dependsOnNodeIds] as const),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const dependencyId of dependenciesByNode.get(nodeId) ?? []) {
      if (dependenciesByNode.has(dependencyId) && visit(dependencyId)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };

  return nodes.some((node) => visit(node.nodeId));
};

const parsePlan = (
  text: string,
  squad: CompositionSquad,
  issues: CompositionSquadRunIssue[],
): ReadonlyArray<CompositionSquadPlanNode> | undefined => {
  const normalized = text.trim();
  if (normalized.length === 0) {
    if (squad.collaborationMode === "dependency_graph") {
      issues.push({ code: "plan_required", path: "plan" });
    }
    return undefined;
  }

  let source: unknown;
  try {
    source = JSON.parse(normalized) as unknown;
  } catch {
    issues.push({ code: "plan_invalid_json", path: "plan" });
    return undefined;
  }
  if (
    !Array.isArray(source) ||
    (squad.collaborationMode === "dependency_graph" && source.length === 0)
  ) {
    issues.push({ code: "plan_invalid_shape", path: "plan" });
    return undefined;
  }

  const plan = source.map((candidate, index): CompositionSquadPlanNode => {
    const path = `plan[${index}]`;
    if (!isRecord(candidate)) {
      issues.push({ code: "plan_invalid_shape", path });
      return { nodeId: "", agentId: "", prompt: "", dependsOnNodeIds: [] };
    }
    return {
      nodeId: readPlanString(candidate.nodeId, `${path}.nodeId`, issues),
      agentId: readPlanString(candidate.agentId, `${path}.agentId`, issues),
      prompt: readPlanString(candidate.prompt, `${path}.prompt`, issues),
      dependsOnNodeIds: readDependencies(
        candidate.dependsOnNodeIds,
        `${path}.dependsOnNodeIds`,
        issues,
      ),
    };
  });

  const nodeIds = new Set<string>();
  plan.forEach((node, index) => {
    if (node.nodeId.length === 0) return;
    if (nodeIds.has(node.nodeId)) {
      issues.push({ code: "plan_duplicate_node", path: `plan[${index}].nodeId` });
    }
    nodeIds.add(node.nodeId);
  });

  const runnableAgentIds = new Set(
    (squad.members ?? [])
      .filter((member) => member.role !== "leader")
      .map((member) => member.agentId),
  );
  plan.forEach((node, index) => {
    if (node.agentId.length > 0 && !runnableAgentIds.has(node.agentId)) {
      issues.push({ code: "plan_unknown_agent", path: `plan[${index}].agentId` });
    }
    node.dependsOnNodeIds.forEach((dependencyId, dependencyIndex) => {
      const path = `plan[${index}].dependsOnNodeIds[${dependencyIndex}]`;
      if (dependencyId === node.nodeId) {
        issues.push({ code: "plan_self_dependency", path });
      } else if (!nodeIds.has(dependencyId)) {
        issues.push({ code: "plan_unknown_dependency", path });
      }
    });
  });

  if (hasDependencyCycle(plan)) issues.push({ code: "plan_cycle", path: "plan" });
  return plan;
};

export function buildCompositionSquadExecutionRequest(
  draft: CompositionSquadRunDraft,
  squad: CompositionSquad,
): CompositionSquadRunBuildResult {
  const issues: CompositionSquadRunIssue[] = [];
  const executionId = addRequiredIssue(
    draft.executionId,
    "execution_id_required",
    "executionId",
    issues,
  );
  const projectId = addRequiredIssue(draft.projectId, "project_id_required", "projectId", issues);
  const goal = addRequiredIssue(draft.goal, "goal_required", "goal", issues);
  const workspaceRoot = addRequiredIssue(
    draft.workspaceRoot,
    "workspace_root_required",
    "workspaceRoot",
    issues,
  );
  if (squad.archivedAtUnixMs !== undefined) {
    issues.push({ code: "squad_archived", path: "squadId" });
  }
  if (
    squad.revision === undefined ||
    squad.collaborationMode === undefined ||
    squad.members === undefined
  ) {
    issues.push({ code: "squad_configuration_incomplete", path: "squadId" });
  }
  const plan = parsePlan(draft.planText, squad, issues);

  if (issues.length > 0) return { request: null, issues };

  const threadId = draft.threadId.trim();
  return {
    request: {
      executionId,
      squadId: squad.squadId,
      squadRevision: squad.revision!,
      projectId,
      ...(threadId.length === 0 ? {} : { threadId: ThreadId.make(threadId) }),
      goal,
      workspaceRoot,
      ...(plan === undefined ? {} : { plan }),
    },
    issues: [],
  };
}
