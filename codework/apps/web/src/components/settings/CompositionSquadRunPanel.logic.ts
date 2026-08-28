import {
  ThreadId,
  type CompositionSquad,
  type CompositionSquadExecutionRequest,
  type CompositionSquadPlanNode,
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

export const compositionSquadRunEnvironmentKey = (environmentId: string | null): string =>
  environmentId === null ? "disconnected" : `environment:${environmentId}`;

export const advanceCompositionSquadRunDraft = (
  draft: CompositionSquadRunDraft,
  nextExecutionId: string,
): CompositionSquadRunDraft => ({
  ...draft,
  executionId: nextExecutionId.trim(),
});

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
