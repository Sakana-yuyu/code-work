import type { MessageId, OrchestrationThread, TurnId } from "@codework/contracts";
import {
  CheckpointRef as CheckpointRefSchema,
  MessageId as MessageIdSchema,
  TurnId as TurnIdSchema,
} from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveRevertTurnCountByUserMessageId } from "./threadMessageActions";

const message = (
  id: string,
  role: "user" | "assistant",
  turnId: TurnId | null,
): OrchestrationThread["messages"][number] => ({
  id: MessageIdSchema.make(id),
  role,
  text: id,
  attachments: [],
  turnId,
  streaming: false,
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
});

const checkpoint = (
  turnId: TurnId,
  checkpointTurnCount: number,
  assistantMessageId: MessageId,
  status: "ready" | "missing",
): OrchestrationThread["checkpoints"][number] => ({
  turnId,
  checkpointTurnCount,
  checkpointRef: CheckpointRefSchema.make(`refs/t3/checkpoints/${turnId}`),
  status,
  files: [],
  assistantMessageId,
  completedAt: "2026-09-03T00:00:00.000Z",
});

describe("deriveRevertTurnCountByUserMessageId", () => {
  it("只把下一个用户消息之前的 ready assistant checkpoint 映射给用户消息", () => {
    const turn1 = TurnIdSchema.make("turn-1");
    const turn2 = TurnIdSchema.make("turn-2");
    const user1 = MessageIdSchema.make("user-1");
    const assistant1 = MessageIdSchema.make("assistant-1");
    const user2 = MessageIdSchema.make("user-2");
    const assistant2 = MessageIdSchema.make("assistant-2");

    const result = deriveRevertTurnCountByUserMessageId({
      messages: [
        message(user1, "user", turn1),
        message(assistant1, "assistant", turn1),
        message(user2, "user", turn2),
        message(assistant2, "assistant", turn2),
      ],
      latestTurn: {
        turnId: turn2,
        state: "completed",
        requestedAt: "2026-09-03T00:00:00.000Z",
        startedAt: "2026-09-03T00:00:00.000Z",
        completedAt: "2026-09-03T00:00:00.000Z",
        assistantMessageId: assistant2,
      },
      checkpoints: [
        checkpoint(turn1, 3, assistant1, "ready"),
        checkpoint(turn2, 4, assistant2, "missing"),
      ],
    });

    expect([...result.entries()]).toEqual([[user1, 2]]);
  });

  it("为最近一次失败且没有 checkpoint 的用户消息保留直接重发入口", () => {
    const turn = TurnIdSchema.make("turn-error");
    const user = MessageIdSchema.make("user-error");

    const result = deriveRevertTurnCountByUserMessageId({
      latestTurn: {
        turnId: turn,
        state: "error",
        requestedAt: "2026-09-03T00:00:00.000Z",
        startedAt: "2026-09-03T00:00:00.000Z",
        completedAt: "2026-09-03T00:00:00.000Z",
        assistantMessageId: null,
      },
      messages: [message(user, "user", turn)],
      checkpoints: [],
    });

    expect(result.get(user)).toBeNull();
  });
});
