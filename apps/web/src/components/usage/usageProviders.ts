import type { UsageProviderKind } from "@codework/contracts";

import { ClaudeAI, GrokIcon, type Icon, OpenAI } from "../Icons";
import { t } from "~/i18n/runtime";

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly mark: Icon;
};

/**
 * Exhaustive presentation for providers supported by the usage contract.
 * Declaration order is reused by every chart and table, so adding a provider
 * only requires its contract support and one entry here.
 */
export const PROVIDER_PRESENTATION = {
  codex: {
    get label() {
      return t("codex");
    },
    color: "var(--contrast-foreground)",
    mark: OpenAI,
  },
  claude: {
    get label() {
      return t("claudeCode");
    },
    color: "#d97757",
    mark: ClaudeAI,
  },
  grok: {
    get label() {
      return t("grok");
    },
    // Contrast-aware neutral between the Codex series and muted chart chrome.
    color: "color-mix(in oklab, var(--contrast-foreground) 72%, var(--background))",
    mark: GrokIcon,
  },
} satisfies Record<UsageProviderKind, UsageProviderPresentation>;

/** Stable provider reading order across charts, summaries, tables, and hover rows. */
export const PROVIDER_ORDER = Object.keys(PROVIDER_PRESENTATION) as UsageProviderKind[];

/**
 * Categorical palette for per-model series, indexed by token-volume rank so a
 * model keeps its color across the trend chart and the donut.
 */
const MODEL_COLOR_PALETTE = [
  "#3b82f6",
  "#22c55e",
  "#a855f7",
  "#ef4444",
  "#f97316",
  "#14b8a6",
  "#eab308",
  "#ec4899",
] as const;

/** The collapsed tail of the model donut, kept visually quiet. */
export const OTHER_MODELS_COLOR =
  "color-mix(in oklab, var(--contrast-foreground) 40%, var(--background))";

export function modelColor(rank: number): string {
  return MODEL_COLOR_PALETTE[rank % MODEL_COLOR_PALETTE.length] ?? OTHER_MODELS_COLOR;
}

/** Providers with real activity, independent of the metric currently displayed. */
export function providersWithUsage(
  totals: readonly {
    readonly provider: UsageProviderKind;
    readonly costUsd: number;
    readonly totalTokens: number;
  }[],
): readonly UsageProviderKind[] {
  const active = new Set(
    totals
      .filter((entry) => entry.totalTokens > 0 || entry.costUsd > 0)
      .map((entry) => entry.provider),
  );
  return PROVIDER_ORDER.filter((provider) => active.has(provider));
}
