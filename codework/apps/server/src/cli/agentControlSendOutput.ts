import type { AgentSendResult } from "./agentControlSendState.ts";

export function formatAgentSendResult(result: AgentSendResult, json: boolean): string {
  if (json) return JSON.stringify(result, null, 2);

  return [
    `Agent: ${result.agentId}`,
    `Command: ${result.commandId}`,
    `Message: ${result.messageId}`,
    `Sequence: ${String(result.sequence)}`,
    `Created at: ${result.createdAt}`,
  ].join("\n");
}
