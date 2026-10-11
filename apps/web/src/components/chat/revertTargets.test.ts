import { describe, expect, it } from "vite-plus/test";
import { MessageId, TurnId } from "@codework/contracts";
import type { TimelineEntry } from "../../session-logic";
import { createRevertTargetsSelector, type RevertCheckpoint } from "./revertTargets";

const message = (id: string, role: "user" | "assistant", text = "正文"): TimelineEntry => ({
  kind: "message",
  id,
  createdAt: "2026-10-12T00:00:00.000Z",
  message: {
    id: MessageId.make(id),
    role,
    text,
    turnId: null,
    streaming: role === "assistant",
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
  },
});
const summary = (id: string, count?: number): RevertCheckpoint => ({
  turnId: TurnId.make(id),
  ...(count === undefined ? {} : { checkpointTurnCount: count }),
});
const reasoning: TimelineEntry = {
  kind: "reasoning-summary",
  id: "reason",
  createdAt: "2026-10-12T00:00:00.000Z",
  summaries: [],
};

describe("流式回复的用户回退目标", () => {
  it("正文和活动增量保持 map 引用，且不再次读取历史检查点", () => {
    const select = createRevertTargetsSelector();
    const summaries = new Map([[MessageId.make("a"), summary("a", 3)]]);
    let reads = 0;
    const get = summaries.get.bind(summaries);
    summaries.get = (key) => {
      reads += 1;
      return get(key);
    };
    const counts = {};
    const first = select(
      [message("u", "user"), message("a", "assistant")],
      summaries,
      counts,
      false,
    );
    expect(first.get(MessageId.make("u"))).toBe(2);
    reads = 0;
    for (const text of ["追加", "追加代码", "回复结束"]) {
      expect(
        select(
          [message("u", "user"), reasoning, message("a", "assistant", text)],
          summaries,
          counts,
          false,
        ),
      ).toBe(first);
    }
    expect(reads).toBe(0);
  });

  it("检查点计数或推导计数变化立即更新", () => {
    const select = createRevertTargetsSelector();
    const entries = [message("u", "user"), message("a", "assistant")];
    const summaries = new Map([[MessageId.make("a"), summary("a")]]);
    const first = select(entries, summaries, { a: 2 }, false);
    const next = select(entries, summaries, { a: 4 }, false);
    expect(next).not.toBe(first);
    expect(next.get(MessageId.make("u"))).toBe(3);
    expect(
      select(entries, new Map([[MessageId.make("a"), summary("a", 1)]]), {}, false).get(
        MessageId.make("u"),
      ),
    ).toBe(0);
  });

  it("下一条用户消息分隔回合，找不到计数的检查点不能越过", () => {
    const select = createRevertTargetsSelector();
    const summaries = new Map([
      [MessageId.make("a"), summary("a", 2)],
      [MessageId.make("missing"), summary("missing")],
      [MessageId.make("later"), summary("later", 5)],
    ]);
    const result = select(
      [
        message("orphan", "assistant"),
        message("u1", "user"),
        message("u2", "user"),
        message("a", "assistant"),
        message("u3", "user"),
        message("missing", "assistant"),
        message("later", "assistant"),
      ],
      summaries,
      {},
      false,
    );
    expect([...result]).toEqual([[MessageId.make("u2"), 1]]);
  });

  it("失败只给没有检查点的最后用户提供清除入口，恢复后移除", () => {
    const select = createRevertTargetsSelector();
    const entries = [message("u", "user"), message("a", "assistant"), message("last", "user")];
    const summaries = new Map([[MessageId.make("a"), summary("a", 2)]]);
    const counts = {};
    const failed = select(entries, summaries, counts, true);
    expect([...failed]).toEqual([
      [MessageId.make("u"), 1],
      [MessageId.make("last"), null],
    ]);
    const recovered = select(entries, summaries, counts, false);
    expect(recovered).not.toBe(failed);
    expect(recovered.has(MessageId.make("last"))).toBe(false);
    expect(select(entries.slice(0, 2), summaries, counts, true).get(MessageId.make("u"))).toBe(1);
  });

  it("消息加入、删除、重排或角色变化重新建立目标", () => {
    const select = createRevertTargetsSelector();
    const summaries = new Map([[MessageId.make("a"), summary("a", 2)]]);
    const counts = {};
    const first = select(
      [message("u", "user"), message("a", "assistant")],
      summaries,
      counts,
      false,
    );
    const reordered = select(
      [message("a", "assistant"), message("u", "user")],
      summaries,
      counts,
      false,
    );
    expect(reordered).not.toBe(first);
    expect(reordered.size).toBe(0);
    const replacement = select(
      [message("other", "user"), message("a", "assistant")],
      summaries,
      counts,
      false,
    );
    expect([...replacement]).toEqual([[MessageId.make("other"), 1]]);
    const changedRole = select(
      [message("other", "assistant"), message("a", "assistant")],
      summaries,
      counts,
      false,
    );
    expect(changedRole.size).toBe(0);
    expect(select([], summaries, counts, false)).not.toBe(changedRole);
  });
});
