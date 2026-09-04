import { useMemo, useState } from "react";

import { activityLevel, aggregateWeeks, cumulativeTotals } from "@codework/shared/usageStats";
import type { DailyTotals } from "@codework/shared/usageMerge";
import { formatTokens, formatUsd } from "@codework/shared/usageFormat";

import { t, useResolvedLanguage } from "../../i18n";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type HeatmapMode = "daily" | "weekly" | "cumulative";

const MODES: readonly { readonly value: HeatmapMode; readonly labelKey: string }[] = [
  { value: "daily", labelKey: "daily" },
  { value: "weekly", labelKey: "usage.viewWeekly" },
  { value: "cumulative", labelKey: "usage.viewCumulative" },
];

const LEVEL_CLASSES = [
  "bg-muted",
  "bg-blue-500/30",
  "bg-blue-500/55",
  "bg-blue-500/80",
  "bg-blue-400",
] as const;

const CELL_PX = 10;
const CELL_GAP_PX = 3;

interface HeatmapUsage {
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly providerCount: number;
  readonly modelCount: number;
  readonly cumulativeTokens?: number;
}

interface HeatmapCell {
  readonly key: string;
  readonly level: 0 | 1 | 2 | 3 | 4;
  readonly label: string;
  readonly usage: HeatmapUsage;
}

/**
 * GitHub-style token activity calendar over a long window.
 *
 * 每日 colors each day by that day's volume, 每周 collapses to one cell per
 * Monday-start week, and 累计 colors each day by how much has accumulated so
 * far, which shows the growth ramp rather than the daily spikes.
 */
