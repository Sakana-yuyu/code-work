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

  const safeText = (value: string | null): string => sanitizeAgentOutputText(value ?? "none");

  return [
    `Agent: ${safeText(status.agentId)}`,
    `Project: ${safeText(status.projectId)}`,
    `Title: ${safeText(status.title)}`,
    `Status: ${safeText(status.status)}`,
    `Session: ${safeText(status.sessionStatus)}`,
    `Active turn: ${safeText(status.activeTurnId)}`,
    `Latest turn: ${safeText(status.latestTurnId)}`,
    `Latest turn state: ${safeText(status.latestTurnState)}`,
    `Provider: ${safeText(status.providerInstanceId)}`,
    `Model: ${safeText(status.model)}`,
    `Archived at: ${safeText(status.archivedAt)}`,
    `Updated at: ${safeText(status.updatedAt)}`,
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
