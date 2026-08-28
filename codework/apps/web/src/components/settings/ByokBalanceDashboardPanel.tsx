import type {
  ByokBalanceAdapterHealth,
  ByokBalanceDashboardAdapter,
  ByokBalanceDashboardResult,
  ByokBalanceInstanceHealth,
} from "@codework/contracts";
import { RefreshCwIcon } from "lucide-react";

import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { t } from "~/i18n";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";

const ADAPTER_HEALTH_LABEL_KEYS: Readonly<Record<ByokBalanceAdapterHealth, string>> = {
  ok: "byokBalance.health.ok",
  empty: "byokBalance.health.empty",
  unsupported: "byokBalance.health.unsupported",
  error: "byokBalance.health.error",
};

const INSTANCE_HEALTH_LABEL_KEYS: Readonly<Record<ByokBalanceInstanceHealth, string>> = {
  ok: "byokBalance.health.ok",
  degraded: "byokBalance.health.degraded",
  failed: "byokBalance.health.failed",
  unsupported: "byokBalance.health.unsupported",
  empty: "byokBalance.health.noAdapters",
};

/**
 * One-line balance summary for an adapter row. Query failures surface the
 * upstream error message (never collapsed into "empty"); exhausted balances
 * and unsupported profiles get their own labels.
 */
export const byokBalanceSummary = (adapter: ByokBalanceDashboardAdapter): string => {
  const balance = adapter.balance;
  if (adapter.health === "error") {
    return balance.error?.message ?? t("byokBalance.health.error");
  }
  if (adapter.health === "unsupported") return t("byokBalance.health.unsupported");
  if (balance.unlimited) return t("byokBalance.unlimited");
  const parts: string[] = [];
  if (balance.remaining !== undefined) {
    parts.push(
      `${t("byokBalance.remaining")}: ${balance.remaining.toFixed(2)} ${balance.currency}`.trim(),
    );
  }
  if (balance.used !== undefined) parts.push(`${t("byokBalance.used")}: ${balance.used.toFixed(2)}`);
  if (balance.total !== undefined) {
    parts.push(`${t("byokBalance.total")}: ${balance.total.toFixed(2)}`);
  }
  if (balance.planName !== undefined) parts.push(`${t("byokBalance.plan")}: ${balance.planName}`);
  return parts.length === 0 ? balance.message : parts.join(" · ");
};

export function ByokBalanceDashboardPanel() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const dashboardQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.byokBalanceDashboard({ environmentId, input: {} }),
  );

  const dashboard: ByokBalanceDashboardResult | null = dashboardQuery.data ?? null;

  return (
    <SettingsSection id="byok-balance-dashboard" title={t("byokBalance.title")}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{t("byokBalance.instances")}</h3>
        <Button
          variant="outline"
          size="sm"
          onClick={() => dashboardQuery.refresh()}
          aria-label={t("byokBalance.refresh")}
        >
          <RefreshCwIcon className="size-3.5" />
          {t("byokBalance.refresh")}
        </Button>
      </div>
      {environmentId === null ? (
        <p className="text-xs text-muted-foreground">{t("byokBalance.noEnvironment")}</p>
      ) : dashboardQuery.isPending ? (
        <p className="text-xs text-muted-foreground">{t("byokBalance.pending")}</p>
      ) : dashboardQuery.error !== null ? (
        <p className="text-xs text-destructive">{t("byokBalance.error")}</p>
      ) : dashboard === null || dashboard.instances.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("byokBalance.noData")}</p>
      ) : (
        <>
          <p className="text-[11px] text-muted-foreground" data-testid="byok-balance-totals">
            {`${t("byokBalance.instances")}: ${dashboard.totals.instanceCount}`}
            {` · ${t("byokBalance.adapters")}: ${dashboard.totals.adapterCount}`}
            {` · ${t("byokBalance.health.ok")}: ${dashboard.totals.okCount}`}
            {` · ${t("byokBalance.health.empty")}: ${dashboard.totals.emptyCount}`}
            {` · ${t("byokBalance.health.error")}: ${dashboard.totals.errorCount}`}
            {` · ${t("byokBalance.health.unsupported")}: ${dashboard.totals.unsupportedCount}`}
          </p>
          <ul className="space-y-2">
            {dashboard.instances.map((instance) => (
              <li
                key={instance.instanceId}
                className="rounded-md border border-border/60 px-3 py-2 text-xs"
                data-balance-instance-id={instance.instanceId}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">
                    {instance.displayName ?? instance.instanceId}
                  </span>
                  <Badge variant="secondary">
                    {t(
                      instance.enabled ? "supplierRegistry.enabled" : "supplierRegistry.disabled",
                    )}
                  </Badge>
                  <Badge
                    variant={
                      instance.health === "ok" || instance.health === "unsupported"
                        ? "outline"
                        : "destructive"
                    }
                    data-testid={`byok-balance-instance-health-${instance.instanceId}`}
                  >
                    {t(INSTANCE_HEALTH_LABEL_KEYS[instance.health])}
                  </Badge>
                </div>
                {instance.adapters.length === 0 ? (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {t("byokBalance.health.noAdapters")}
                  </p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {instance.adapters.map((adapter) => (
                      <li
                        key={adapter.adapterId}
                        className="flex flex-wrap items-center gap-2"
                        data-balance-adapter-id={adapter.adapterId}
                      >
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {adapter.displayName ?? adapter.adapterId}
                        </span>
                        <Badge variant={adapter.health === "error" ? "destructive" : "outline"}>
                          {t(ADAPTER_HEALTH_LABEL_KEYS[adapter.health])}
                        </Badge>
                        <span
                          className={
                            adapter.health === "error"
                              ? "text-[11px] text-destructive"
                              : "text-[11px] text-muted-foreground"
                          }
                        >
                          {byokBalanceSummary(adapter)}
                        </span>
                        {adapter.balance.cached === true ? (
                          <Badge variant="secondary">{t("byokBalance.cached")}</Badge>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </SettingsSection>
  );
}
