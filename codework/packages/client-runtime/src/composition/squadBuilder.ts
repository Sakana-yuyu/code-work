import {
  validateCompositionSquadConfiguration,
  type CompositionSquad,
  type CompositionSquadApprovalStage,
  type CompositionSquadCollaborationMode,
  type CompositionSquadCreateRequest,
  type CompositionSquadFailurePolicy,
  type CompositionSquadMember,
  type CompositionSquadMemberModelBinding,
  type CompositionSquadMemberRole,
  type CompositionSquadModelBinding,
  type CompositionSquadPartialSuccessPolicy,
  type CompositionSquadValidationIssue,
} from "@codework/contracts";

export interface CompositionSquadMemberDraft {
  clientId: string;
  agentId: string;
  role: CompositionSquadMemberRole;
  required: boolean;
  model: string;
  modelBinding: CompositionSquadMemberModelBinding | null;
  workspaceRoot: string;
  capabilityIdsText: string;
  maxConcurrentTasksText: string;
}

export interface CompositionSquadDraft {
  squadId: string;
  name: string;
  instructions: string;
  collaborationMode: CompositionSquadCollaborationMode;
  maxConcurrencyText: string;
  maxRetriesText: string;
  failurePolicy: CompositionSquadFailurePolicy;
  partialSuccessPolicy: CompositionSquadPartialSuccessPolicy;
  approvalStages: CompositionSquadApprovalStage[];
  defaultModelBinding: CompositionSquadModelBinding | null;
  members: CompositionSquadMemberDraft[];
}

export type CompositionSquadDraftIssueCode =
  | CompositionSquadValidationIssue["code"]
  | "required"
  | "invalid_positive_integer"
  | "invalid_non_negative_integer";

export interface CompositionSquadDraftIssue {
  readonly code: CompositionSquadDraftIssueCode;
  readonly path: string;
}

export interface CompositionSquadDraftBuildResult {
  readonly request: CompositionSquadCreateRequest | null;
  readonly issues: ReadonlyArray<CompositionSquadDraftIssue>;
}

const emptyMemberDraft = (): CompositionSquadMemberDraft => ({
  clientId: "member-0",
  agentId: "",
  role: "leader",
  required: true,
  model: "",
  modelBinding: { kind: "team_default" },
  workspaceRoot: "",
  capabilityIdsText: "",
  maxConcurrentTasksText: "1",
});

export const createEmptyCompositionSquadDraft = (): CompositionSquadDraft => ({
  squadId: "",
  name: "",
  instructions: "",
  collaborationMode: "serial",
  maxConcurrencyText: "1",
  maxRetriesText: "0",
  failurePolicy: "fail_fast",
  partialSuccessPolicy: "reject",
  approvalStages: [],
  defaultModelBinding: { kind: "runtime_native" },
  members: [emptyMemberDraft()],
});

const optionalTrimmed = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const capabilityIdsFromText = (value: string): ReadonlyArray<string> =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const parseInteger = (
  value: string,
  minimum: number,
  path: string,
  issues: CompositionSquadDraftIssue[],
): number | null => {
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < minimum) {
    issues.push({
      code: minimum === 0 ? "invalid_non_negative_integer" : "invalid_positive_integer",
      path,
    });
    return null;
  }
  return parsed;
};

