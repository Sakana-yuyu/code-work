import type { AgentArchiveResult } from "./agentControlArchiveState.ts";

export function formatAgentArchiveResult(result: AgentArchiveResult, json: boolean): string {
  if (json) return JSON.stringify(result, null, 2);

  return [
    `Agent: ${result.agentId}`,
    `Command: ${result.commandId}`,
    `Sequence: ${String(result.sequence)}`,
  ].join("\n");
}
