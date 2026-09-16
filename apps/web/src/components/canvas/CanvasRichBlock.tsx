import type { CanvasBlock } from "@codework/contracts";
import { Circle, CircleCheck, CircleDot, Info, ShieldAlert, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

type CanvasCalloutTone = Extract<CanvasBlock, { type: "callout" }>["tone"];
type CanvasTodoStatus = Extract<CanvasBlock, { type: "todo" }>["items"][number]["status"];
type CanvasChartTone = NonNullable<
  Extract<CanvasBlock, { type: "badges" }>["items"][number]["tone"]
>;

type CanvasRichBlockData = Extract<
  CanvasBlock,
  {
    type:
      | "callout"
      | "todo"
      | "code"
      | "divider"
      | "badges"
      | "usage"
      | "chart_bar"
      | "chart_line"
      | "chart_pie"
      | "diff"
      | "disclose";
  }
>;

const CALLOUT_TONES: Record<
  CanvasCalloutTone,
  { icon: typeof Info; containerClassName: string; iconClassName: string }
> = {
  info: {
    icon: Info,
    containerClassName: "border-info/30 bg-info/5",
    iconClassName: "text-info",
  },
  success: {
    icon: CircleCheck,
    containerClassName: "border-emerald-500/30 bg-emerald-500/5",
    iconClassName: "text-emerald-600 dark:text-emerald-300/90",
  },
  warning: {
    icon: TriangleAlert,
    containerClassName: "border-amber-500/30 bg-amber-500/5",
    iconClassName: "text-amber-600 dark:text-amber-300/90",
  },
  risk: {
    icon: ShieldAlert,
    containerClassName: "border-red-500/30 bg-red-500/5",
    iconClassName: "text-red-600 dark:text-red-300/90",
  },
};

const TODO_ITEM_ICONS: Record<CanvasTodoStatus, typeof Circle> = {
  done: CircleCheck,
  in_progress: CircleDot,
  pending: Circle,
};

/** 图表系列循环取色；中性色收尾兜底（分段可能超过配色数）。 */
const SERIES_STYLES = [
  { line: "text-info", bg: "bg-info", bar: "bg-info" },
  {
    line: "text-emerald-600 dark:text-emerald-300/90",
    bg: "bg-emerald-500",
    bar: "bg-emerald-500/80",
  },
  {
    line: "text-amber-600 dark:text-amber-300/90",
    bg: "bg-amber-500",
    bar: "bg-amber-500/80",
  },
  {
    line: "text-violet-600 dark:text-violet-300/90",
    bg: "bg-violet-500",
    bar: "bg-violet-500/80",
  },
  {
    line: "text-pink-600 dark:text-pink-300/90",
    bg: "bg-pink-500",
    bar: "bg-pink-500/80",
  },
] as const;

const TONE_STYLES: Record<CanvasChartTone, { badge: string; bar: string; dot: string }> = {
  neutral: {
    badge: "bg-muted-foreground/15 text-muted-foreground",
    bar: "bg-muted-foreground/50",
    dot: "bg-muted-foreground",
  },
  info: { badge: "bg-info/15 text-info", bar: "bg-info", dot: "bg-info" },
  success: {
    badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300/90",
    bar: "bg-emerald-500/80",
    dot: "bg-emerald-500",
  },
  warning: {
    badge: "bg-amber-500/15 text-amber-600 dark:text-amber-300/90",
    bar: "bg-amber-500/80",
    dot: "bg-amber-500",
  },
  risk: {
    badge: "bg-red-500/15 text-red-600 dark:text-red-300/90",
    bar: "bg-red-500/80",
    dot: "bg-red-500",
  },
  accent: { badge: "bg-primary/15 text-primary", bar: "bg-primary/80", dot: "bg-primary" },
};

const formatChartValue = (value: number): string =>
  Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);

const seriesStyle = (index: number) =>
  SERIES_STYLES[index % SERIES_STYLES.length] ?? SERIES_STYLES[0]!;

function CanvasChartCard({ title, children }: { title?: string | undefined; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border/70 bg-card/50 p-4 sm:col-span-2">
      {title ? <p className="mb-3 text-sm font-medium">{title}</p> : null}
      {children}
    </div>
  );
}

