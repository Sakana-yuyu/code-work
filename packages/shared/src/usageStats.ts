// @effect-diagnostics globalDate:off -- Streak and week arithmetic is calendar-day math on `YYYY-MM-DD` strings that were bucketed by Intl wall clocks.
/**
 * Engagement-style derivations over merged usage data: streaks, daily peaks,
 * weekly rollups, and the per-model token split behind the donut. Pure, so the
 * calendar rules can be tested without a connected environment.
 *
 * @module usageStats
 */
import type { UsageProviderKind } from "@codework/contracts";

import type { ModelTotals } from "./usageMerge.ts";

const DAY_MS = 86_400_000;

export interface UsageActivityStats {
  readonly peakDay: string | null;
  readonly peakDayTokens: number;
  readonly activeDays: number;
  readonly currentStreak: number;
  readonly longestStreak: number;
}

/** The calendar day before a `YYYY-MM-DD` day, still `YYYY-MM-DD`. */
function previousDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

/**
 * Engagement stats over an ordered inclusive day list.
 *
 * A day is active when it burned any tokens. The current streak counts
 * consecutive active days ending at `untilDay`; an inactive today stays alive
 * through yesterday, the convention streak UIs use, so opening the page before
 * the first turn of the day does not read as a broken streak.
 */
export function computeActivityStats(
  days: readonly string[],
  tokensByDay: ReadonlyMap<string, number>,
  untilDay: string,
): UsageActivityStats {
  let peakDay: string | null = null;
  let peakDayTokens = 0;
  let activeDays = 0;
  let longestStreak = 0;
  let run = 0;

  for (const day of days) {
    const tokens = tokensByDay.get(day) ?? 0;
    if (tokens <= 0) {
      run = 0;
      continue;
    }
    activeDays += 1;
    run += 1;
    if (run > longestStreak) longestStreak = run;
    if (tokens > peakDayTokens) {
      peakDayTokens = tokens;
      peakDay = day;
    }
  }

  const todayActive = (tokensByDay.get(untilDay) ?? 0) > 0;
  const streakAnchor = todayActive ? untilDay : previousDay(untilDay);
  let currentStreak = 0;
  for (let day = streakAnchor; (tokensByDay.get(day) ?? 0) > 0; day = previousDay(day)) {
    currentStreak += 1;
  }

  return { peakDay, peakDayTokens, activeDays, currentStreak, longestStreak };
}

export interface UsageWeekTotals {
  readonly weekStart: string;
  readonly days: readonly string[];
  readonly tokens: number;
}

/** Monday-start week rollups over an ordered day list. */
export function aggregateWeeks(
  days: readonly string[],
  tokensByDay: ReadonlyMap<string, number>,
): readonly UsageWeekTotals[] {
  const weeks: { weekStart: string; days: string[]; tokens: number }[] = [];
  let current: { weekStart: string; days: string[]; tokens: number } | null = null;

  for (const day of days) {
    const instant = Date.parse(`${day}T00:00:00Z`);
    const backToMonday = (new Date(instant).getUTCDay() + 6) % 7;
    const weekStart = new Date(instant - backToMonday * DAY_MS).toISOString().slice(0, 10);
    if (current === null || current.weekStart !== weekStart) {
      current = { weekStart, days: [day], tokens: tokensByDay.get(day) ?? 0 };
      weeks.push(current);
    } else {
      current.days.push(day);
      current.tokens += tokensByDay.get(day) ?? 0;
    }
  }
  return weeks;
}

/**
 * Running total after each day, so the cumulative heatmap mode can color cells
 * by how much has been spent so far rather than by that day's volume.
 */
export function cumulativeTotals(
  days: readonly string[],
  tokensByDay: ReadonlyMap<string, number>,
): readonly number[] {
  let total = 0;
  return days.map((day) => {
    total += tokensByDay.get(day) ?? 0;
    return total;
  });
}

/**
 * Cell intensity 0-4 relative to the window peak: quartile bands keep the ramp
 * readable whether the peak is a million tokens or a billion.
 */
export function activityLevel(tokens: number, peak: number): 0 | 1 | 2 | 3 | 4 {
  if (tokens <= 0 || peak <= 0) return 0;
  // The min/max bounds are exactly the union, so the narrowing is safe.
  return Math.min(4, Math.max(1, Math.ceil((tokens / peak) * 4))) as 1 | 2 | 3 | 4;
}

export interface RankedModel {
  /** `provider model` composite, matching `DailyTotals.byModel` keys. */
  readonly key: string;
  readonly model: string;
  readonly provider: UsageProviderKind;
  readonly totalTokens: number;
}

/** Models by token volume, heaviest first, for the trend chart and donut. */
export function rankModelsByTokens(models: readonly ModelTotals[]): readonly RankedModel[] {
  return models
    .map((entry) => ({
      key: `${entry.provider} ${entry.model}`,
      model: entry.model,
      provider: entry.provider,
      totalTokens: entry.totalTokens,
    }))
    .filter((entry) => entry.totalTokens > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

export interface ModelShareSlice {
  readonly key: string;
  readonly model: string;
  readonly provider: UsageProviderKind;
  readonly totalTokens: number;
  readonly share: number;
}

/**
 * Token-share slices for the donut: the heaviest `maxSlices` models, with the
 * tail collapsed into a single remainder so six colors never become sixteen.
 */
export function modelShareSlices(
  models: readonly ModelTotals[],
  maxSlices: number,
): {
  readonly slices: readonly ModelShareSlice[];
  readonly otherTokens: number;
  readonly otherShare: number;
} {
  const ranked = rankModelsByTokens(models);
  const totalTokens = ranked.reduce((sum, entry) => sum + entry.totalTokens, 0);
  const share = (tokens: number) => (totalTokens === 0 ? 0 : tokens / totalTokens);
  const otherTokens = ranked.slice(maxSlices).reduce((sum, entry) => sum + entry.totalTokens, 0);

  return {
    slices: ranked.slice(0, maxSlices).map((entry) => ({
      ...entry,
      share: share(entry.totalTokens),
    })),
    otherTokens,
    otherShare: share(otherTokens),
  };
}
