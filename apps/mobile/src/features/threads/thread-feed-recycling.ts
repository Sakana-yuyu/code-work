import type { ThreadFeedEntry } from "../../lib/threadActivity";

/** 仅复用挂载前已结束的单行历史；消息、展开详情与运行中行保持身份隔离。 */
export function resolveThreadFeedCellIdentity(
  entry: ThreadFeedEntry,
  expandedRows: Readonly<Record<string, boolean>>,
  historicalCutoffMs: number,
  platform: string,
) {
  const row =
    entry.type === "activity-group" && entry.activities.length === 1
      ? entry.activities[0]
      : undefined;
  const timestamp = row === undefined ? NaN : Date.parse(row.createdAt);
  const reuseHistoricalRow =
    platform === "android" &&
    row !== undefined &&
    row.toolLike &&
    (row.status === "success" || row.status === "failure") &&
    row.canvas === undefined &&
    !expandedRows[row.id] &&
    Number.isFinite(timestamp) &&
    timestamp <= historicalCutoffMs;
  return {
    key: reuseHistoricalRow ? "history:single" : `entry:${entry.id}`,
    reuseHistoricalRow,
  };
}
