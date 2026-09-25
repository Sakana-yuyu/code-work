import { type TurnId } from "@codework/contracts";
import { expect, it } from "vite-plus/test";
import type { TimelineEntry } from "../../session-logic";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
} from "./MessagesTimeline.logic";

const turnId = "long-running-turn" as TurnId;

function durationSummary(durations: number[]) {
  const sorted = durations.toSorted((a, b) => a - b);
  const middle = sorted.length / 2;
  return {
    median: (sorted[middle - 1]! + sorted[middle]!) / 2,
    p90: sorted[Math.ceil(sorted.length * 0.9) - 1]!,
  };
}

function longRunningEntries(count: number): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    entries.push({
      kind: "reasoning-summary",
      id: `reasoning-${index}`,
      createdAt,
      summaries: [{ id: `summary-${index}`, turnId, createdAt, text: "Checking progress" }],
    });
    entries.push({
      kind: "work",
      id: `work-${index}`,
      createdAt,
      entry: {
        id: `tool-${index}`,
        turnId,
        createdAt,
        label: "Read file",
        tone: "tool",
        toolLifecycleStatus: "completed",
      },
    });
  }
  const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, count)).toISOString();
  entries.push({
    kind: "work",
    id: "running-work",
    createdAt,
    entry: {
      id: "running-tool",
      turnId,
      createdAt,
      label: "Running tests",
      tone: "tool",
      toolLifecycleStatus: "inProgress",
    },
  });
  return entries;
}

function deriveLongRunningRows(entries: TimelineEntry[], expanded = false) {
  return deriveMessagesTimelineRows({
    timelineEntries: entries,
    ...(expanded ? { expandedWorkGroupIds: new Set([`activity:${turnId}`]) } : {}),
    latestTurn: {
      turnId,
      state: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: null,
    },
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00.000Z",
    turnDiffSummaryByAssistantMessageId: new Map(),
    revertTurnCountByUserMessageId: new Map(),
  });
}

it("长事件流保持折叠、实时工具和稳定行；可按需打印派生耗时", () => {
  for (const count of [250, 1_000, 4_000]) {
    const entries = longRunningEntries(count);
    const rows = deriveLongRunningRows(entries);
    expect(rows.some((row) => row.kind === "activity-fold")).toBe(true);
    expect(rows.some((row) => row.kind === "work-live" && row.entry.id === "running-tool")).toBe(
      true,
    );
    const expandedRows = deriveLongRunningRows(entries, true);
    expect(expandedRows.filter((row) => row.kind === "reasoning-summary")).toHaveLength(count);
    expect(expandedRows.some((row) => row.kind === "work-live")).toBe(true);
    const stable = computeStableMessagesTimelineRows(rows, {
      byId: new Map(),
      result: [],
    });
    expect(stable.result).toHaveLength(rows.length);

    if (process.env.TIMELINE_BENCH === "1") {
      for (const expanded of [false, true]) {
        for (let warmup = 0; warmup < 3; warmup += 1) deriveLongRunningRows(entries, expanded);
        const durations: number[] = [];
        const stableDurations: number[] = [];
        let rowCount = 0;
        for (let run = 0; run < 10; run += 1) {
          const started = performance.now();
          const derived = deriveLongRunningRows(entries, expanded);
          const stabilizedAt = performance.now();
          computeStableMessagesTimelineRows(derived, stable);
          rowCount = derived.length;
          durations.push(performance.now() - started);
          stableDurations.push(performance.now() - stabilizedAt);
        }
        const total = durationSummary(durations);
        const stabilization = durationSummary(stableDurations);
        console.info(
          `timeline ${expanded ? "expanded" : "folded"} ${entries.length} entries: median=${total.median.toFixed(2)}ms p90=${total.p90.toFixed(2)}ms stableMedian=${stabilization.median.toFixed(2)}ms stableP90=${stabilization.p90.toFixed(2)}ms rows=${rowCount}`,
        );
      }
    }
  }
});

