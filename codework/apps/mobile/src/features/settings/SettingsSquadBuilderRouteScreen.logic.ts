import type { CompositionSquad, CompositionSquadMember } from "@codework/contracts";

export interface SquadBuilderConfigurationSummary {
  readonly archived: boolean;
  readonly collaborationMode: NonNullable<CompositionSquad["collaborationMode"]>;
  readonly maxConcurrency: number;
  readonly maxRetries: number;
  readonly memberCount: number;
  readonly revision: number;
}

const COLLABORATION_MODE_LABEL_KEYS: Readonly<Record<string, string>> = {
  serial: "squadBuilder.mode.serial",
  parallel: "squadBuilder.mode.parallel",
  dependency_graph: "squadBuilder.mode.dependencyGraph",
  review_critic: "squadBuilder.mode.reviewCritic",
  leader_workers: "squadBuilder.mode.leaderWorkers",
};

const MEMBER_ROLE_LABEL_KEYS: Readonly<Record<string, string>> = {
  leader: "squadBuilder.role.leader",
  worker: "squadBuilder.role.worker",
  reviewer: "squadBuilder.role.reviewer",
  critic: "squadBuilder.role.critic",
};

export const squadCollaborationModeLabelKey = (mode: string): string | null =>
  COLLABORATION_MODE_LABEL_KEYS[mode] ?? null;

export const squadMemberRoleLabelKey = (role: string): string | null =>
  MEMBER_ROLE_LABEL_KEYS[role] ?? null;

/** Builder 同时展示活动与归档配置，活动项优先，各分组内按最近更新时间排序。 */
export const sortSquadBuilderSquads = (
  squads: ReadonlyArray<CompositionSquad>,
): ReadonlyArray<CompositionSquad> =>
  squads.toSorted(
    (left, right) =>
      Number(left.archivedAtUnixMs !== undefined) - Number(right.archivedAtUnixMs !== undefined) ||
      (right.updatedAtUnixMs ?? right.createdAtUnixMs ?? 0) -
        (left.updatedAtUnixMs ?? left.createdAtUnixMs ?? 0) ||
      left.name.localeCompare(right.name),
  );

/** 兼容旧版仅保存 memberAgentIds 的 Squad，并保持丰富配置的显式顺序。 */
export const resolveSquadBuilderMembers = (
  squad: CompositionSquad,
): ReadonlyArray<CompositionSquadMember> =>
  squad.members === undefined
    ? squad.memberAgentIds.map((agentId, order) => ({
        agentId,
        role: agentId === squad.leaderAgentId ? "leader" : "worker",
        order,
        required: true,
        capabilityIds: [],
        maxConcurrentTasks: 1,
      }))
    : squad.members.toSorted(
        (left, right) => left.order - right.order || left.agentId.localeCompare(right.agentId),
      );

/** 将可选的旧版字段投影为 Builder 可稳定展示的默认值。 */
export const summarizeSquadBuilderConfiguration = (
  squad: CompositionSquad,
): SquadBuilderConfigurationSummary => ({
  archived: squad.archivedAtUnixMs !== undefined,
  collaborationMode: squad.collaborationMode ?? "serial",
  maxConcurrency: squad.maxConcurrency ?? 1,
  maxRetries: squad.maxRetries ?? 0,
  memberCount: resolveSquadBuilderMembers(squad).length,
  revision: squad.revision ?? 1,
});
