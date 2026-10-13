import type { MessageId, OrchestrationThread } from "@codework/contracts";

type RevertTargetInput = Pick<OrchestrationThread, "messages" | "checkpoints" | "latestTurn">;

/** 每个环境/线程独享；正文与活动不影响回退身份，检查点和失败状态仍即时生效。 */
export function createRevertTurnCountByUserMessageIdSelector() {
  const unavailable = new Map<MessageId, number | null>();
  let identities: Array<Pick<OrchestrationThread["messages"][number], "id" | "role">> = [];
  let checkpoints: RevertTargetInput["checkpoints"] | null = null;
  let latestTurnFailed = false;
  let result: ReadonlyMap<MessageId, number | null> | null = null;

  return (input: RevertTargetInput | null): ReadonlyMap<MessageId, number | null> => {
    if (input === null) {
      identities = [];
      checkpoints = null;
      result = null;
      return unavailable;
    }
    const failed = input.latestTurn?.state === "error";
    if (
      result !== null &&
      checkpoints === input.checkpoints &&
      latestTurnFailed === failed &&
      identities.length === input.messages.length &&
      input.messages.every(
        (message, index) =>
          message.id === identities[index]?.id && message.role === identities[index]?.role,
      )
    ) {
      return result;
    }
    result = deriveRevertTurnCountByUserMessageId(input);
    identities = input.messages.map(({ id, role }) => ({ id, role }));
    checkpoints = input.checkpoints;
    latestTurnFailed = failed;
    return result;
  };
}

/**
 * 为已经完成的用户消息找到对应的可回退 checkpoint。
 * 用户消息与 assistant 消息之间可能夹着多个 assistant 消息，遇到下一个用户消息就停止。
 */
export function deriveRevertTurnCountByUserMessageId(
  input: RevertTargetInput,
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
