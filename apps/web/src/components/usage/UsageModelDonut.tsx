import { useState, type CSSProperties } from "react";

import type { ModelTotals } from "@codework/shared/usageMerge";
import { formatPercent, formatTokens } from "@codework/shared/usageFormat";
import { modelShareSlices } from "@codework/shared/usageStats";

import { t } from "../../i18n";
import { modelColor, OTHER_MODELS_COLOR } from "./usageProviders";

const VIEW_SIZE = 168;
const CENTER = VIEW_SIZE / 2;
const RADIUS = 60;
const STROKE_WIDTH = 22;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** Visual gap between slices, in path length units. */
const SLICE_GAP = 2.5;

const MAX_SLICES = 5;

/**
 * Token share per model for the selected window: the heaviest models as donut
 * slices with the total in the middle, the tail collapsed into one quiet
 * "other" entry so the list never grows unbounded.
 */
interface DonutArc {
  readonly key: string;
  readonly color: string;
  readonly label: string;
  readonly share: number;
}

export function UsageModelDonut({ models }: { readonly models: readonly ModelTotals[] }) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const activeKey = hoveredKey ?? focusedKey;
  const { slices, otherTokens, otherShare } = modelShareSlices(models, MAX_SLICES);
  const totalTokens = slices.reduce((sum, slice) => sum + slice.totalTokens, otherTokens);

  const arcs: readonly DonutArc[] = [
    ...slices.map((slice, index) => ({
      key: slice.key,
      color: modelColor(index),
      label: slice.model,
      share: slice.share,
    })),
    ...(otherTokens > 0
      ? [
          {
            key: "other",
            color: OTHER_MODELS_COLOR,
            label: t("usage.otherModels"),
            share: otherShare,
          },
        ]
      : []),
  ];

  let consumed = 0;

  return (
    <div
      className="usage-model-donut-shell flex flex-col items-center gap-8 md:flex-row"
      data-hovered={activeKey === null ? "false" : "true"}
    >
      <div className="relative shrink-0" style={{ width: VIEW_SIZE, height: VIEW_SIZE }}>
        <svg
          aria-label={t("usage.modelUsage")}
          className="usage-model-donut"
          height={VIEW_SIZE}
          role="group"
          viewBox={`0 0 ${VIEW_SIZE} ${VIEW_SIZE}`}
          width={VIEW_SIZE}
        >
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="none"
            stroke="var(--muted)"
            strokeWidth={STROKE_WIDTH}
          />
          {arcs.map(({ key, color, label, share }, index) => {
            const length = Math.max(0, share * CIRCUMFERENCE - SLICE_GAP);
            const offset = consumed;
            consumed += share * CIRCUMFERENCE;
            if (length <= 0) return null;
            return (
              <circle
                aria-label={`${label}: ${formatPercent(share)}`}
                key={key}
                cx={CENTER}
                cy={CENTER}
                r={RADIUS}
                fill="none"
                className="usage-donut-segment"
                data-active={activeKey === key ? "true" : "false"}
                data-muted={activeKey !== null && activeKey !== key ? "true" : "false"}
                focusable="true"
                onBlur={() => setFocusedKey(null)}
                onFocus={() => setFocusedKey(key)}
                onMouseEnter={() => setHoveredKey(key)}
                onMouseLeave={() => setHoveredKey(null)}
                role="img"
                stroke={color}
                strokeWidth={STROKE_WIDTH}
                strokeDasharray="var(--usage-donut-length) var(--usage-donut-gap)"
                strokeDashoffset={-offset}
                style={
                  {
                    "--usage-donut-circumference": CIRCUMFERENCE,
                    "--usage-donut-delay": `${index * 45}ms`,
                    "--usage-donut-gap": CIRCUMFERENCE - length,
                    "--usage-donut-length": length,
                  } as CSSProperties
                }
                tabIndex={0}
                transform={`rotate(-90 ${CENTER} ${CENTER})`}
              />
            );
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-semibold text-foreground tabular-nums">
            {formatTokens(totalTokens)}
          </span>
          <span className="text-xs text-muted-foreground">{t("tokens")}</span>
        </div>
      </div>

      <ul className="flex w-full min-w-0 flex-col">
        {slices.map((slice, index) => (
          <li
            key={slice.key}
            className="usage-donut-legend border-b border-border/50 py-2"
            data-active={activeKey === slice.key ? "true" : "false"}
            data-muted={activeKey !== null && activeKey !== slice.key ? "true" : "false"}
            onMouseEnter={() => setHoveredKey(slice.key)}
            onMouseLeave={() => setHoveredKey(null)}
          >
            <div className="flex items-baseline justify-between gap-4">
              <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: modelColor(index) }}
                />
                <span className="truncate">{slice.model}</span>
              </span>
              <span className="shrink-0 text-sm font-medium text-foreground tabular-nums">
                {formatPercent(slice.share)}
              </span>
            </div>
            <span className="ml-4 block text-xs text-muted-foreground">
              {formatTokens(slice.totalTokens)} {t("tokens")}
            </span>
          </li>
        ))}
        {otherTokens > 0 ? (
          <li
            className="usage-donut-legend py-2"
            data-active={activeKey === "other" ? "true" : "false"}
            data-muted={activeKey !== null && activeKey !== "other" ? "true" : "false"}
            onMouseEnter={() => setHoveredKey("other")}
            onMouseLeave={() => setHoveredKey(null)}
          >
            <div className="flex items-baseline justify-between gap-4">
              <span className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: OTHER_MODELS_COLOR }}
                />
                {t("usage.otherModels")}
              </span>
              <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
                {formatPercent(otherShare)}
              </span>
            </div>
            <span className="ml-4 block text-xs text-muted-foreground">
              {formatTokens(otherTokens)} {t("tokens")}
            </span>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
