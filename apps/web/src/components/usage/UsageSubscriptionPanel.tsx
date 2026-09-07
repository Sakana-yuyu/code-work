/**
 * 第一方订阅额度面板（Codex/Claude 的 5h/7d 滚动窗口）。
 *
 * 数据来自 provider CLI 自己推送的限额事件（`server.getAccountQuota`），
 * CLI 没跑过回合就还没有数据——此时安静地不渲染，避免给非订阅用户常驻
 * 一块空卡片。窗口条的颜色语义与 BYOK 余额窗口一致。
 *
 * @module usage/UsageSubscriptionPanel
 */
import type { AccountQuotaWindow } from "@codework/contracts";
import { RefreshCwIcon } from "lucide-react";

import { formatDateTimeShort, formatPercent } from "@codework/shared/usageFormat";
import { t, useResolvedLanguage } from "../../i18n";
import { formatRelativeTimeLabel, formatRelativeTimeUntilLabel } from "../../timestampFormat";
import { useAccountQuota } from "../../state/accountQuota";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PROVIDER_PRESENTATION, type UsageProviderPresentation } from "./usageProviders";

const USAGE_CARD_CLASS =
  "rounded-2xl border border-border/70 bg-card p-4 shadow-[0_1px_1px_rgb(0_0_0/0.03),0_8px_30px_rgb(0_0_0/0.035)] sm:p-5";

// 与 UsagePlanView 的余额窗口条同一套语义色。
const QUOTA_BAR_CLASSES: Readonly<Record<AccountQuotaWindow["status"], string>> = {
  ok: "bg-emerald-500",
  warning: "bg-amber-500",
  exhausted: "bg-red-500",
  unknown: "bg-muted-foreground/50",
};

// 数字只在非健康状态着色，ok 保持安静的中性。
const QUOTA_VALUE_CLASSES: Readonly<Record<AccountQuotaWindow["status"], string>> = {
  ok: "text-foreground",
  warning: "text-amber-500",
  exhausted: "text-red-500",
  unknown: "text-muted-foreground",
};

function windowLabel(window: AccountQuotaWindow): string {
  switch (window.id) {
    case "primary":
    case "five_hour":
      return t("usageAccountQuota.window.fiveHours");
    case "secondary":
    case "seven_day":
      return t("usageAccountQuota.window.sevenDays");
    default:
      return window.label;
  }
}

function providerPresentation(provider: string): UsageProviderPresentation | undefined {
  // 驱动 kind 与用量统计的 provider 口径差一个 Agent 后缀（claudeAgent）。
  const key = provider.replace(/Agent$/i, "");
  return (PROVIDER_PRESENTATION as Record<string, UsageProviderPresentation>)[key];
}

/** planType 的原始 slug（self_serve_business_prolite）读起来像错误，展开后首字母大写。 */
function planLabel(planName: string): string {
  const expanded = planName.replaceAll("_", " ").trim();
  if (expanded.length === 0) return planName;
  return expanded.charAt(0).toUpperCase() + expanded.slice(1);
}

function QuotaWindowRow({ window }: { readonly window: AccountQuotaWindow }) {
  const language = useResolvedLanguage();
  const percent =
    window.usedFraction === undefined
      ? null
      : Math.min(100, Math.max(0, window.usedFraction * 100));
  const resetsInFuture =
    window.resetsAt !== undefined && new Date(window.resetsAt).getTime() > Date.now();
  const resetsLabel =
    window.resetsAt === undefined
      ? null
      : resetsInFuture
        ? formatRelativeTimeUntilLabel(window.resetsAt)
        : null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-xs text-muted-foreground">{windowLabel(window)}</span>
        <span
          className={`shrink-0 text-sm font-semibold tabular-nums ${QUOTA_VALUE_CLASSES[window.status]}`}
        >
          {percent === null
            ? t("usageAccountQuota.unknown")
            : `${formatPercent(percent / 100, 0)} ${t("accountQuotaUsedSuffix")}`}
        </span>
      </div>
      {percent === null ? null : (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full ${QUOTA_BAR_CLASSES[window.status]}`}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      {window.resetsAt !== undefined ? (
        <Tooltip>
          <TooltipTrigger render={<span className="w-fit text-[10px] text-muted-foreground" />}>
            {t("usageAccountQuota.resetsAt", {
              value1:
                (resetsLabel !== null && resetsLabel !== "" ? resetsLabel : null) ??
                formatDateTimeShort(window.resetsAt, undefined, language),
            })}
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-60 whitespace-nowrap">
            {formatDateTimeShort(window.resetsAt, undefined, language)}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}

export function UsageSubscriptionPanel() {
  const language = useResolvedLanguage();
  const quota = useAccountQuota();

  if (quota.isPending || !quota.hasData) {
    return null;
  }

  return (
    <section className={`${USAGE_CARD_CLASS} flex flex-col gap-4`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium text-foreground">{t("usageAccountQuota.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("usageAccountQuota.description")}</p>
        </div>
        <Button
          aria-label={t("usageAccountQuota.refresh")}
          size="icon-sm"
          variant="ghost"
          onClick={quota.refresh}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {quota.providers.map((provider) => {
          const presentation = providerPresentation(provider.provider);
          const Mark = presentation?.mark;
          const updatedAtIso = new Date(provider.updatedAtUnixMs).toISOString();
          return (
            <div
              key={`${provider.environmentId}:${provider.provider}`}
              className="flex flex-col gap-3 rounded-xl border border-border/50 bg-background/60 p-3.5"
            >
              <div className="flex items-center gap-2">
                {Mark ? <Mark className="size-3.5" /> : null}
                <span className="truncate text-[13px] font-medium text-foreground">
                  {presentation?.label ?? provider.provider}
                </span>
                {provider.planName !== undefined ? (
                  <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {planLabel(provider.planName)}
                  </span>
                ) : null}
                {quota.environmentsCount > 1 ? (
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                    {provider.environmentLabel}
                  </span>
                ) : null}
              </div>
              {provider.windows.map((window) => (
                <QuotaWindowRow key={window.id} window={window} />
              ))}
              <Tooltip>
                <TooltipTrigger
                  render={<span className="w-fit text-[10px] text-muted-foreground" />}
                >
                  {t("usageAccountQuota.updatedAt", {
                    value1:
                      formatRelativeTimeLabel(updatedAtIso) ||
                      formatDateTimeShort(updatedAtIso, undefined, language),
                  })}
                </TooltipTrigger>
                <TooltipPopup side="top" className="max-w-60 whitespace-nowrap">
                  {formatDateTimeShort(updatedAtIso, undefined, language)}
                </TooltipPopup>
              </Tooltip>
            </div>
          );
        })}
      </div>
    </section>
  );
}
