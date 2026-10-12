import { describe, expect, it, vi } from "vite-plus/test";
import { MessageId } from "@codework/contracts";
import type { ThreadFeedActivity, ThreadFeedEntry } from "../../lib/threadActivity";
import { resolveThreadFeedCellIdentity } from "./thread-feed-recycling";

const cutoff = Date.parse("2026-10-12T03:00:00.000Z");
const activity = (overrides: Partial<ThreadFeedActivity> = {}): ThreadFeedActivity => ({
  id: "tool-601",
  createdAt: "2026-10-11T03:00:00.000Z",
  turnId: null,
  summary: "读取文件",
  detail: "实现与测试",
  canExpand: true,
  getFullDetail: () => "完整详情",
  getCopyText: () => "完整来源",
  icon: "command",
  toolLike: true,
  status: "success",
  ...overrides,
});
const entry = (row = activity()): ThreadFeedEntry => ({
  type: "activity-group",
  id: `activity:${row.id}`,
  createdAt: row.createdAt,
  turnId: null,
  activities: [row],
});

describe("Android 历史单行的受控复用", () => {
  it("两个已结束单行复用展示身份，复制和展开仍由实际行身份决定", () => {
    const first = resolveThreadFeedCellIdentity(entry(), {}, cutoff, "android");
    const second = resolveThreadFeedCellIdentity(
      entry(activity({ id: "tool-602", status: "failure" })),
      {},
      cutoff,
      "android",
    );
    expect(first.reuseHistoricalRow).toBe(true);
    expect(second.reuseHistoricalRow).toBe(true);
    expect(second.key).toBe(first.key);
  });

  it.each(["inProgress", "neutral", null] as const)("状态 %s 保持活动身份", (status) => {
    const current = entry(activity({ status }));
    expect(resolveThreadFeedCellIdentity(current, {}, cutoff, "android")).toEqual({
      key: `entry:${current.id}`,
      reuseHistoricalRow: false,
    });
  });

  it.each(["2026-10-12T03:00:00.001Z", "invalid-date"])(
    "近期或无效时间 %s 不参与复用",
    (createdAt) => {
      expect(
        resolveThreadFeedCellIdentity(entry(activity({ createdAt })), {}, cutoff, "android")
          .reuseHistoricalRow,
      ).toBe(false);
    },
  );

  it("已展开详情保持自己的父节点身份，其他行的展开状态不影响它", () => {
    const current = entry();
    expect(resolveThreadFeedCellIdentity(current, { "tool-601": true }, cutoff, "android")).toEqual(
      { key: `entry:${current.id}`, reuseHistoricalRow: false },
    );
    expect(
      resolveThreadFeedCellIdentity(current, { "tool-602": true }, cutoff, "android")
        .reuseHistoricalRow,
    ).toBe(true);
  });

  it("Canvas 入口保持产物自己的身份", () => {
    const current = entry(
      activity({
        canvas: {
          canvasId: "project-map",
          title: "项目图",
          relativePath: ".codework/canvases/thread/project-map.canvas.json",
        },
      }),
    );
    expect(resolveThreadFeedCellIdentity(current, {}, cutoff, "android")).toEqual({
      key: `entry:${current.id}`,
      reuseHistoricalRow: false,
    });
  });

  it("消息编辑、运行指示、多行与非工具活动保持各自身份", () => {
    const row = activity();
    const current = entry(row);
    if (current.type !== "activity-group") throw new Error("测试活动分组缺失");
    const message: ThreadFeedEntry = {
      type: "message",
      id: "prompt-1",
      createdAt: row.createdAt,
      message: {
        id: MessageId.make("prompt-1"),
        role: "user",
        text: "编辑草稿",
        createdAt: row.createdAt,
        updatedAt: row.createdAt,
        streaming: false,
        turnId: null,
      },
    };
    const otherMessage = { ...message, id: "prompt-2" };
    const entries: ThreadFeedEntry[] = [
      message,
      otherMessage,
      { type: "working", id: "working-1", createdAt: row.createdAt },
      { ...current, activities: [row, activity({ id: "tool-602" })] },
      entry(activity({ toolLike: false })),
    ];
    for (const item of entries) {
      expect(resolveThreadFeedCellIdentity(item, {}, cutoff, "android")).toEqual({
        key: `entry:${item.id}`,
        reuseHistoricalRow: false,
      });
    }
    expect(resolveThreadFeedCellIdentity(message, {}, cutoff, "android").key).not.toBe(
      resolveThreadFeedCellIdentity(otherMessage, {}, cutoff, "android").key,
    );
  });

  it.each(["ios", "web"])("%s 保持既有身份与原生路径", (platform) => {
    const current = entry();
    expect(resolveThreadFeedCellIdentity(current, {}, cutoff, platform)).toEqual({
      key: `entry:${current.id}`,
      reuseHistoricalRow: false,
    });
  });

  it("挂载截止时刻不随后续时钟改变，近期行仍使用原身份", () => {
    const recent = entry(activity({ createdAt: "2026-10-12T03:00:01.000Z" }));
    const clock = vi.spyOn(Date, "now").mockReturnValue(cutoff + 86_400_000);
    try {
      expect(resolveThreadFeedCellIdentity(recent, {}, cutoff, "android")).toEqual({
        key: `entry:${recent.id}`,
        reuseHistoricalRow: false,
      });
      expect(clock).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
});
