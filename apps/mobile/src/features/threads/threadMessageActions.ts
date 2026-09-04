import type { MessageId, OrchestrationThread } from "@codework/contracts";

/**
 * 为已经完成的用户消息找到对应的可回退 checkpoint。
 * 用户消息与 assistant 消息之间可能夹着多个 assistant 消息，遇到下一个用户消息就停止。
 */
export function deriveRevertTurnCountByUserMessageId(
  input: Pick<OrchestrationThread, "messages" | "checkpoints" | "latestTurn">,
): ReadonlyMap<MessageId, number | null> {
  const checkpointByAssistantMessageId = new Map<
    MessageId,
    OrchestrationThread["checkpoints"][number]
  >();
  for (const checkpoint of input.checkpoints) {
    if (checkpoint.status !== "ready" || checkpoint.assistantMessageId === null) continue;
    checkpointByAssistantMessageId.set(checkpoint.assistantMessageId, checkpoint);
  }

  const result = new Map<MessageId, number | null>();
  for (let index = 0; index < input.messages.length; index += 1) {
    const message = input.messages[index];
    if (!message || message.role !== "user") continue;

    for (let nextIndex = index + 1; nextIndex < input.messages.length; nextIndex += 1) {
      const next = input.messages[nextIndex];
      if (!next) continue;
      if (next.role === "user") break;
      const checkpoint = checkpointByAssistantMessageId.get(next.id);
      if (checkpoint === undefined) continue;
      result.set(message.id, Math.max(0, checkpoint.checkpointTurnCount - 1));
      break;
    }
  }

  if (input.latestTurn?.state === "error") {
    const latestUserMessage = input.messages.findLast((message) => message.role === "user");
    if (latestUserMessage && !result.has(latestUserMessage.id)) {
      result.set(latestUserMessage.id, null);
    }
  }

  return result;
}
