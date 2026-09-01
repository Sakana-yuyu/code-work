import type { AgentRunResult } from "./agentControlRunState.ts";

export function formatAgentRunResult(result: AgentRunResult, json: boolean): string {
  if (json) return JSON.stringify(result, null, 2);

  return [
    `Agent: ${result.agentId}`,
    `Project: ${result.projectId}`,
    `Model: ${result.providerInstanceId} / ${result.model}`,
    `Command: ${result.commandId}`,
    `Message: ${result.messageId}`,
    `Sequence: ${String(result.sequence)}`,
    `Created at: ${result.createdAt}`,
  ].join("\n");
}
