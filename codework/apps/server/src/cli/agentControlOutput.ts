import * as NodeUtil from "node:util";

import type { AgentLogsSnapshot, AgentStatusSnapshot } from "./agentControlState.ts";

const stripUnsafeControlCharacters = (value: string): string => {
  let output = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a) ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      continue;
    }
    output += character;
  }
  return output;
};

export const sanitizeAgentOutputText = (value: string): string =>
  stripUnsafeControlCharacters(NodeUtil.stripVTControlCharacters(value));

export function formatAgentStatus(status: AgentStatusSnapshot, json: boolean): string {
  if (json) return JSON.stringify(status, null, 2);

  return [
    `Agent: ${status.agentId}`,
    `Project: ${status.projectId}`,
    `Title: ${status.title}`,
    `Status: ${status.status}`,
    `Session: ${status.sessionStatus ?? "none"}`,
    `Active turn: ${status.activeTurnId ?? "none"}`,
    `Latest turn: ${status.latestTurnId ?? "none"}`,
    `Latest turn state: ${status.latestTurnState ?? "none"}`,
    `Provider: ${status.providerInstanceId}`,
    `Model: ${status.model}`,
    `Archived at: ${status.archivedAt ?? "none"}`,
    `Updated at: ${status.updatedAt}`,
  ].join("\n");
}

export function formatAgentLogs(logs: AgentLogsSnapshot, json: boolean): string {
  if (json) return JSON.stringify(logs, null, 2);
  if (logs.messages.length === 0) return "No agent messages found.";

  return logs.messages
    .map((message) => {
      const streaming = message.streaming ? " (streaming)" : "";
      const text = sanitizeAgentOutputText(message.text);
      return `[${message.createdAt}] ${message.role}${streaming}\n${text}`;
    })
    .join("\n\n");
}
