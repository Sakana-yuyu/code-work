import type { OrchestrationThread, TurnId } from "@codework/contracts";

import { getCurrentLanguage } from "../i18n/runtime";
import {
  buildThreadFeed,
  createThreadFeedBuilder,
  deriveThreadFeedPresentation,
  type ThreadFeedEntry,
  type ThreadFeedLatestTurn,
} from "./threadActivity";

type FeedMessage = OrchestrationThread["messages"][number];
type FeedOptions = Parameters<typeof buildThreadFeed>[1];

function messageVisible(message: FeedMessage): boolean {
  return message.text.trim().length > 0 || (message.attachments?.length ?? 0) > 0;
}

/** 每个作用域线程独享；正文更新不重新解析、排序和分组历史活动。 */
export function createThreadFeedSelector() {
  const build = createThreadFeedBuilder();
  let previous: {
    readonly threadId: OrchestrationThread["id"];
    readonly activities: OrchestrationThread["activities"];
    readonly messages: ReadonlyArray<FeedMessage>;
    readonly visible: ReadonlyArray<boolean>;
    readonly windowed: boolean;
    readonly language: ReturnType<typeof getCurrentLanguage>;
    readonly uniqueMessageIds: boolean;
    readonly feed: ThreadFeedEntry[];
  } | null = null;

  return (thread: OrchestrationThread, options?: FeedOptions): ThreadFeedEntry[] => {
    const loaded = options?.loadedMessages ?? thread.messages;
    const messages = options?.localMessages?.length
      ? [...loaded, ...options.localMessages]
      : loaded;
    const language = getCurrentLanguage();
    const windowed = options?.loadedMessages !== undefined;
    let visible: boolean[] | null = null;
    let feed: ThreadFeedEntry[] | null = null;
    if (
      previous !== null &&
      previous.threadId === thread.id &&
      previous.activities === thread.activities &&
      previous.windowed === windowed &&
      previous.language === language &&
      previous.uniqueMessageIds &&
      previous.messages.length === messages.length
    ) {
      const replacements = new Map<string, FeedMessage>();
      let stableLayout = true;
      visible = [];
      for (let index = 0; index < messages.length; index++) {
        const message = messages[index]!;
        const old = previous.messages[index]!;
        const isVisible = message === old ? previous.visible[index]! : messageVisible(message);
        visible.push(isVisible);
        if (
          message.id !== old.id ||
          message.createdAt !== old.createdAt ||
          isVisible !== previous.visible[index]
        ) {
          stableLayout = false;
          break;
        }
        if (message !== old) replacements.set(message.id, message);
      }
      if (stableLayout) {
        let changed = false;
        const updated = previous.feed.map((entry) => {
          const message = entry.type === "message" ? replacements.get(entry.id) : undefined;
          if (message === undefined) return entry;
          changed = true;
          return { ...entry, message };
        });
        feed = changed ? updated : previous.feed;
      }
    }
    if (feed === null) {
      const rebuilt = build(thread, options);
      feed =
        previous !== null && previous.threadId === thread.id && previous.language === language
          ? reuseFeedRows(previous.feed, rebuilt)
          : rebuilt;
      visible = messages.map(messageVisible);
    }
    previous = {
      threadId: thread.id,
      activities: thread.activities,
      messages,
      visible: visible!,
      windowed,
      language,
      uniqueMessageIds: new Set(messages.map((message) => message.id)).size === messages.length,
      feed,
    };
    return feed;
  };
}

function sameSet<A>(left: ReadonlySet<A>, right: ReadonlySet<A>): boolean {
  return (
    left === right || (left.size === right.size && [...left].every((value) => right.has(value)))
  );
}

function sameFeedRow(left: ThreadFeedEntry, right: ThreadFeedEntry): boolean {
  if (left === right) return true;
  if (left.id !== right.id || left.createdAt !== right.createdAt) return false;
  if (left.type === "message" && right.type === "message") return left.message === right.message;
  if (left.type === "activity-group" && right.type === "activity-group")
    return (
      left.turnId === right.turnId &&
      left.activities.length === right.activities.length &&
      left.activities.every((activity, index) => activity === right.activities[index])
    );
  if (left.type === "working" && right.type === "working") return true;
  if (left.type === "turn-fold" && right.type === "turn-fold")
    return (
      left.turnId === right.turnId && left.label === right.label && left.expanded === right.expanded
    );
  if (left.type === "work-toggle" && right.type === "work-toggle")
    return (
      left.turnId === right.turnId &&
      left.groupId === right.groupId &&
      left.hiddenCount === right.hiddenCount &&
      left.expanded === right.expanded &&
      left.onlyToolActivities === right.onlyToolActivities &&
      left.breakdown === right.breakdown
    );
  return false;
}