export function UsageActivityHeatmap({
  days,
  dailyByDay,
}: {
  readonly days: readonly string[];
  readonly dailyByDay: ReadonlyMap<string, DailyTotals>;
}) {
  const language = useResolvedLanguage();
  const [mode, setMode] = useState<HeatmapMode>("daily");
  const tokensByDay = useMemo(
    () => new Map([...dailyByDay].map(([day, entry]) => [day, entry.totalTokens])),
    [dailyByDay],
  );

  const cells = useMemo<readonly HeatmapCell[]>(() => {
    if (mode === "weekly") {
      const weeks = aggregateWeeks(days, tokensByDay);
      const peak = weeks.reduce((max, week) => Math.max(max, week.tokens), 0);
      return weeks.map((week) => ({
        key: week.weekStart,
        level: activityLevel(week.tokens, peak),
        label: weekLabel(week.days, language),
        usage: summarizeUsage(week.days, dailyByDay),
      }));
    }

    const values =
      mode === "cumulative"
        ? cumulativeTotals(days, tokensByDay)
        : days.map((day) => tokensByDay.get(day) ?? 0);
    const peak = values.reduce((max, value) => Math.max(max, value), 0);
    return days.map((day, index) => {
      const value = values[index] ?? 0;
      const dailyUsage = usageForDay(day, dailyByDay);
      return {
        key: day,
        level: activityLevel(value, peak),
        label: formatHeatmapDay(day, language),
        usage: mode === "cumulative" ? { ...dailyUsage, cumulativeTokens: value } : dailyUsage,
      };
    });
  }, [dailyByDay, days, language, mode, tokensByDay]);

  // Month labels under the columns: one whenever the month of the first day in
  // a week column differs from the previous column's, positioned by the same
  // pitch the cells use so they stay glued to their columns.
  const monthLabels = useMemo(() => {
    // Daily and cumulative columns hold one week of cells; weekly columns are
    // the weeks themselves.
    const columnStride = mode === "weekly" ? 1 : 7;
    const labels: { readonly left: number; readonly label: string }[] = [];
    const columnCount = Math.ceil(cells.length / columnStride);
    const monthLabelFormatter = new Intl.DateTimeFormat(language, { month: "short" });
    let previousMonth = -1;
    for (let column = 0; column < columnCount; column += 1) {
      const cell = cells[column * columnStride];
      if (cell === undefined) continue;
      const date = new Date(`${cell.key}T00:00:00Z`);
      const month = date.getUTCMonth();
      if (month !== previousMonth) {
        previousMonth = month;
        labels.push({
          left: columnCount === 0 ? 0 : (column / columnCount) * 100,
          label: monthLabelFormatter.format(date),
        });
      }
    }
    return labels;
  }, [cells, language, mode]);

  const columnStride = mode === "weekly" ? 1 : 7;
  const columnCount = Math.max(1, Math.ceil(cells.length / columnStride));
  const minimumGridWidth = columnCount * CELL_PX + Math.max(0, columnCount - 1) * CELL_GAP_PX;
  const gridStyle = {
    gridTemplateColumns: `repeat(${columnCount}, minmax(${CELL_PX}px, 1fr))`,
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">{t("usage.tokenActivity")}</h2>
        <ToggleGroup
          aria-label={t("usage.tokenActivity")}
          variant="segmented"
          value={[mode]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "daily" || value === "weekly" || value === "cumulative") setMode(value);
          }}
        >
          {MODES.map((option) => (
            <Toggle key={option.value} value={option.value}>
              {t(option.labelKey)}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>

      {cells.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {t("noActivityInThisWindow")}
        </p>
      ) : (
        <div className="rounded-xl border border-border/60 bg-background/30 p-3 shadow-inner">
          <div className="overflow-x-auto pb-1">
            <div className="w-full" style={{ minWidth: `${minimumGridWidth}px` }}>
              <div
                className={
                  // Column-first placement: seven weekday rows for daily and
                  // cumulative, one row of weeks for weekly.
                  mode === "weekly"
                    ? "grid grid-flow-col grid-rows-1 gap-[3px]"
                    : "grid grid-flow-col grid-rows-7 gap-[3px]"
                }
                style={gridStyle}
              >
                {cells.map((cell) => {
                  const tooltipText = cellTooltipText(cell);
                  return (
                    <Tooltip key={cell.key}>
                      <TooltipTrigger
                        render={
                          <button
                            aria-label={`${cell.label} · ${formatTokens(cell.usage.totalTokens)} ${t("tokens")}`}
                            className={`block size-full min-h-[10px] rounded-[2px] border-0 p-0 ring-1 ring-inset ring-border/40 transition-[filter,transform] hover:brightness-110 hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none motion-reduce:hover:scale-100 ${LEVEL_CLASSES[cell.level]}`}
                            title={tooltipText}
                            type="button"
                          />
                        }
                      />
                      <TooltipPopup side="top" className="max-w-60 whitespace-nowrap">
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium">{cell.label}</span>
                          <span>
                            {t("tokens")}: {formatTokens(cell.usage.totalTokens)}
                          </span>
                          <span>
                            {t("cost")}: {formatUsd(cell.usage.costUsd)}
                          </span>
                          <span>
                            {t("providers")}: {cell.usage.providerCount}
                          </span>
                          <span>
                            {t("models")}: {cell.usage.modelCount}
                          </span>
                          {cell.usage.cumulativeTokens === undefined ? null : (
                            <span>
                              {t("usage.viewCumulative")}:{" "}
                              {formatTokens(cell.usage.cumulativeTokens)}
                            </span>
                          )}
                        </div>
                      </TooltipPopup>
                    </Tooltip>
                  );
                })}
              </div>
              <div className="relative mt-2 h-5 border-t border-border/50 pt-1">
                {monthLabels.map(({ left, label }) => (
                  <span
                    key={`${label}-${left}`}
                    className="absolute top-1 text-[10px] whitespace-nowrap text-muted-foreground"
                    style={{ left: `${left}%` }}
                  >
                    {label}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function usageForDay(day: string, dailyByDay: ReadonlyMap<string, DailyTotals>): HeatmapUsage {
  const entry = dailyByDay.get(day);
  return {
    totalTokens: entry?.totalTokens ?? 0,
    costUsd: entry?.costUsd ?? 0,
    providerCount: entry?.byProvider.size ?? 0,
    modelCount: entry?.byModel.size ?? 0,
  };
}

function summarizeUsage(
  days: readonly string[],
  dailyByDay: ReadonlyMap<string, DailyTotals>,
): HeatmapUsage {
  const providers = new Set<string>();
  const models = new Set<string>();
  let totalTokens = 0;
  let costUsd = 0;

  for (const day of days) {
    const entry = dailyByDay.get(day);
    if (entry === undefined) continue;
    totalTokens += entry.totalTokens;
    costUsd += entry.costUsd;
    for (const provider of entry.byProvider.keys()) providers.add(provider);
    for (const model of entry.byModel.keys()) models.add(model);
  }

  return {
    totalTokens,
    costUsd,
    providerCount: providers.size,
    modelCount: models.size,
  };
}

function weekLabel(days: readonly string[], language: string): string {
  const first = days[0];
  const last = days[days.length - 1] ?? first;
  if (first === undefined) return "";
  const firstLabel = formatHeatmapDay(first, language);
  return last === undefined || last === first
    ? firstLabel
    : `${firstLabel} – ${formatHeatmapDay(last, language)}`;
}

function formatHeatmapDay(day: string, language: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function cellTooltipText(cell: HeatmapCell): string {
  const lines = [
    cell.label,
    `${t("tokens")}: ${formatTokens(cell.usage.totalTokens)}`,
    `${t("cost")}: ${formatUsd(cell.usage.costUsd)}`,
    `${t("providers")}: ${cell.usage.providerCount}`,
    `${t("models")}: ${cell.usage.modelCount}`,
  ];
  if (cell.usage.cumulativeTokens !== undefined) {
    lines.push(`${t("usage.viewCumulative")}: ${formatTokens(cell.usage.cumulativeTokens)}`);
  }
  return lines.join("\n");
}