export function buildCompositionSquadCreateRequest(
  draft: CompositionSquadDraft,
): CompositionSquadDraftBuildResult {
  const issues: CompositionSquadDraftIssue[] = [];
  const squadId = draft.squadId.trim();
  const name = draft.name.trim();
  if (squadId.length === 0) issues.push({ code: "required", path: "squadId" });
  if (name.length === 0) issues.push({ code: "required", path: "name" });
  if (draft.members.length === 0) issues.push({ code: "required", path: "members" });

  const maxConcurrency = parseInteger(draft.maxConcurrencyText, 1, "maxConcurrency", issues);
  const maxRetries = parseInteger(draft.maxRetriesText, 0, "maxRetries", issues);
  const members = draft.members.map((member, index) => {
    const agentId = member.agentId.trim();
    if (agentId.length === 0) {
      issues.push({ code: "required", path: `members.${index}.agentId` });
    }
    const maxConcurrentTasks = parseInteger(
      member.maxConcurrentTasksText,
      1,
      `members.${index}.maxConcurrentTasks`,
      issues,
    );
    return {
      agentId,
      role: member.role,
      order: index,
      required: member.required,
      ...(member.modelBinding === null ? {} : { modelBinding: member.modelBinding }),
      ...(optionalTrimmed(member.model) === undefined
        ? {}
        : { model: optionalTrimmed(member.model) }),
      ...(optionalTrimmed(member.workspaceRoot) === undefined
        ? {}
        : { workspaceRoot: optionalTrimmed(member.workspaceRoot) }),
      capabilityIds: capabilityIdsFromText(member.capabilityIdsText),
      maxConcurrentTasks: maxConcurrentTasks ?? 0,
    };
  });
  const leaderAgentId = members.find((member) => member.role === "leader")?.agentId ?? "";

  if (maxConcurrency === null || maxRetries === null || issues.length > 0) {
    return { request: null, issues };
  }

  const request: CompositionSquadCreateRequest = {
    squadId,
    name,
    leaderAgentId,
    ...(optionalTrimmed(draft.instructions) === undefined
      ? {}
      : { instructions: optionalTrimmed(draft.instructions) }),
    collaborationMode: draft.collaborationMode,
    members,
    ...(draft.defaultModelBinding === null
      ? {}
      : { defaultModelBinding: draft.defaultModelBinding }),
    maxConcurrency,
    maxRetries,
    failurePolicy: draft.failurePolicy,
    partialSuccessPolicy: draft.partialSuccessPolicy,
    approvalStages: draft.approvalStages,
  };
  const contractIssues = validateCompositionSquadConfiguration({
    ...request,
    revision: 1,
    memberAgentIds: request.members.map((member) => member.agentId),
  });
  issues.push(...contractIssues);

  return issues.length === 0 ? { request, issues } : { request: null, issues };
}

export function draftFromCompositionSquad(squad: CompositionSquad): CompositionSquadDraft {
  const sourceMembers: ReadonlyArray<CompositionSquadMember> =
    squad.members ??
    squad.memberAgentIds.map((agentId, order) => ({
      agentId,
      role: agentId === squad.leaderAgentId ? ("leader" as const) : ("worker" as const),
      order,
      required: true,
      capabilityIds: [],
      maxConcurrentTasks: 1,
    }));

  return {
    squadId: squad.squadId,
    name: squad.name,
    instructions: squad.instructions ?? "",
    collaborationMode: squad.collaborationMode ?? "serial",
    maxConcurrencyText: String(squad.maxConcurrency ?? 1),
    maxRetriesText: String(squad.maxRetries ?? 0),
    failurePolicy: squad.failurePolicy ?? "fail_fast",
    partialSuccessPolicy: squad.partialSuccessPolicy ?? "reject",
    approvalStages: [...(squad.approvalStages ?? [])],
    defaultModelBinding:
      squad.defaultModelBinding === undefined ? null : { ...squad.defaultModelBinding },
    members:
      sourceMembers.length === 0
        ? [emptyMemberDraft()]
        : [...sourceMembers]
            .sort((left, right) => left.order - right.order)
            .map((member) => ({
              clientId: `member-${member.order}-${member.agentId}`,
              agentId: member.agentId,
              role: member.role,
              required: member.required,
              model: member.model ?? "",
              modelBinding: member.modelBinding === undefined ? null : { ...member.modelBinding },
              workspaceRoot: member.workspaceRoot ?? "",
              capabilityIdsText: member.capabilityIds.join(", "),
              maxConcurrentTasksText: String(member.maxConcurrentTasks),
            })),
  };
}