function CanvasBarChart({ block }: { block: Extract<CanvasBlock, { type: "chart_bar" }> }) {
  const max = Math.max(...block.points.map((point) => Math.abs(point.value)), 1e-9);
  return (
    <CanvasChartCard title={block.title}>
      <div className="space-y-2">
        {block.points.map((point, pointIndex) => (
          <div key={pointIndex} className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="w-28 shrink-0 truncate text-xs text-muted-foreground">
                    {point.label}
                  </span>
                }
              />
              <TooltipPopup side="top" className="max-w-60 whitespace-nowrap">
                {point.label}
              </TooltipPopup>
            </Tooltip>
            <div className="h-4 min-w-0 flex-1 overflow-hidden rounded-sm bg-muted/60">
              <div
                className={cn("h-full rounded-sm", seriesStyle(pointIndex).bar)}
                style={{ width: `${Math.max((Math.abs(point.value) / max) * 100, 1.5)}%` }}
              />
            </div>
            <span className="w-20 shrink-0 text-right text-xs tabular-nums text-foreground/80">
              {formatChartValue(point.value)}
              {block.unit ?? ""}
            </span>
          </div>
        ))}
      </div>
    </CanvasChartCard>
  );
}

function CanvasLineChart({ block }: { block: Extract<CanvasBlock, { type: "chart_line" }> }) {
  const width = 100;
  const height = 44;
  const pad = 2;
  const all = block.series.flatMap((series) => series.points);
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const count = block.labels.length;
  const xAt = (index: number) => pad + (index * (width - 2 * pad)) / Math.max(count - 1, 1);
  const yAt = (value: number) => pad + (1 - (value - min) / span) * (height - 2 * pad);
  const stride = Math.ceil(count / 6);
  const axisLabels = block.labels.filter(
    (label, index) => index % stride === 0 || index === count - 1,
  );
  return (
    <CanvasChartCard title={block.title}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-28 w-full"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {block.series.map((series, seriesIndex) => (
          <polyline
            key={seriesIndex}
            points={series.points.map((value, index) => `${xAt(index)},${yAt(value)}`).join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            className={cn(seriesStyle(seriesIndex).line)}
          />
        ))}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-muted-foreground">
        {axisLabels.map((label, labelIndex) => (
          <span key={labelIndex} className="max-w-20 truncate">
            {label}
          </span>
        ))}
      </div>
      {block.series.length > 1 ? (
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
          {block.series.map((series, seriesIndex) => (
            <span
              key={seriesIndex}
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <span className={cn("size-2 rounded-full", seriesStyle(seriesIndex).bg)} />
              {series.label}
            </span>
          ))}
        </div>
      ) : null}
    </CanvasChartCard>
  );
}

