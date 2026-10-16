import type { ServerProviderSlashCommand } from "@codework/contracts";

import type { CompositionMcpToolDescriptor } from "../../composition/CompositionMcpToolRegistry.ts";
import type { ByokChatMessage } from "../Layers/byokChatClient.ts";

export const BYOK_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  {
    name: "compact",
    description: "byok.slash.compact",
  },
  {
    name: "mcp",
    description: "byok.slash.mcp",
  },
  {
    name: "skill",
    description: "byok.slash.skill",
    input: { hint: "Skill name (optional; lists available skills)" },
  },
  {
    name: "memory",
    description: "byok.slash.memory",
    input: { hint: "Optional note to append to user memory" },
  },
  {
    name: "hooks",
    description: "byok.slash.hooks",
  },
  {
    name: "search-engine",
    description: "byok.slash.searchEngine",
    input: { hint: "duckduckgo | searxng | tavily | brave" },
  },
];

export type ByokSlashCommandName =
  | "compact"
  | "mcp"
  | "skill"
  | "memory"
  | "hooks"
  | "search-engine";

export type ByokSlashCommand = {
  readonly name: ByokSlashCommandName;
  readonly argument: string;
};

const SLASH_COMMAND_PATTERN =
  /^\/(compact|mcp|skill|memory|hooks|search-engine)(?:\s+([\s\S]*))?$/i;

/** 斜杠命令不能被 Goal / 工作流说明包裹，否则会当成普通提示词发给模型。 */
export function parseByokSlashCommand(input: string): ByokSlashCommand | undefined {
  const match = SLASH_COMMAND_PATTERN.exec(input.trim());
  if (!match) return undefined;
  const name = match[1]?.toLowerCase();
  if (
    name !== "compact" &&
    name !== "mcp" &&
    name !== "skill" &&
    name !== "memory" &&
    name !== "hooks" &&
    name !== "search-engine"
  ) {
    return undefined;
  }
  return { name, argument: match[2]?.trim() ?? "" };
}

export function isByokNativeSlashInput(input: string | undefined): boolean {
  return parseByokSlashCommand(input ?? "") !== undefined;
}

const COMPACT_KEEP_USER_TURNS = 2;
const COMPACT_TRANSCRIPT_MAX_CHARS = 48_000;
const COMPACT_MESSAGE_MAX_CHARS = 4_000;

export const BYOK_COMPACT_SUMMARY_PREFIX = "[Conversation summary]";

export function splitHistoryForCompact(history: ReadonlyArray<ByokChatMessage>): {
  readonly older: ReadonlyArray<ByokChatMessage>;
  readonly recent: ReadonlyArray<ByokChatMessage>;
} {
  let userTurns = 0;
  let cut = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role !== "user") continue;
    userTurns += 1;
    if (userTurns === COMPACT_KEEP_USER_TURNS) {
      cut = index;
      break;
    }
  }
  if (userTurns < COMPACT_KEEP_USER_TURNS || cut === 0) {
    return { older: [], recent: history };
  }
  return { older: history.slice(0, cut), recent: history.slice(cut) };
}

export function serializeHistoryForCompact(history: ReadonlyArray<ByokChatMessage>): string {
  const lines: string[] = [];
  let used = 0;
  for (const message of history) {
    const body = truncateText(messagePlainText(message), COMPACT_MESSAGE_MAX_CHARS);
    const label =
      message.role === "tool"
        ? `tool ${message.canonicalToolName ?? message.toolCallId ?? ""}`.trim()
        : message.role;
    const line = `${label}: ${body}`;
    if (used + line.length + 1 > COMPACT_TRANSCRIPT_MAX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n\n");
}

export function applyCompactSummary(
  recent: ReadonlyArray<ByokChatMessage>,
  summary: string,
): ByokChatMessage[] {
  const compactUser: ByokChatMessage = {
    role: "user",
    content: `${BYOK_COMPACT_SUMMARY_PREFIX}\n${summary.trim()}`,
  };
  const compactAssistant: ByokChatMessage = {
    role: "assistant",
    content: "Understood. Continuing from this summary.",
  };
  return [compactUser, compactAssistant, ...recent];
}

export function buildCompactPrompt(
  transcript: string,
  focus: string,
): ReadonlyArray<ByokChatMessage> {
  const focusLine = focus.length > 0 ? `\nFocus while summarizing: ${focus}` : "";
  return [
    {
      role: "user",
      content: `Summarize the following conversation so a coding agent can continue the same work. Preserve decisions, file paths, errors, remaining tasks, and the current goal. Be concise. Write in the same language as the conversation.${focusLine}\n\n<transcript>\n${transcript}\n</transcript>`,
    },
  ];
}

export function formatMcpListing(
  descriptors: ReadonlyArray<
    Pick<
      CompositionMcpToolDescriptor,
      | "canonicalToolName"
      | "serverId"
      | "toolName"
      | "description"
      | "operation"
      | "status"
      | "trusted"
    >
  >,
): string {
  const available = descriptors.filter((descriptor) => descriptor.status === "available");
  if (available.length === 0) {
    return [
      "No MCP tools are connected for this custom model session.",
      "Add and trust a server in Settings → Integrations → MCP servers. Read tools work in every access mode; write/execute tools need full access.",
    ].join("\n");
  }
  const byServer = new Map<string, typeof available>();
  for (const descriptor of available) {
    const group = byServer.get(descriptor.serverId) ?? [];
    group.push(descriptor);
    byServer.set(descriptor.serverId, group);
  }
  const lines = [
    `${available.length} MCP tool${available.length === 1 ? "" : "s"} available to this custom model session:`,
  ];
  for (const [serverId, tools] of [...byServer.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    lines.push(`\n${serverId}${tools.some((tool) => !tool.trusted) ? " (untrusted)" : ""}`);
    for (const tool of tools) {
      const hint = tool.description.trim().length > 0 ? ` — ${tool.description.trim()}` : "";
      lines.push(`- ${tool.canonicalToolName} (${tool.operation})${hint}`);
    }
  }
  lines.push(
    "\nConfigure servers in Settings → Integrations. In chat, type /mcp or pick it from the / menu.",
  );
  return lines.join("\n");
}

export function formatSkillListing(
  skills: ReadonlyArray<{
    readonly name: string;
    readonly description?: string | undefined;
    readonly scope?: string | undefined;
  }>,
): string {
  if (skills.length === 0) {
    return [
      "No skills found.",
      "Add a SKILL.md under ~/.agents/skills, ~/.claude/skills, ~/.codex/skills, or the same folders inside the current project. Type $name in chat to expand a skill, or /skill name to preview it.",
    ].join("\n");
  }
  const lines = [`${skills.length} skill${skills.length === 1 ? "" : "s"} available:`];
  for (const skill of skills) {
    const scope = skill.scope ? ` (${skill.scope})` : "";
    const hint = skill.description?.trim() ? ` — ${skill.description.trim()}` : "";
    lines.push(`- ${skill.name}${scope}${hint}`);
  }
  lines.push("\nType $name or /skill name to load one. Skills also appear in the / menu.");
  return lines.join("\n");
}

const messagePlainText = (message: ByokChatMessage): string => {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("");
};

const truncateText = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
