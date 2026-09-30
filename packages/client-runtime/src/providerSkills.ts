import {
  ServerProviderSlashCommand,
  type OrchestrationThreadActivity,
  type ServerProviderSkill,
} from "@codework/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const decodeCommands = Schema.decodeUnknownOption(
  Schema.Struct({
    providerInstanceId: Schema.String,
    commands: Schema.Array(ServerProviderSlashCommand),
  }),
);

/** 优先使用当前实例的会话命令；空快照撤回旧命令，旧服务端沿用全局目录。 */
export function resolveSessionSlashCommands(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  instanceId: string,
  fallback: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  for (let index = activities.length - 1; index >= 0; index--) {
    const activity = activities[index];
    if (activity?.kind !== "session.commands.updated") continue;
    const snapshot = decodeCommands(activity.payload);
    if (Option.isSome(snapshot) && snapshot.value.providerInstanceId === instanceId)
      return snapshot.value.commands;
  }
  return fallback;
}

export type ProviderSkillSourceKind = "app" | "repo" | "project" | "personal" | "system" | "other";

function titleCaseWords(value: string): string {
  const words: string[] = [];
  for (const segment of value.split(/[\s:_-]+/)) {
    if (segment.length === 0) continue;
    words.push(segment.charAt(0).toUpperCase() + segment.slice(1));
  }
  return words.join(" ");
}

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

export function formatProviderSkillDisplayName(
  skill: Pick<ServerProviderSkill, "name" | "displayName">,
): string {
  const displayName = skill.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return titleCaseWords(skill.name);
}

export function getProviderSkillsForSlashMenu(
  skills: ReadonlyArray<ServerProviderSkill>,
  showSkillsInSlashMenu: boolean,
): ServerProviderSkill[] {
  return showSkillsInSlashMenu ? skills.filter((skill) => skill.enabled) : [];
}

export function getProviderSlashCommandsForSlashMenu(
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>,
  visibleSkills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSlashCommand[] {
  const skillNames = new Set(visibleSkills.map((skill) => skill.name.trim().toLowerCase()));
  return slashCommands.filter((command) => !skillNames.has(command.name.trim().toLowerCase()));
}

export function resolveProviderSkillSourceKind(
  skill: Pick<ServerProviderSkill, "path" | "scope">,
): ProviderSkillSourceKind {
  const normalizedPath = normalizePathSeparators(skill.path);
  if (normalizedPath.includes("/.codex/plugins/") || normalizedPath.includes("/.agents/plugins/")) {
    return "app";
  }

  const normalizedScope = skill.scope?.trim().toLowerCase();
  switch (normalizedScope) {
    case "repo":
    case "repository":
      return "repo";
    case "project":
    case "workspace":
    case "local":
      return "project";
    case "user":
    case "personal":
      return "personal";
    case "system":
      return "system";
    case undefined:
    case "":
      return "other";
    default:
      return "other";
  }
}
