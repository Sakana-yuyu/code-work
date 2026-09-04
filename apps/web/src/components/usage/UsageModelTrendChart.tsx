import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { DailyTotals } from "@codework/shared/usageMerge";
import { formatDayShort, formatTokens } from "@codework/shared/usageFormat";

import { t, useResolvedLanguage } from "../../i18n";
import { curvePath, niceScale, smoothCurve } from "./UsageProviderChart";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const TICK_COUNT = 4;
const PLOT_TOP = 8;

export interface UsageModelSeries {
  /** `provider model` composite, matching `DailyTotals.byModel` keys. */
  readonly key: string;
  readonly label: string;
  readonly color: string;
}

interface UsageModelTrendChartProps {
  readonly models: readonly UsageModelSeries[];
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
}

/**
 * Daily token trend per model over the selected window, heaviest series on
 * top. The daily scale tops out at the largest single model-day, not the sum:
 * every line measures from the same zero baseline.
 */
export function UsageModelTrendChart({ models, days, daily }: UsageModelTrendChartProps) {
  const language = useResolvedLanguage();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverPositionRef = useRef<{ x: number; y: number } | null>(null);

  const { series, ticks, stepX, toY, columns } = useMemo(() => {
    const byDay = new Map(daily.map((entry) => [entry.day, entry]));
    const builtColumns = days.map((day) => {
      const byModel = byDay.get(day)?.byModel;
      const values = models.map((model) => byModel?.get(model.key) ?? 0);
      return {
        values,
        total: values.reduce((sum, value) => sum + value, 0),
        day,
      };
    });

    if (days.length === 0 || models.length === 0) {
      return {
        series: [],
        ticks: [0] as readonly number[],
        stepX: 0,
        toY: () => VIEW_HEIGHT,
        columns: builtColumns,
      };
    }

    const peak = builtColumns.reduce(
      (max, column) => column.values.reduce((inner, value) => Math.max(inner, value), max),
      0,
    );
    const { max, ticks: tickValues } = niceScale(peak, TICK_COUNT);
    const step = days.length === 1 ? 0 : VIEW_WIDTH / (days.length - 1);
    // Room above the top gridline keeps the stroke unclipped at the peak.
    const scale = (value: number) =>
      max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / max) * (VIEW_HEIGHT - PLOT_TOP);

    const built = models.map((model, modelIndex) => {
      const points = builtColumns.map((column, dayIndex) => ({
        x: dayIndex * step,
        y: scale(column.values[modelIndex] ?? 0),
      }));
      const total = builtColumns.reduce((sum, column) => sum + (column.values[modelIndex] ?? 0), 0);
      const line = curvePath(smoothCurve(points));
      return {
        model,
        total,
        line,
        area: line === "" ? "" : `${line} L${VIEW_WIDTH},${VIEW_HEIGHT} L0,${VIEW_HEIGHT} Z`,
      };
    });

    return {
      series: built,
      ticks: tickValues,
      stepX: step,
      toY: scale,
      columns: builtColumns,
    };
  }, [daily, days, models]);

  const positionTooltip = useCallback(() => {
    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    const hoverPosition = hoverPositionRef.current;
    if (plot === null || tooltip === null || hoverPosition === null) return;

    const gap = 12;
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const plotWidth = plot.clientWidth;
    const plotHeight = plot.clientHeight;
    const preferredLeft =
      hoverPosition.x + gap + tooltipWidth <= plotWidth
        ? hoverPosition.x + gap
        : hoverPosition.x - gap - tooltipWidth;
    const preferredTop =
      hoverPosition.y + gap + tooltipHeight <= plotHeight
        ? hoverPosition.y + gap
        : hoverPosition.y - gap - tooltipHeight;
    const left = Math.min(Math.max(0, preferredLeft), Math.max(0, plotWidth - tooltipWidth));
    const top = Math.min(Math.max(0, preferredTop), Math.max(0, plotHeight - tooltipHeight));
    plot.style.setProperty("--usage-tooltip-left", `${left}px`);
    plot.style.setProperty("--usage-tooltip-top", `${top}px`);
  }, []);

  useLayoutEffect(() => {
    if (hoverIndex === null) return;
    positionTooltip();

    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    if (plot === null || tooltip === null || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(positionTooltip);
    observer.observe(plot);
    observer.observe(tooltip);
    return () => observer.disconnect();
  }, [hoverIndex, positionTooltip]);

  const handleMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const plot = plotRef.current;
      if (plot === null || days.length === 0) return;
      const bounds = plot.getBoundingClientRect();
      if (bounds.width === 0) return;
      const localX = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left));
      const localY = Math.min(bounds.height, Math.max(0, event.clientY - bounds.top));
      const index = Math.round((localX / bounds.width) * (days.length - 1));
      hoverPositionRef.current = { x: localX, y: localY };
      positionTooltip();
      setHoverIndex(Math.min(days.length - 1, Math.max(0, index)));
    },
    [days.length, positionTooltip],
  );

  const hoveredColumn = hoverIndex === null ? undefined : columns[hoverIndex];
  // Paint the heaviest series first so a lighter one is not buried.
  const paintOrder = useMemo(() => [...series].sort((a, b) => b.total - a.total), [series]);

  return (
    <div className="flex flex-col gap-2">
      {models.length > 1 ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {models.map((model) => (
            <span
              key={model.key}
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: model.color }}
              />
              {model.label}
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex gap-2">
        {/* Axis labels sit outside the plot so they stay aligned to gridlines. */}
        <div className="relative h-56 w-14 shrink-0">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2 text-[10px] text-muted-foreground tabular-nums"
              style={{ top: `${(toY(tick) / VIEW_HEIGHT) * 100}%` }}
            >
              {tick === 0 ? "0" : formatTokens(tick)}
            </span>
          ))}
        </div>

        <div
          ref={plotRef}
          className="usage-chart-plot relative h-56 flex-1"
          onMouseMove={handleMove}
          onMouseLeave={() => {
            hoverPositionRef.current = null;
            setHoverIndex(null);
          }}
        >
          <svg
            className="h-full w-full"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={t("usage.modelTrend")}
          >
            {ticks.map((tick) => {
              const y = toY(tick);
              return (
                <line
                  key={tick}
                  x1={0}
                  x2={VIEW_WIDTH}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  strokeWidth={1}
                  className="text-border"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}

            {/* Fills first, then every stroke, so no series covers another's line. */}
            {paintOrder.map(({ model, area }) => (
              <path key={`${model.key}-area`} d={area} fill={model.color} fillOpacity={0.12} />
            ))}
            {paintOrder.map(({ model, line }) => (
              <path
                key={model.key}
                d={line}
                fill="none"
                stroke={model.color}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {hoverIndex === null || days.length === 0 ? null : (
              <line
                x1={hoverIndex * stepX}
                x2={hoverIndex * stepX}
                y1={PLOT_TOP}
                y2={VIEW_HEIGHT}
                stroke="currentColor"
                strokeWidth={1}
                className="text-muted-foreground"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>

          {hoveredColumn === undefined ? null : (
            <div
              ref={tooltipRef}
              className="surface-glass pointer-events-none absolute z-10 min-w-36 max-w-full rounded-xl border border-border/50 px-2.5 py-2 text-xs shadow-lg"
              style={{
                left: "var(--usage-tooltip-left, 0px)",
                top: "var(--usage-tooltip-top, 0px)",
              }}
            >
              <div className="mb-1 text-muted-foreground">
                {formatDayShort(hoveredColumn.day, language)}
              </div>
              {models.map((model, modelIndex) => (
                <div key={model.key} className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: model.color }}
                    />
                    {model.label}
                  </span>
                  <span className="text-foreground tabular-nums">
                    {formatTokens(hoveredColumn.values[modelIndex] ?? 0)}
                  </span>
                </div>
              ))}
              <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-1">
                <span className="text-muted-foreground">{t("total")}</span>
                <span className="text-foreground tabular-nums">
                  {formatTokens(hoveredColumn.total)}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-between pl-16 text-[10px] text-muted-foreground uppercase">
        <span>{days[0] === undefined ? "" : formatDayShort(days[0], language)}</span>
        <span>
          {days[Math.floor(days.length / 2)] === undefined
            ? ""
            : formatDayShort(days[Math.floor(days.length / 2)] ?? "", language)}
        </span>
        <span>
          {days[days.length - 1] === undefined
            ? ""
            : formatDayShort(days[days.length - 1] ?? "", language)}
        </span>
      </div>
    </div>
  );
}