it("长任务连续更新实时工具时保留新状态与失败详情", () => {
  const entries = longRunningEntries(4_000);
  const last = entries.at(-1);
  if (last?.kind !== "work") throw new Error("缺少实时工具事件");
  const history = entries.slice(0, -1);
  let stable = computeStableMessagesTimelineRows(deriveLongRunningRows(entries), {
    byId: new Map(),
    result: [],
  });
  const durations: number[] = [];

  for (let update = 0; update < 20; update += 1) {
    const detail = `已处理 ${update + 1} 项`;
    const updatedEntries: TimelineEntry[] = [
      ...history,
      { ...last, entry: { ...last.entry, detail } },
    ];
    const started = performance.now();
    const next = computeStableMessagesTimelineRows(deriveLongRunningRows(updatedEntries), stable);
    durations.push(performance.now() - started);
    expect(next.result.find((row) => row.kind === "work-live")?.entry.detail).toBe(detail);
    expect(next.result.find((row) => row.kind === "activity-fold")).toBe(
      stable.result.find((row) => row.kind === "activity-fold"),
    );
    stable = next;
  }

  const failedEntries: TimelineEntry[] = [
    ...history,
    {
      ...last,
      entry: {
        ...last.entry,
        detail: "测试失败：退出码 1",
        tone: "error",
        toolLifecycleStatus: "failed",
      },
    },
  ];
  const failedRows = deriveLongRunningRows(failedEntries);
  expect(
    failedRows.some(
      (row) =>
        (row.kind === "work" || row.kind === "work-live") &&
        row.groupedEntries.some(
          (entry) => entry.toolLifecycleStatus === "failed" && entry.detail?.includes("退出码 1"),
        ),
    ),
  ).toBe(true);

  if (process.env.TIMELINE_BENCH === "1") {
    const { median, p90 } = durationSummary(durations);
    console.info(
      `timeline streaming ${entries.length} entries: median=${median.toFixed(2)}ms p90=${p90.toFixed(2)}ms`,
    );
  }
});

it("长任务连续输出正文时保留实时工具与历史折叠入口", () => {
  const history = longRunningEntries(4_000);
  const createdAt = "2026-01-01T01:07:00.000Z";
  const message = {
    id: "streaming-message" as never,
    role: "assistant" as const,
    text: "",
    turnId,
    createdAt,
    updatedAt: createdAt,
    streaming: true,
  };
  let stable = computeStableMessagesTimelineRows(deriveLongRunningRows(history), {
    byId: new Map(),
    result: [],
  });
  const durations: number[] = [];

  for (let chunk = 0; chunk < 20; chunk += 1) {
    const text = "正在处理文件。".repeat(chunk + 1);
    const entries: TimelineEntry[] = [
      ...history,
      {
        kind: "message",
        id: message.id,
        createdAt,
        message: {
          ...message,
          text,
          updatedAt: new Date(Date.parse(createdAt) + chunk).toISOString(),
        },
      },
    ];
    const started = performance.now();
    const next = computeStableMessagesTimelineRows(deriveLongRunningRows(entries), stable);
    durations.push(performance.now() - started);
    expect(next.result.find((row) => row.kind === "message")?.message.text).toBe(text);
    expect(
      next.result.some((row) => row.kind === "work-live" && row.entry.id === "running-tool"),
    ).toBe(true);
    expect(next.result.find((row) => row.kind === "activity-fold")).toBe(
      stable.result.find((row) => row.kind === "activity-fold"),
    );
    stable = next;
  }

  if (process.env.TIMELINE_BENCH === "1") {
    const { median, p90 } = durationSummary(durations);
    console.info(
      `timeline text streaming ${history.length + 1} entries: median=${median.toFixed(2)}ms p90=${p90.toFixed(2)}ms`,
    );
  }
});