function reuseFeedRows(previous: ThreadFeedEntry[], next: ThreadFeedEntry[]): ThreadFeedEntry[] {
  const rows = new Map(previous.map((entry) => [`${entry.type}:${entry.id}`, entry]));
  const uniqueKeys = new Set(next.map((entry) => `${entry.type}:${entry.id}`));
  if (rows.size !== previous.length || uniqueKeys.size !== next.length) return next;
  let sameArray = previous.length === next.length;
  const reused = next.map((entry, index) => {
    const old = rows.get(`${entry.type}:${entry.id}`);
    const row = old !== undefined && sameFeedRow(old, entry) ? old : entry;
    if (row !== previous[index]) sameArray = false;
    return row;
  });
  return sameArray ? previous : reused;
}

function sameLatestTurn(
  left: ThreadFeedLatestTurn | null,
  right: ThreadFeedLatestTurn | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.turnId === right.turnId &&
      left.state === right.state &&
      left.startedAt === right.startedAt &&
      left.completedAt === right.completedAt)
  );
}

function sameFoldSource(left: ThreadFeedEntry, right: ThreadFeedEntry): boolean {
  if (left === right) return true;
  if (left.type !== "message" || right.type !== "message") return false;
  return (
    left.id === right.id &&
    left.createdAt === right.createdAt &&
    left.message.role === right.message.role &&
    left.message.turnId === right.message.turnId &&
    left.message.streaming === right.message.streaming &&
    (left.message.streaming || left.message.updatedAt === right.message.updatedAt)
  );
}

/** 正文变化不重建折叠与工具展示；回合终态、分组和展开操作仍重新推导。 */
export function createThreadFeedPresentationSelector() {
  let previous: {
    readonly feed: ReadonlyArray<ThreadFeedEntry>;
    readonly latestTurn: ThreadFeedLatestTurn | null;
    readonly expandedTurns: ReadonlySet<TurnId>;
    readonly expandedGroups: ReadonlySet<string>;
    readonly activeWorkStartedAt: string | null;
    readonly language: ReturnType<typeof getCurrentLanguage>;
    readonly result: ThreadFeedEntry[];
  } | null = null;
  const emptyGroups = new Set<string>();
  return (
    feed: ReadonlyArray<ThreadFeedEntry>,
    latestTurn: ThreadFeedLatestTurn | null,
    expandedTurns: ReadonlySet<TurnId>,
    expandedGroups: ReadonlySet<string> = emptyGroups,
    activeWorkStartedAt: string | null = null,
  ): ThreadFeedEntry[] => {
    const language = getCurrentLanguage();
    let result: ThreadFeedEntry[] | null = null;
    if (
      previous !== null &&
      sameLatestTurn(previous.latestTurn, latestTurn) &&
      sameSet(previous.expandedTurns, expandedTurns) &&
      sameSet(previous.expandedGroups, expandedGroups) &&
      previous.activeWorkStartedAt === activeWorkStartedAt &&
      previous.language === language &&
      previous.feed.length === feed.length &&
      previous.feed.every((entry, index) => sameFoldSource(entry, feed[index]!))
    ) {
      const messages = new Map(
        feed.filter((entry) => entry.type === "message").map((entry) => [entry.id, entry]),
      );
      // 重复身份不做猜测；保持原有按顺序展示的语义。
      if (messages.size === feed.filter((entry) => entry.type === "message").length) {
        let changed = false;
        const updated = previous.result.map((entry) => {
          const replacement = entry.type === "message" ? messages.get(entry.id) : undefined;
          if (replacement === undefined || replacement === entry) return entry;
          changed = true;
          return replacement;
        });
        result = changed ? updated : previous.result;
      }
    }
    if (result === null) {
      const rebuilt = deriveThreadFeedPresentation(
        feed,
        latestTurn,
        expandedTurns,
        expandedGroups,
        activeWorkStartedAt,
      );
      result =
        previous !== null && previous.language === language
          ? reuseFeedRows(previous.result, rebuilt)
          : rebuilt;
    }
    previous = {
      feed,
      latestTurn,
      expandedTurns,
      expandedGroups,
      activeWorkStartedAt,
      language,
      result,
    };
    return result;
  };
}
