import type {
  ByokBalanceAdapterHealth,
  ByokBalanceResult,
  ByokBalanceWindow,
  UsageProviderKind,
} from "@codework/contracts";
import { useMemo, useState } from "react";
import { LoaderIcon } from "lucide-react";

import type { DailyTotals, ProviderTotals } from "@codework/shared/usageMerge";
import { formatCount, formatDateTimeShort, formatTokens } from "@codework/shared/usageFormat";
import { computeActivityStats } from "@codework/shared/usageStats";
import type { MergedByokAdapter, MergedByokPlans } from "@codework/shared/byokBalanceMerge";

import { t, useResolvedLanguage } from "../../i18n";
import type { ByokBalanceQueryTarget } from "../../state/byokBalance";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { PROVIDER_PRESENTATION, providersWithUsage } from "./usageProviders";

const ADAPTER_HEALTH_LABEL_KEYS: Readonly<Record<ByokBalanceAdapterHealth, string>> = {
  ok: "byokBalance.health.ok",
  empty: "byokBalance.health.empty",
  unsupported: "byokBalance.health.unsupported",
  error: "byokBalance.health.error",
};

const WINDOW_BAR_CLASSES: Readonly<Record<ByokBalanceWindow["status"], string>> = {
  ok: "bg-emerald-500",
  warning: "bg-amber-500",
  exhausted: "bg-red-500",
  unknown: "bg-muted-foreground/50",
};

export interface UsagePlanByokStatus {
  readonly label: string;
  readonly error: string | null;
}

interface UsagePlanViewProps {
  /** Lifetime provider totals (year-long window merge). */
  readonly providers: readonly ProviderTotals[];
  /** Lifetime daily totals, carrying per-provider series. */
  readonly daily: readonly DailyTotals[];
  readonly days: readonly string[];
  readonly untilDay: string;
  readonly byokEnvironments: readonly UsagePlanByokStatus[];
  readonly byok: MergedByokPlans;
  readonly byokPending: boolean;
  /** One user-initiated balance query for an (environment, instance, adapter). */
  readonly onQueryBalance?: ((target: ByokBalanceQueryTarget) => Promise<unknown>) | undefined;
}

/**
 * The 个人套餐 view: every plan the user pays for, in one place. Subscription
 * providers (Claude Code, Codex, Grok) get activity cards derived from the
 * same transcript scan as the app-usage tab; BYOK suppliers get their balance
 * dashboards, merged across every connected environment so a fleet reports
 * once instead of per device.
 */
