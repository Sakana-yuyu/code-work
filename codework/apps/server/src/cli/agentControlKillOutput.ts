import type { AgentKillResult } from "./agentControlKillState.ts";

export function formatAgentKillResult(result: AgentKillResult, json: boolean): string {
  if (json) return JSON.stringify(result, null, 2);

  return [
    `Agent: ${result.agentId}`,
    `Turn: ${result.turnId}`,
    `Command: ${result.commandId}`,
    `Sequence: ${String(result.sequence)}`,
    `Created at: ${result.createdAt}`,
  ].join("\n");
}
