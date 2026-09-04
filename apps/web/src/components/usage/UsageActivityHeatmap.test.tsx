import type { DailyTotals } from "@codework/shared/usageMerge";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../i18n", () => ({
  t: (key: string) =>
    ({
      daily: "Daily",
      "usage.viewWeekly": "Weekly",
      "usage.viewCumulative": "Cumulative",
      "usage.tokenActivity": "Token activity",
      noActivityInThisWindow: "No activity",
      tokens: "Tokens",
      cost: "Cost",
      providers: "Providers",
      models: "Models",
    })[key] ?? key,
  useResolvedLanguage: () => "en-US",
}));
vi.mock("../ui/toggle-group", () => ({
  Toggle: ({ children }: { readonly children: ReactNode }) => <button>{children}</button>,
  ToggleGroup: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { readonly render: ReactNode }) => render,
  TooltipPopup: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

import { UsageActivityHeatmap } from "./UsageActivityHeatmap";

const daily: DailyTotals = {
  day: "2026-08-01",
  costUsd: 1.25,
  totalTokens: 1_000,
  byProvider: new Map([["codex", { costUsd: 1.25, totalTokens: 1_000 }]]),
  byModel: new Map([["codex gpt-5.6-sol", 1_000]]),
};

describe("UsageActivityHeatmap", () => {
  it("fills the available grid and exposes date and usage details", () => {
    const days = [
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
    ];
    const markup = renderToStaticMarkup(
      <UsageActivityHeatmap days={days} dailyByDay={new Map([[daily.day, daily]])} />,
    );

    expect(markup).toContain("grid-template-columns:repeat(2, minmax(10px, 1fr))");
    expect(markup).toContain("min-width:23px");
    expect(markup).toContain("Aug 1, 2026");
    expect(markup).toContain("Tokens: 1K");
    expect(markup).toContain("Cost: $1.25");
    expect(markup).toContain("Providers: 1");
    expect(markup).toContain("Models: 1");
    expect(markup).toContain("rounded-xl border border-border/60 bg-background/30");
    expect(markup).toContain("ring-1 ring-inset ring-border/40");
  });
});
