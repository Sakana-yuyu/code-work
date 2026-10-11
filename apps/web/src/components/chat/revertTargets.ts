import type { MessageId } from "@codework/contracts";
import type { TimelineEntry } from "../../session-logic";
import type { ChatMessage, TurnDiffSummary } from "../../types";

type MessageIdentity = Pick<ChatMessage, "id" | "role">;
export type RevertCheckpoint = Pick<TurnDiffSummary, "turnId"> &
  Partial<Pick<TurnDiffSummary, "checkpointTurnCount">>;

function matchesMessageOrder(
  entries: ReadonlyArray<TimelineEntry>,
  identities: ReadonlyArray<MessageIdentity>,
) {
  let index = 0;
  for (const entry of entries) {
    if (entry.kind !== "message") continue;
    const previous = identities[index];
    if (previous?.id !== entry.message.id || previous.role !== entry.message.role) return false;
    index += 1;
  }
  return index === identities.length;
}

/** 每个线程独享缓存；回退目标只依赖可见消息身份、顺序和检查点，不依赖正文增量。 */
export function createRevertTargetsSelector() {
  let previousIdentities: MessageIdentity[] = [];
  let previousSummaries: ReadonlyMap<MessageId, RevertCheckpoint> | null = null;
  let previousCounts: Readonly<Record<string, number>> | null = null;
  let previousFailedLatestUser = false;
  let previousResult: Map<MessageId, number | null> | null = null;

  return (
    entries: ReadonlyArray<TimelineEntry>,
    summaries: ReadonlyMap<MessageId, RevertCheckpoint>,
    inferredCounts: Readonly<Record<string, number>>,
    failedLatestUser: boolean,
  ): Map<MessageId, number | null> => {
    if (
      previousResult !== null &&
      summaries === previousSummaries &&
      inferredCounts === previousCounts &&
      failedLatestUser === previousFailedLatestUser &&
      matchesMessageOrder(entries, previousIdentities)
    )
      return previousResult;

    const result = new Map<MessageId, number | null>();
    const identities: MessageIdentity[] = [];
    let pendingUser: MessageId | null = null;
    let latestUser: MessageId | null = null;
    for (const entry of entries) {
      if (entry.kind !== "message") continue;
      identities.push({ id: entry.message.id, role: entry.message.role });
      if (entry.message.role === "user") {
        pendingUser = entry.message.id;
        latestUser = pendingUser;
      } else if (pendingUser !== null) {
        const summary = summaries.get(entry.message.id);
        if (!summary) continue;
        const count = summary.checkpointTurnCount ?? inferredCounts[summary.turnId];
        if (typeof count === "number") result.set(pendingUser, Math.max(0, count - 1));
        // 找到对应检查点后即结束当前用户的查找；缺少计数也不能越过它挑后续回合。
        pendingUser = null;
      }
    }
    if (failedLatestUser && latestUser !== null && !result.has(latestUser))
      result.set(latestUser, null);

    previousIdentities = identities;
    previousSummaries = summaries;
    previousCounts = inferredCounts;
    previousFailedLatestUser = failedLatestUser;
    previousResult = result;
    return result;
  };
}
