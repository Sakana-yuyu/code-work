import type { MessageId, OrchestrationThread, TurnId } from "@codework/contracts";
import {
  CheckpointRef as CheckpointRefSchema,
  MessageId as MessageIdSchema,
  TurnId as TurnIdSchema,
} from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createRevertTurnCountByUserMessageIdSelector,
  deriveRevertTurnCountByUserMessageId,
} from "./threadMessageActions";

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

describe("线程私有回退目标复用", () => {
  it("1200 消息的连续正文更新保留 map，且不重读 600 个历史检查点", () => {
    let checkpointReads = 0;
    const checkpoints = Array.from({ length: 600 }, (_, index) => {
      const item = checkpoint(
        TurnIdSchema.make(`turn-${index}`),
        index + 1,
        MessageIdSchema.make(`assistant-${index}`),
        "ready",
      );
      Object.defineProperty(item, "status", {
        get: () => {
          checkpointReads += 1;
          return "ready";
        },
      });
      return item;
    });
    const messages = checkpoints.flatMap((item, index) => [
      message(`user-${index}`, "user", item.turnId),
      message(`assistant-${index}`, "assistant", item.turnId),
    ]);
    const select = createRevertTurnCountByUserMessageIdSelector();
    const first = select({ messages, checkpoints, latestTurn: null });
    expect(first.size).toBe(600);
    expect(checkpointReads).toBe(600);
    checkpointReads = 0;
    for (let frame = 0; frame < 20; frame++) {
      const updated = [
        ...messages.slice(0, -1),
        { ...messages.at(-1)!, text: `正文增量-${frame}`, streaming: true },
      ];
      expect(select({ messages: updated, checkpoints, latestTurn: null })).toBe(first);
    }
    expect(checkpointReads).toBe(0);
    expect(first.get(MessageIdSchema.make("user-599"))).toBe(599);
  });

  it("检查点 ready、计数和绑定改变时即时更新，不改旧结果", () => {
    const turn = TurnIdSchema.make("turn");
    const user = message("user", "user", turn);
    const assistant = message("assistant", "assistant", turn);
    const select = createRevertTurnCountByUserMessageIdSelector();
    const input = { messages: [user, assistant], latestTurn: null };
    const missing = select({
      ...input,
      checkpoints: [checkpoint(turn, 3, assistant.id, "missing")],
    });
    const ready = select({ ...input, checkpoints: [checkpoint(turn, 3, assistant.id, "ready")] });
    const changed = select({ ...input, checkpoints: [checkpoint(turn, 5, assistant.id, "ready")] });
    const rebound = select({ ...input, checkpoints: [checkpoint(turn, 5, user.id, "ready")] });
    expect(missing.size).toBe(0);
    expect(ready.get(user.id)).toBe(2);
    expect(changed.get(user.id)).toBe(4);
    expect(rebound.size).toBe(0);
    expect(ready.get(user.id)).toBe(2);
  });

  it("消息新增、移除、顺序、身份和角色变化保持原映射语义", () => {
    const turn = TurnIdSchema.make("turn");
    const user = message("user", "user", turn);
    const assistant = message("assistant", "assistant", turn);
    const checkpoints = [checkpoint(turn, 2, assistant.id, "ready")];
    const select = createRevertTurnCountByUserMessageIdSelector();
    const input = { messages: [user, assistant], checkpoints, latestTurn: null };
    expect(select(input).get(user.id)).toBe(1);
    expect(select({ ...input, messages: [assistant, user] }).size).toBe(0);
    expect(select({ ...input, messages: [user] }).size).toBe(0);
    expect(
      select({ ...input, messages: [user, { ...assistant, id: MessageIdSchema.make("renamed") }] })
        .size,
    ).toBe(0);
    expect(select({ ...input, messages: [user, { ...assistant, role: "user" }] }).size).toBe(0);
    const inserted = message("inserted", "user", turn);
    const result = select({ ...input, messages: [user, inserted, assistant] });
    expect(result.has(user.id)).toBe(false);
    expect(result.get(inserted.id)).toBe(1);
  });

  it("失败与恢复切换更新直接重发入口，无关回合字段不改变目标", () => {
    const turn = TurnIdSchema.make("turn");
    const user = message("user", "user", turn);
    const input: Parameters<typeof deriveRevertTurnCountByUserMessageId>[0] = {
      messages: [user],
      checkpoints: [],
      latestTurn: {
        turnId: turn,
        state: "error",
        requestedAt: "2026-09-03T00:00:00.000Z",
        startedAt: null,
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const select = createRevertTurnCountByUserMessageIdSelector();
    const failed = select(input);
    expect(failed.get(user.id)).toBeNull();
    expect(
      select({
        ...input,
        latestTurn: { ...input.latestTurn!, completedAt: "2026-09-03T00:00:01.000Z" },
      }),
    ).toBe(failed);
    expect(
      select({ ...input, latestTurn: { ...input.latestTurn!, state: "completed" } }).has(user.id),
    ).toBe(false);
  });

  it("空数据释放旧缓存，实例不在不同线程或环境之间共享结果", () => {
    const turn = TurnIdSchema.make("turn");
    const input = {
      messages: [message("user", "user", turn), message("assistant", "assistant", turn)],
      checkpoints: [checkpoint(turn, 2, MessageIdSchema.make("assistant"), "ready")],
      latestTurn: null,
    };
    const first = createRevertTurnCountByUserMessageIdSelector();
    const second = createRevertTurnCountByUserMessageIdSelector();
    const original = first(input);
    expect(second(input)).toEqual(original);
    expect(second(input)).not.toBe(original);
    const absent = first(null);
    expect(absent.size).toBe(0);
    expect(first(null)).toBe(absent);
    expect(first(input)).toEqual(original);
    expect(first(input)).not.toBe(original);
  });
});
