import type { AgentStatusSnapshot } from "./agentControlState.ts";

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
