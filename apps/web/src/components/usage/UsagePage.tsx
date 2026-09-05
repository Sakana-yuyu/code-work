import type { UsageProviderKind } from "@codework/contracts";
import { CheckIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import type { DailyTotals, HourlyTotals } from "@codework/shared/usageMerge";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { CompositionControlCenterPanel } from "../settings/CompositionControlCenterPanel";
import { TaskGraphPanel } from "../settings/TaskGraphPanel";
import {
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatDateTimeShort,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  formatUsd,
  makeWindow,
} from "@codework/shared/usageFormat";
import { computeActivityStats, rankModelsByTokens } from "@codework/shared/usageStats";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { UsageActivityHeatmap } from "./UsageActivityHeatmap";
import { UsageModelDonut } from "./UsageModelDonut";
import { UsageModelTrendChart, type UsageModelSeries } from "./UsageModelTrendChart";
import { UsagePlanView } from "./UsagePlanView";
import { UsageProviderChart, type UsageChartMetric } from "./UsageProviderChart";
import { useByokBalanceDashboards } from "../../state/byokBalance";
import { t, useResolvedLanguage } from "../../i18n";
import {
  modelColor,
  PROVIDER_ORDER,
  PROVIDER_PRESENTATION,
  providersWithUsage,
} from "./usageProviders";

const WINDOW_OPTIONS = [
  { days: 1, label: "usage.past24h" },
  { days: 7, label: "usage.past7Days" },
  { days: 30, label: "usage.past30Days" },
  { days: 90, label: "usage.past90Days" },
] as const;

/** How far back the activity calendar and lifetime-style stats reach. */
const ACTIVITY_WINDOW_DAYS = 365;
/** Series shown in the daily trend; the donut keeps its own, shorter cut. */
const TREND_SERIES_COUNT = 6;
const USAGE_CARD_CLASS =
  "rounded-2xl border border-border/70 bg-card p-4 shadow-[0_1px_1px_rgb(0_0_0/0.03),0_8px_30px_rgb(0_0_0/0.035)] sm:p-5";

export function UsagePage() {
  const language = useResolvedLanguage();
  const [view, setView] = useState<"app" | "plan" | "tasks">("app");
  const [windowSelection, setWindowSelection] = useState(() => ({
    days: 30,
    window: makeWindow(30),
  }));
  const [metric, setMetric] = useState<UsageChartMetric>("cost");
  const [breakdown, setBreakdown] = useState<"model" | "time">("model");
  const { days: windowDays, window } = windowSelection;
  const isPast24Hours = windowDays === 1;
  const { merged, environments, isPending, isPartial, refresh } = useUsage(window);

  // The activity calendar reaches further than the selectable windows: one
  // year-long query feeds the lifetime-style strip and the heatmap. Atoms are
  // keyed per window, so this query is shared with nothing else on the page.
  const activityWindow = useMemo(() => makeWindow(ACTIVITY_WINDOW_DAYS), []);
  const activity = useUsage(activityWindow);
  // Plan balances come from every connected environment, not just the
  // primary one: worktree servers resolve the same BYOK config, so the merge
  // claims each (instance, adapter) pair once.
  const byok = useByokBalanceDashboards();
  const activityDays = useMemo(
    () => enumerateDays(activityWindow.sinceDay, activityWindow.untilDay),
    [activityWindow.sinceDay, activityWindow.untilDay],
  );
  const activityTokensByDay = useMemo(
    () => new Map(activity.merged.daily.map((entry) => [entry.day, entry.totalTokens])),
    [activity.merged.daily],
  );
  const activityDailyByDay = useMemo(
    () => new Map(activity.merged.daily.map((entry) => [entry.day, entry])),
    [activity.merged.daily],
  );
  const activityStats = useMemo(
    () => computeActivityStats(activityDays, activityTokensByDay, activityWindow.untilDay),
    [activityDays, activityTokensByDay, activityWindow.untilDay],
  );
  // Every environment failed to answer: zeros would read as "no usage ever".
  const activityUnavailable =
    activity.environments.length > 0 &&
    activity.environments.every((entry) => entry.error !== null);
  const activitySettling = activity.isPending || activity.isPartial;

  // Hold the content until every environment is terminal. Rendering merged
  // totals while devices are still answering makes every number on the page
  // jump as each one lands.
  const settling = isPending || isPartial;

  const days = useMemo(
    () => enumerateDays(window.sinceDay, window.untilDay),
    [window.sinceDay, window.untilDay],
  );
  const hours = useMemo(
    () =>
      window.sinceTime === undefined || window.untilTime === undefined
        ? []
        : enumerateHourStarts(window.sinceTime, window.untilTime),
    [window.sinceTime, window.untilTime],
  );
  // Newest first: the window can run 90 periods, so the interesting end
  // belongs at the top of the table.
  const breakdownPeriods = useMemo<readonly (DailyTotals | HourlyTotals)[]>(
    () => (isPast24Hours ? merged.hourly : merged.daily).toReversed(),
    [isPast24Hours, merged.daily, merged.hourly],
  );
  const breakdownModels = useMemo(
    () =>
      breakdown === "model" && metric === "tokens"
        ? merged.models.toSorted(
            (left, right) => right.totalTokens - left.totalTokens || right.costUsd - left.costUsd,
          )
        : merged.models,
    [breakdown, merged.models, metric],
  );
  const activeProviders = useMemo(() => providersWithUsage(merged.providers), [merged.providers]);
  const timeValueColumnWidth = `${60 / (activeProviders.length + 2)}%`;
  // Colors follow token rank so a model reads as the same color in the trend
  // chart and the donut.
  const trendSeries = useMemo<readonly UsageModelSeries[]>(() => {
    const ranked = rankModelsByTokens(merged.models);
    return ranked.slice(0, TREND_SERIES_COUNT).map((entry, index) => ({
      key: entry.key,
      label: entry.model,
      color: modelColor(index),
    }));
  }, [merged.models]);

  // Activity strip + heatmap settle on their own year-long query, so they can
  // appear while the selected-window sections still wait on slow devices.
  const activityModules =
    activityUnavailable || activity.environments.length === 0 ? null : activitySettling ? (
      <ActivitySkeleton />
    ) : (
      <div className={cn(USAGE_CARD_CLASS, "flex flex-col gap-4")}>
        <section className="grid grid-cols-1 gap-x-6 gap-y-4 py-1 min-[400px]:grid-cols-2 md:grid-cols-5">
          <Metric
            labelKey="usage.cumulativeTokens"
            value={formatTokens(activity.merged.totalTokens)}
          />
          <Metric labelKey="usage.peakTokens" value={formatTokens(activityStats.peakDayTokens)} />
          <Metric labelKey="usage.activeDays" value={formatCount(activityStats.activeDays)} />
          <Metric
            labelKey="usage.currentStreak"
            value={t("usage.dayCount", { count: activityStats.currentStreak })}
          />
          <Metric
            labelKey="usage.longestStreak"
            value={t("usage.dayCount", { count: activityStats.longestStreak })}
          />
        </section>

        <div className="border-t border-border/60 pt-4">
          <UsageActivityHeatmap days={activityDays} dailyByDay={activityDailyByDay} />
        </div>
      </div>
    );

  const selectWindow = (days: number) => {
    setWindowSelection({
      days,
      window: makeWindow(days, undefined, days === 1 ? "hour" : "day"),
    });
  };
  const refreshWindow = () => {
    const nextWindow = makeWindow(windowDays, undefined, isPast24Hours ? "hour" : "day");
    activity.refresh();
    byok.refresh();
    if (
      nextWindow.sinceDay === window.sinceDay &&
      nextWindow.untilDay === window.untilDay &&
      nextWindow.sinceTime === window.sinceTime &&
      nextWindow.untilTime === window.untilTime
    ) {
      refresh();
    } else {
      setWindowSelection({ days: windowDays, window: nextWindow });
    }
  };
  const viewTabs = (
    <ToggleGroup
      className="shrink-0"
      aria-label={t("usage.view")}
      variant="segmented"
      value={[view]}
      onValueChange={(next) => {
        const value = next[0];
        if (value === "app" || value === "plan" || value === "tasks") setView(value);
      }}
    >
      <Toggle value="app">{t("usage.appTab")}</Toggle>
      <Toggle value="plan">{t("usage.planTab")}</Toggle>
      <Toggle value="tasks">{t("usage.tasksTab")}</Toggle>
    </ToggleGroup>
  );
  const windowLabel =
    isPast24Hours && window.sinceTime !== undefined && window.untilTime !== undefined
      ? t("usage.instantRange", {
          start: formatDateTimeShort(window.sinceTime, window.timeZone, language),
          end: formatDateTimeShort(window.untilTime, window.timeZone, language),
        })
      : t("usage.dayRange", {
          start: formatDayShort(window.sinceDay, language),
          end: formatDayShort(window.untilDay, language),
        });
  const topbarContent = (
    <div className="flex w-full min-w-0 items-center gap-3 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <WorkspaceBreadcrumb ariaLabel={t("usageBreadcrumb")} className="shrink-0">
        <WorkspaceBreadcrumbItem className="shrink-0" current>
          <h1 className="whitespace-nowrap">{t("usage")}</h1>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      {viewTabs}
      <div className="ms-auto hidden shrink-0 items-center justify-end gap-2 xl:flex">
        {view === "app" ? (
          <>
            <ToggleGroup
              aria-label={t("usageMetric")}
              variant="segmented"
              value={[metric]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "cost" || value === "tokens") setMetric(value);
              }}
            >
              {(["cost", "tokens"] as const).map((option) => (
                <Toggle key={option} value={option}>
                  {option === "cost" ? t("cost") : t("tokens")}
                </Toggle>
              ))}
            </ToggleGroup>
            <ToggleGroup
              aria-label={t("usagePeriod")}
              variant="segmented"
              value={[String(windowDays)]}
              onValueChange={(next) => {
                const value = next[0];
                if (value) selectWindow(Number(value));
              }}
            >
              {WINDOW_OPTIONS.map((option) => (
                <Toggle key={option.days} value={String(option.days)}>
                  {t(option.label)}
                </Toggle>
              ))}
            </ToggleGroup>
          </>
        ) : null}
        <Button
          onClick={refreshWindow}
          aria-label={t("refreshUsage")}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
      <div className="ms-auto flex shrink-0 items-center justify-end gap-1 xl:hidden">
        {view === "app" ? (
          <>
            <Select
              value={metric}
              onValueChange={(value) => {
                if (value === "cost" || value === "tokens") setMetric(value);
              }}
            >
              <SelectTrigger
                aria-label={t("usageMetric")}
                size="compact"
                variant="ghost"
                className="w-auto min-w-0"
              >
                <SelectValue>{metric === "cost" ? t("cost") : t("tokens")}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="cost">{t("cost")}</SelectItem>
                <SelectItem value="tokens">{t("tokens")}</SelectItem>
              </SelectPopup>
            </Select>
            <Select
              value={String(windowDays)}
              onValueChange={(value) => selectWindow(Number(value))}
            >
              <SelectTrigger
                aria-label={t("usagePeriod")}
                size="compact"
                variant="ghost"
                className="w-auto min-w-0"
              >
                <SelectValue>
                  {t(WINDOW_OPTIONS.find((option) => option.days === windowDays)?.label ?? "")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {WINDOW_OPTIONS.map((option) => (
                  <SelectItem key={option.days} value={String(option.days)}>
                    {t(option.label)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </>
        ) : null}
        <Button
          onClick={refreshWindow}
          aria-label={t("refreshUsage")}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>{topbarContent}</WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {view === "plan" ? (
              activitySettling ? (
                <ActivitySkeleton />
              ) : (
                <UsagePlanView
                  providers={activity.merged.providers}
                  daily={activity.merged.daily}
                  days={activityDays}
                  untilDay={activityWindow.untilDay}
                  byokEnvironments={byok.environments}
                  byok={byok.merged}
                  byokPending={byok.isPending}
                  onQueryBalance={byok.queryBalance}
                />
              )
            ) : view === "tasks" ? (
              <div className="flex min-w-0 flex-col gap-6">
                <TaskGraphPanel />
                <CompositionControlCenterPanel />
              </div>
            ) : (
              <>
                <p className="w-fit rounded-lg border border-border/60 bg-card/50 px-3 py-1.5 text-[13px] leading-[1.4] text-muted-foreground">
                  {windowLabel}
                </p>
                {settling ? (
                  <>
                    {environments.length > 1 ? (
                      <UsageDeviceStrip environments={environments} />
                    ) : null}
                    {activityModules}
                    <UsageSkeleton />
                  </>
                ) : (
                  <>
                    <UsageCoverageNotice
                      environments={environments}
                      duplicateSources={merged.duplicateSources}
                      staleEnvironments={merged.staleEnvironments}
                    />

                    {activityModules}
                    <section
                      className={cn(
                        USAGE_CARD_CLASS,
                        "grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]",
                      )}
                    >
                      <div className="flex min-w-0 flex-col gap-5">
                        <div className="flex flex-col gap-1">
                          <span className="text-4xl font-semibold text-foreground tabular-nums">
                            {metric === "cost"
                              ? formatUsd(merged.costUsd)
                              : formatTokens(merged.totalTokens)}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {metric === "cost"
                              ? t("sessionsApiEstimate", { value1: formatCount(merged.sessions) })
                              : t("sessions", { value1: formatCount(merged.sessions) })}
                          </span>
                        </div>

                        {activeProviders.map((provider) => {
                          const totals = merged.providers.find(
                            (entry) => entry.provider === provider,
                          );
                          const share =
                            metric === "cost"
                              ? (totals?.costShare ?? 0)
                              : (totals?.tokenShare ?? 0);
                          const providerSessions = totals?.sessions ?? 0;
                          const sessionLabel = t("usage.sessionCount", {
                            count: providerSessions,
                            countValue: formatCount(providerSessions),
                          });
                          return (
                            <div key={provider} className="flex flex-col gap-1">
                              <div className="flex items-baseline justify-between gap-4">
                                <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                                  <span
                                    aria-hidden
                                    className="size-2 shrink-0 rounded-full"
                                    style={{
                                      backgroundColor: PROVIDER_PRESENTATION[provider].color,
                                    }}
                                  />
                                  <ProviderMark provider={provider} className="size-4" />
                                  <span className="flex min-w-0 items-baseline gap-1.5">
                                    <span className="truncate">
                                      {PROVIDER_PRESENTATION[provider].label}
                                    </span>
                                    <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground tabular-nums">
                                      {sessionLabel}
                                    </span>
                                  </span>
                                </span>
                                <span className="shrink-0 text-sm font-medium text-foreground tabular-nums">
                                  {metric === "cost"
                                    ? formatUsd(totals?.costUsd ?? 0)
                                    : formatTokens(totals?.totalTokens ?? 0)}
                                </span>
                              </div>
                              <span className="text-xs text-muted-foreground">
                                {metric === "cost"
                                  ? t("ofCostTokens", {
                                      value1: formatPercent(share),
                                      value2: formatTokens(totals?.totalTokens ?? 0),
                                    })
                                  : t("ofTokens", {
                                      value1: formatPercent(share),
                                      value2: formatUsd(totals?.costUsd ?? 0),
                                    })}
                              </span>
                            </div>
                          );
                        })}
                      </div>

                      <div className="flex min-w-0 flex-col gap-3 lg:border-l lg:border-border/60 lg:pl-6">
                        <h2 className="text-sm font-medium text-foreground">
                          {isPast24Hours ? t("hourly") : t("daily")}{" "}
                          {metric === "tokens" ? t("processedTokens") : t("cost2")}
                        </h2>
                        <UsageProviderChart
                          providers={activeProviders}
                          days={days}
                          daily={merged.daily}
                          hours={hours}
                          hourly={merged.hourly}
                          metric={metric}
                          referenceTime={window.untilTime}
                          resolution={isPast24Hours ? "hour" : "day"}
                          timeZone={window.timeZone}
                        />
                      </div>
                    </section>

                    {!isPast24Hours && trendSeries.length > 0 ? (
                      <section className={cn(USAGE_CARD_CLASS, "flex flex-col gap-3")}>
                        <h2 className="text-sm font-medium text-foreground">
                          {t("usage.modelTrend")}
                        </h2>
                        <UsageModelTrendChart
                          models={trendSeries}
                          days={days}
                          daily={merged.daily}
                        />
                      </section>
                    ) : null}

                    {merged.models.length > 0 ? (
                      <section className={cn(USAGE_CARD_CLASS, "flex flex-col gap-3")}>
                        <h2 className="text-sm font-medium text-foreground">
                          {t("usage.modelUsage")}
                        </h2>
                        <UsageModelDonut models={merged.models} />
                      </section>
                    ) : null}

                    <section className={cn(USAGE_CARD_CLASS, "flex flex-col gap-2")}>
                      <h2 className="text-sm font-medium text-foreground">{t("totals")}</h2>
                      <div className="grid grid-cols-1 gap-x-6 gap-y-4 py-1 min-[400px]:grid-cols-2 md:grid-cols-5">
                        <Metric
                          labelKey="processedTokens2"
                          value={formatTokens(merged.totalTokens)}
                        />
                        <Metric
                          labelKey="cachedInput"
                          value={formatTokens(merged.cachedInputTokens)}
                        />
                        <Metric
                          labelKey="uncachedInput"
                          value={formatTokens(merged.uncachedInputTokens)}
                        />
                        <Metric labelKey="output" value={formatTokens(merged.outputTokens)} />
                        <Metric
                          labelKey="cacheSavings"
                          value={formatUsd(merged.costQuality.cacheSavingsUsd)}
                        />
                      </div>
                    </section>

                    <section className={cn(USAGE_CARD_CLASS, "flex flex-col gap-3")}>
                      <div className="flex items-center justify-between gap-3">
                        <h2 className="text-sm font-medium text-foreground">{t("breakdown")}</h2>
                        <ToggleGroup
                          aria-label={t("usageBreakdown")}
                          variant="segmented"
                          value={[breakdown]}
                          onValueChange={(next) => {
                            const value = next[0];
                            if (value === "model" || value === "time") setBreakdown(value);
                          }}
                        >
                          {(["model", "time"] as const).map((option) => (
                            <Toggle key={option} value={option}>
                              {option === "model"
                                ? t("model")
                                : isPast24Hours
                                  ? t("hour")
                                  : t("day")}
                            </Toggle>
                          ))}
                        </ToggleGroup>
                      </div>

                      <div className="overflow-x-auto rounded-xl border border-border/60 bg-background/30 px-3">
                        {breakdown === "model" ? (
                          <table className="min-w-[36rem] w-full table-fixed text-sm">
                            <colgroup>
                              <col className="w-2/5" />
                              <col className="w-1/5" />
                              <col className="w-1/5" />
                              <col className="w-1/5" />
                            </colgroup>
                            <thead>
                              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                                <th className="py-2 font-normal">{t("model")}</th>
                                <th className="py-2 text-right font-normal">{t("cost")}</th>
                                <th className="py-2 text-right font-normal">{t("share")}</th>
                                <th className="py-2 text-right font-normal">{t("tokens")}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {breakdownModels.length === 0 ? (
                                <tr>
                                  <td
                                    colSpan={4}
                                    className="py-6 text-center text-muted-foreground"
                                  >
                                    {t("noActivityInThisWindow")}
                                  </td>
                                </tr>
                              ) : (
                                breakdownModels.map((model) => (
                                  <tr
                                    key={`${model.provider}:${model.model}`}
                                    className="border-b border-border/50 transition-colors hover:bg-muted/50"
                                  >
                                    <td className="py-2 text-foreground">
                                      <span className="flex items-center gap-2">
                                        <ProviderMark
                                          provider={model.provider}
                                          className="size-3.5"
                                        />
                                        {model.model}
                                      </span>
                                    </td>
                                    <td className="py-2 text-right text-foreground tabular-nums">
                                      {formatUsd(model.costUsd)}
                                    </td>
                                    <td className="py-2 text-right text-muted-foreground tabular-nums">
                                      {formatPercent(model.costShare)}
                                    </td>
                                    <td className="py-2 text-right text-muted-foreground tabular-nums">
                                      {formatTokens(model.totalTokens)}
                                    </td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        ) : (
                          <table className="min-w-[36rem] w-full table-fixed text-sm">
                            <colgroup>
                              <col className="w-2/5" />
                              {activeProviders.map((provider) => (
                                <col key={provider} style={{ width: timeValueColumnWidth }} />
                              ))}
                              <col style={{ width: timeValueColumnWidth }} />
                              <col style={{ width: timeValueColumnWidth }} />
                            </colgroup>
                            <thead>
                              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                                <th className="py-2 font-normal">
                                  {isPast24Hours ? t("hour") : t("day")}
                                </th>
                                {activeProviders.map((provider) => (
                                  <th key={provider} className="py-2 text-right font-normal">
                                    {PROVIDER_PRESENTATION[provider].label}
                                  </th>
                                ))}
                                <th className="py-2 text-right font-normal">{t("total")}</th>
                                <th className="py-2 text-right font-normal">{t("tokens")}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {breakdownPeriods.length === 0 ? (
                                <tr>
                                  <td
                                    colSpan={activeProviders.length + 3}
                                    className="py-6 text-center text-muted-foreground"
                                  >
                                    {t("noActivityInThisWindow")}
                                  </td>
                                </tr>
                              ) : (
                                breakdownPeriods.map((period) => (
                                  <tr
                                    key={"hourStart" in period ? period.hourStart : period.day}
                                    className="border-b border-border/50 transition-colors hover:bg-muted/50"
                                  >
                                    <td className="py-2 text-foreground">
                                      {"hourStart" in period
                                        ? formatHourShort(period.hourStart, window.timeZone)
                                        : formatDayShort(period.day, language)}
                                    </td>
                                    {activeProviders.map((provider) => (
                                      <td
                                        key={provider}
                                        className="py-2 text-right text-muted-foreground tabular-nums"
                                      >
                                        {formatUsd(period.byProvider.get(provider)?.costUsd ?? 0)}
                                      </td>
                                    ))}
                                    <td className="py-2 text-right text-foreground tabular-nums">
                                      {formatUsd(period.costUsd)}
                                    </td>
                                    <td className="py-2 text-right text-muted-foreground tabular-nums">
                                      {formatTokens(period.totalTokens)}
                                    </td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </section>
                  </>
                )}
              </>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

/** Brand mark for the harness a row belongs to. */
function ProviderMark({
  provider,
  className,
}: {
  readonly provider: UsageProviderKind;
  readonly className: string;
}) {
  const Mark = PROVIDER_PRESENTATION[provider].mark;
  return <Mark className={cn("shrink-0", className)} aria-hidden />;
}

function Metric({ labelKey, value }: { readonly labelKey: string; readonly value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{t(labelKey)}</span>
      <span className="text-base font-medium text-foreground tabular-nums">{value}</span>
    </div>
  );
}

/**
 * Says plainly when the totals are incomplete: an environment that failed, or
 * one whose transcripts another environment already reported. Environments
 * that are still answering never reach this notice; the page shows the
 * loading skeleton until every one is terminal.
 */
function UsageCoverageNotice({
  environments,
  duplicateSources,
  staleEnvironments,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly duplicateSources: readonly string[];
  readonly staleEnvironments: readonly string[];
}) {
  const failed = environments.filter((environment) => environment.error !== null);
  const stale = environments.filter((environment) =>
    staleEnvironments.includes(environment.environmentId),
  );
  if (failed.length === 0 && stale.length === 0 && duplicateSources.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border/70 bg-card px-3 py-2 text-xs text-muted-foreground shadow-sm/5">
      {failed.map((environment) => (
        <span key={environment.label}>
          {environment.label} {t("couldNotReportUsage")}
        </span>
      ))}
      {stale.map((environment) => (
        <span key={environment.label}>
          {environment.label} {t("runsAnOlderServerVersionAndIsExcludedFromTotals")}
        </span>
      ))}
      {duplicateSources.length > 0 ? (
        <span>
          {t("countedOnceAcrossEnvironmentsSharingATranscriptDirectory")}{" "}
          {duplicateSources.join(", ")}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Per-device progress while the page waits for every environment to answer.
 * Only rendered with two or more devices; a lone device has nothing to
 * enumerate.
 */
function UsageDeviceStrip({
  environments,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
}) {
  const scanning = environments.filter(
    (environment) => environment.summary === null && environment.error === null,
  );
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-xl border border-border/70 bg-card px-3 py-2 text-xs shadow-sm/5">
      {environments.map((environment) => {
        if (environment.summary !== null) {
          return (
            <span
              key={environment.environmentId}
              className="flex items-center gap-1 text-foreground"
            >
              <CheckIcon className="size-3 text-emerald-600 dark:text-emerald-300/90" aria-hidden />
              {environment.label}
            </span>
          );
        }
        if (environment.error !== null) {
          return (
            <span
              key={environment.environmentId}
              className="flex items-center gap-1 text-destructive"
            >
              <XIcon className="size-3" aria-hidden />
              {environment.label}
            </span>
          );
        }
        return (
          <span
            key={environment.environmentId}
            className="animate-status-pulse text-muted-foreground"
          >
            {environment.label}…
          </span>
        );
      })}
      <span className="ms-auto text-muted-foreground">
        {scanning.length === 1
          ? t("m1DeviceStillScanning")
          : t("devicesStillScanning", { value1: scanning.length })}
      </span>
    </div>
  );
}

/**
 * Static stand-in for the activity strip and heatmap while the year-long query
 * is still answering. No shimmer; blocks fill in exactly once.
 */
function ActivitySkeleton() {
  return (
    <div className={cn(USAGE_CARD_CLASS, "flex flex-col gap-4")}>
      <section className="grid grid-cols-1 gap-x-6 gap-y-4 py-1 min-[400px]:grid-cols-2 md:grid-cols-5">
        {[
          "usage.cumulativeTokens",
          "usage.peakTokens",
          "usage.activeDays",
          "usage.currentStreak",
          "usage.longestStreak",
        ].map((labelKey) => (
          <div key={labelKey} className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">{t(labelKey)}</span>
            <div className="h-6 w-16 rounded-sm bg-muted" />
          </div>
        ))}
      </section>
      <div className="border-t border-border/60 pt-4">
        <section className="flex flex-col gap-3">
          <div className="h-5 w-24 rounded-sm bg-muted" />
          <div className="rounded-xl border border-border/60 bg-background/30 p-3">
            <div className="h-24 rounded-sm bg-muted/35" />
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * Static stand-in with the loaded page's shape. No shimmer; blocks fill in
 * exactly once when the last device answers.
 */
function UsageSkeleton() {
  return (
    <>
      <section
        className={cn(USAGE_CARD_CLASS, "grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]")}
      >
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <div className="h-10 w-36 rounded-sm bg-muted" />
            <div className="h-4 w-32 rounded-sm bg-muted" />
          </div>
          {PROVIDER_ORDER.map((provider) => (
            <div key={provider} className="flex flex-col gap-1">
              <div className="flex min-h-5 items-center justify-between gap-4">
                <span className="flex items-center gap-2">
                  <span className="size-2 shrink-0 rounded-full bg-muted" />
                  <span className="size-4 shrink-0 rounded-full bg-muted" />
                  <div className="h-3.5 w-20 rounded-sm bg-muted" />
                </span>
                <div className="h-3.5 w-14 rounded-sm bg-muted" />
              </div>
              <div className="h-4 w-36 rounded-sm bg-muted" />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <div className="h-5 w-24 rounded-sm bg-muted" />
          <div className="flex flex-col gap-1">
            <div className="ml-16 h-56 rounded-sm bg-muted/35" />
            <div className="ml-16 h-4 rounded-sm bg-muted/35" />
          </div>
        </div>
      </section>

      <section className={cn(USAGE_CARD_CLASS, "flex flex-col gap-2")}>
        <h2 className="text-sm font-medium text-foreground">{t("totals")}</h2>
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 py-1 min-[400px]:grid-cols-2 md:grid-cols-5">
          {["processedTokens2", "cachedInput", "uncachedInput", "output", "cacheSavings"].map(
            (labelKey) => (
              <div key={labelKey} className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">{t(labelKey)}</span>
                <div className="h-6 w-16 rounded-sm bg-muted" />
              </div>
            ),
          )}
        </div>
      </section>

      <section className={cn(USAGE_CARD_CLASS, "flex flex-col gap-3")}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">{t("breakdown")}</h2>
          <div className="h-7 w-28 rounded-lg bg-input/40" />
        </div>
        <div className="rounded-xl border border-border/60 bg-background/30 p-3">
          <div className="h-44 rounded-sm bg-muted/35" />
        </div>
      </section>
    </>
  );
}