export function UsagePlanView({
  providers,
  daily,
  days,
  untilDay,
  byokEnvironments,
  byok,
  byokPending,
  onQueryBalance,
}: UsagePlanViewProps) {
  const [queryingKeys, setQueryingKeys] = useState<ReadonlySet<string>>(() => new Set());

  const handleQueryBalance = (target: ByokBalanceQueryTarget, queryKey: string) => {
    if (onQueryBalance === undefined) return;
    setQueryingKeys((previous) => new Set(previous).add(queryKey));
    void onQueryBalance(target).finally(() => {
      setQueryingKeys((previous) => {
        if (!previous.has(queryKey)) return previous;
        const next = new Set(previous);
        next.delete(queryKey);
        return next;
      });
    });
  };

  const activeProviders = useMemo(() => {
    // providersWithUsage decides which providers count as active and in which
    // reading order; the page renders the matching totals rows.
    const active = new Set(providersWithUsage(providers));
    return providers.filter((entry) => active.has(entry.provider));
  }, [providers]);

  const providerStats = useMemo(() => {
    const stats = new Map<UsageProviderKind, ReturnType<typeof computeActivityStats>>();
    const tokensByProviderDay = new Map<UsageProviderKind, Map<string, number>>();
    for (const day of daily) {
      for (const [provider, totals] of day.byProvider) {
        const tokensByDay = tokensByProviderDay.get(provider) ?? new Map<string, number>();
        tokensByDay.set(day.day, totals.totalTokens);
        tokensByProviderDay.set(provider, tokensByDay);
      }
    }
    for (const entry of activeProviders) {
      const tokensByDay = tokensByProviderDay.get(entry.provider) ?? new Map<string, number>();
      stats.set(entry.provider, computeActivityStats(days, tokensByDay, untilDay));
    }
    return stats;
  }, [activeProviders, daily, days, untilDay]);

  const failedEnvironments = byokEnvironments.filter((entry) => entry.error !== null);
  const instanceCount = new Set(byok.adapters.map((adapter) => adapter.instanceId)).size;
  const instanceGroups = useMemo(() => {
    const groups = new Map<string, MergedByokAdapter[]>();
    for (const adapter of byok.adapters) {
      const group = groups.get(adapter.instanceId) ?? [];
      group.push(adapter);
      groups.set(adapter.instanceId, group);
    }
    // Second level: adapters sharing a relay endpoint (base URL) share one
    // balance — they collapse into a single queryable plan row.
    return [...groups.entries()].map(([instanceId, adapters]) => {
      const byBaseURL = new Map<string, MergedByokAdapter[]>();
      for (const adapter of adapters) {
        const key = adapter.baseURL || adapter.adapterId;
        const relayGroup = byBaseURL.get(key) ?? [];
        relayGroup.push(adapter);
        byBaseURL.set(key, relayGroup);
      }
      return [instanceId, [...byBaseURL.values()]] as const;
    });
  }, [byok.adapters]);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-foreground">{t("usage.subscriptionUsage")}</h2>
        {activeProviders.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">{t("noActivityInThisWindow")}</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {activeProviders.map((entry) => {
              const presentation = PROVIDER_PRESENTATION[entry.provider];
              const Mark = presentation.mark;
              const stats = providerStats.get(entry.provider);
              return (
                <div key={entry.provider} className="rounded-lg border border-border p-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
                      <Mark className="size-4 shrink-0" aria-hidden />
                      <span className="truncate">{presentation.label}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {t("sessions", { value1: formatCount(entry.sessions) })}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 min-[400px]:grid-cols-2">
                    <Stat
                      label={t("usage.cumulativeTokens")}
                      value={formatTokens(entry.totalTokens)}
                    />
                    <Stat
                      label={t("usage.activeDays")}
                      value={formatCount(stats?.activeDays ?? 0)}
                    />
                    <Stat
                      label={t("usage.currentStreak")}
                      value={t("usage.dayCount", { count: stats?.currentStreak ?? 0 })}
                    />
                    <Stat
                      label={t("usage.longestStreak")}
                      value={t("usage.dayCount", { count: stats?.longestStreak ?? 0 })}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">{t("usage.byokPlans")}</h2>
          {byok.adapters.length > 0 ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {`${t("byokBalance.instances")}: ${instanceCount}`}
              {` · ${t("byokBalance.health.ok")}: ${byok.okCount}`}
              {` · ${t("byokBalance.health.empty")}: ${byok.emptyCount}`}
              {` · ${t("byokBalance.health.error")}: ${byok.errorCount}`}
            </span>
          ) : null}
        </div>

        {failedEnvironments.map((entry) => (
          <span key={entry.label} className="text-xs text-muted-foreground">
            {entry.label} {t("usage.couldNotReportBalances")}
          </span>
        ))}

        {byok.adapters.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {byokPending ? t("byokBalance.pending") : t("byokBalance.noData")}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {instanceGroups.map(([instanceId, relayGroups]) => (
              <div
                key={instanceId}
                className="rounded-lg border border-border px-4 py-3"
                data-plan-instance-id={instanceId}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {relayGroups[0]?.[0]?.instanceLabel ?? instanceId}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {t("byokBalance.adapters")}:{" "}
                    {relayGroups.reduce((sum, group) => sum + group.length, 0)}
                  </span>
                </div>
                <ul className="mt-2 flex flex-col gap-3">
                  {relayGroups.map((relayAdapters) => {
                    const lead = relayAdapters[0];
                    if (lead === undefined) return null;
                    const queryKey = `${lead.instanceId}:${lead.adapterId}`;
                    const isQuerying = queryingKeys.has(queryKey);
                    const extraCount = relayAdapters.length - 1;
                    return (
                      <li
                        key={lead.baseURL || lead.adapterId}
                        className="flex flex-col gap-2 border-t border-border/50 pt-3 first:border-t-0 first:pt-0"
                        data-plan-balance-group={lead.baseURL || lead.adapterId}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs text-foreground">
                            {lead.adapterLabel}
                            {extraCount > 0 ? (
                              <span className="text-muted-foreground"> +{extraCount}</span>
                            ) : null}
                          </span>
                          <Badge variant={lead.health === "error" ? "destructive" : "outline"}>
                            {t(ADAPTER_HEALTH_LABEL_KEYS[lead.health])}
                          </Badge>
                          {lead.balance.unlimited ? (
                            <Badge variant="secondary">{t("byokBalance.unlimited")}</Badge>
                          ) : null}
                          {lead.balance.planName !== undefined ? (
                            <span className="text-xs text-muted-foreground">
                              {t("byokBalance.plan")}: {lead.balance.planName}
                            </span>
                          ) : null}
                          {onQueryBalance !== undefined && lead.health !== "empty" ? (
                            <Button
                              className="ms-auto"
                              disabled={isQuerying}
                              size="xs"
                              variant="outline"
                              data-plan-balance-query={lead.baseURL || lead.adapterId}
                              onClick={() =>
                                void handleQueryBalance(
                                  {
                                    environmentId: lead.environmentId,
                                    instanceId: lead.instanceId,
                                    adapterId: lead.adapterId,
                                  },
                                  queryKey,
                                )
                              }
                            >
                              {isQuerying ? <LoaderIcon className="animate-spin" /> : null}
                              {isQuerying
                                ? t("byokFeatures.balanceQuerying")
                                : t("byokFeatures.balanceQuery")}
                            </Button>
                          ) : null}
                        </div>

                        {lead.health === "error" ? (
                          <span className="text-xs text-destructive">
                            {lead.balance.error?.message ?? t("byokBalance.health.error")}
                          </span>
                        ) : lead.balance.windows.length > 0 ? (
                          <div className="grid gap-3 md:grid-cols-2">
                            {lead.balance.windows.map((window) => (
                              <BalanceWindow key={window.id} window={window} />
                            ))}
                          </div>
                        ) : (
                          <BalanceTotalsLine
                            adapterLabel={lead.adapterLabel}
                            balance={lead.balance}
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-base font-medium text-foreground tabular-nums">{value}</span>
    </div>
  );
}

function windowUsageText(window: ByokBalanceWindow): string {
  if (window.used !== undefined && window.limit !== undefined) {
    return `${window.used.toFixed(2)} / ${window.limit.toFixed(2)} ${window.unit}`;
  }
  if (window.remaining !== undefined) {
    return `${window.remaining.toFixed(2)} ${window.unit}`;
  }
  return window.unit;
}

function BalanceWindow({ window }: { readonly window: ByokBalanceWindow }) {
  const language = useResolvedLanguage();
  const fraction =
    window.usedFraction ??
    (window.limit !== undefined && window.limit > 0 && window.used !== undefined
      ? window.used / window.limit
      : null);
  const percent = fraction === null ? null : Math.min(100, Math.max(0, fraction * 100));

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-xs text-muted-foreground">{window.label}</span>
        <span className="shrink-0 text-xs text-foreground tabular-nums">
          {windowUsageText(window)}
        </span>
      </div>
      {percent === null ? null : (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full ${WINDOW_BAR_CLASSES[window.status]}`}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      {window.resetsAt !== undefined ? (
        <span className="text-[10px] text-muted-foreground">
          {t("byokBalance.resets")}: {formatDateTimeShort(window.resetsAt, undefined, language)}
        </span>
      ) : null}
    </div>
  );
}

function BalanceTotalsLine({
  adapterLabel,
  balance,
}: {
  readonly adapterLabel: string;
  readonly balance: ByokBalanceResult;
}) {
  const parts: string[] = [];
  if (balance.remaining !== undefined) {
    parts.push(
      `${t("byokBalance.remaining")}: ${balance.remaining.toFixed(2)} ${balance.currency}`,
    );
  }
  if (balance.used !== undefined) {
    parts.push(`${t("byokBalance.used")}: ${balance.used.toFixed(2)}`);
  }
  if (balance.total !== undefined) {
    parts.push(`${t("byokBalance.total")}: ${balance.total.toFixed(2)}`);
  }
  return (
    <span className="text-xs text-muted-foreground">
      {parts.length > 0 ? parts.join(" · ") : `${adapterLabel}: ${balance.message}`}
    </span>
  );
}