function CanvasPieChart({ block }: { block: Extract<CanvasBlock, { type: "chart_pie" }> }) {
  const total = block.slices.reduce((sum, slice) => sum + slice.value, 0) || 1;
  // r=15.915 makes the circumference exactly 100, so dasharray reads as percent.
  const radius = 15.915;
  let consumed = 0;
  return (
    <CanvasChartCard title={block.title}>
      <div className="flex items-center gap-5">
        <svg viewBox="0 0 36 36" className="-rotate-90 size-28 shrink-0" aria-hidden="true">
          {block.slices.map((slice, sliceIndex) => {
            const fraction = (slice.value / total) * 100;
            const element = (
              <circle
                key={sliceIndex}
                cx="18"
                cy="18"
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth={5.5}
                strokeDasharray={`${Math.max(fraction - 0.6, 0.3)} ${100 - fraction + 0.6}`}
                strokeDashoffset={-consumed}
                className={cn(seriesStyle(sliceIndex).line)}
              />
            );
            consumed += fraction;
            return element;
          })}
        </svg>
        <div className="min-w-0 flex-1 space-y-1.5">
          {block.slices.map((slice, sliceIndex) => (
            <div key={sliceIndex} className="flex items-center gap-2 text-xs">
              <span className={cn("size-2 shrink-0 rounded-full", seriesStyle(sliceIndex).bg)} />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{slice.label}</span>
              <span className="tabular-nums text-foreground/80">
                {formatChartValue(slice.value)}
              </span>
              <span className="w-10 text-right tabular-nums text-muted-foreground">
                {Math.round((slice.value / total) * 100)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </CanvasChartCard>
  );
}

function CanvasUsageBar({ block }: { block: Extract<CanvasBlock, { type: "usage" }> }) {
  const total = block.segments.reduce((sum, segment) => sum + segment.value, 0) || 1;
  return (
    <div className="rounded-xl border border-border/70 bg-card/50 p-4 sm:col-span-2">
      {block.label ? <p className="mb-2 text-sm font-medium">{block.label}</p> : null}
      <div className="flex h-3 overflow-hidden rounded-full bg-muted/60">
        {block.segments.map((segment, segmentIndex) => (
          <div
            key={segmentIndex}
            className={cn(TONE_STYLES[segment.tone ?? "neutral"].bar)}
            style={{ width: `${(segment.value / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {block.segments.map((segment, segmentIndex) => (
          <span
            key={segmentIndex}
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <span
              className={cn("size-2 rounded-full", TONE_STYLES[segment.tone ?? "neutral"].dot)}
            />
            {segment.label}
            <span className="tabular-nums text-foreground/80">
              {formatChartValue(segment.value)}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

function CanvasDiffView({ block }: { block: Extract<CanvasBlock, { type: "diff" }> }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-card/50 sm:col-span-2">
      {block.path ? (
        <div className="border-b border-border/60 px-4 py-1.5 font-mono text-xs text-muted-foreground">
          {block.path}
        </div>
      ) : null}
      <div className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">
        {block.lines.map((line, lineIndex) => (
          <div
            key={lineIndex}
            className={cn(
              "-mx-3 px-3",
              line.type === "add" && "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200/90",
              line.type === "del" && "bg-red-500/10 text-red-800 dark:text-red-200/90",
              line.type === "context" && "text-foreground/75",
            )}
          >
            <span className="select-none whitespace-pre">
              {line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "}
            </span>
            <span className="whitespace-pre-wrap">{line.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CanvasRichBlock({ block }: { block: CanvasRichBlockData }) {
  switch (block.type) {
    case "callout": {
      const tone = CALLOUT_TONES[block.tone];
      const ToneIcon = tone.icon;
      return (
        <div
          className={cn(
            "flex items-start gap-2.5 rounded-xl border p-4 sm:col-span-2",
            tone.containerClassName,
          )}
        >
          <ToneIcon
            className={cn("mt-0.5 size-4 shrink-0", tone.iconClassName)}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            {block.title ? (
              <p className={cn("text-sm font-medium", tone.iconClassName)}>{block.title}</p>
            ) : null}
            <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">
              {block.body}
            </p>
          </div>
        </div>
      );
    }
    case "todo": {
      return (
        <div className="rounded-xl border border-border/70 bg-card/50 p-4 sm:col-span-2">
          {block.title ? <p className="mb-2 text-sm font-medium">{block.title}</p> : null}
          <ul className="space-y-1.5">
            {block.items.map((item, itemIndex) => {
              const ItemIcon = TODO_ITEM_ICONS[item.status];
              return (
                <li key={itemIndex} className="flex items-start gap-2 text-sm text-foreground/85">
                  <ItemIcon
                    className={cn(
                      "mt-0.5 size-3.5 shrink-0",
                      item.status === "done" && "text-emerald-600 dark:text-emerald-300/90",
                      item.status === "in_progress" && "text-info",
                      item.status === "pending" && "text-muted-foreground",
                    )}
                    aria-hidden="true"
                  />
                  <span
                    className={cn(item.status === "done" && "text-muted-foreground line-through")}
                  >
                    {item.text}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      );
    }
    case "code":
      return (
        <div className="overflow-hidden rounded-xl border border-border/70 bg-muted/40 sm:col-span-2">
          {block.language ? (
            <div className="border-b border-border/60 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {block.language}
            </div>
          ) : null}
          <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-foreground/90">
            {block.code}
          </pre>
        </div>
      );
    case "divider":
      return <hr className="border-border/60 sm:col-span-2" />;
    case "badges":
      return (
        <div className="flex flex-wrap gap-1.5 sm:col-span-2">
          {block.items.map((item, itemIndex) => (
            <span
              key={itemIndex}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-xs font-medium",
                TONE_STYLES[item.tone ?? "neutral"].badge,
              )}
            >
              {item.label}
            </span>
          ))}
        </div>
      );
    case "usage":
      return <CanvasUsageBar block={block} />;
    case "chart_bar":
      return <CanvasBarChart block={block} />;
    case "chart_line":
      return <CanvasLineChart block={block} />;
    case "chart_pie":
      return <CanvasPieChart block={block} />;
    case "diff":
      return <CanvasDiffView block={block} />;
    case "disclose":
      return (
        <details className="rounded-xl border border-border/70 bg-card/50 p-4 sm:col-span-2">
          <summary className="cursor-pointer select-none text-sm font-medium">
            {block.summary}
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground/80">
            {block.body}
          </p>
        </details>
      );
  }
}
