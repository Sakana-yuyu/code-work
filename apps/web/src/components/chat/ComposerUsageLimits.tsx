/**
 * The `/usage-limits` result as a composer notice. Code Work answers the
 * command locally from the merged subscription quota (`server.getAccountQuota`)
 * — the agent never sees it, and nothing it reports spends quota itself.
 *
 * @module chat/ComposerUsageLimits
 */
import type { EnvironmentId, AccountQuotaWindow } from "@codework/contracts";
import { GaugeIcon } from "lucide-react";

import {
  externalUsageLinkForProvider,
  quotaWindowRemainingPercent,
  type MergedAccountQuotaProvider,
} from "@codework/shared/accountQuotaMerge";
import { formatDateTimeShort } from "@codework/shared/usageFormat";
import { t, useResolvedLanguage } from "../../i18n";
import { formatRelativeTimeUntilLabel } from "../../timestampFormat";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

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

const WINDOW_BAR_CLASSES: Readonly<Record<AccountQuotaWindow["status"], string>> = {
  ok: "bg-emerald-500",
  warning: "bg-amber-500",
  exhausted: "bg-red-500",
  unknown: "bg-muted-foreground/50",
};

function QuotaWindowLine({ window }: { readonly window: AccountQuotaWindow }) {
  const language = useResolvedLanguage();
  const remaining = quotaWindowRemainingPercent(window);
  const resetsInFuture =
    window.resetsAt !== undefined && new Date(window.resetsAt).getTime() > Date.now();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-xs text-muted-foreground">{windowLabel(window)}</span>
        <span className="shrink-0 text-xs tabular-nums text-foreground">
          {remaining === null
            ? t("usageAccountQuota.unknown")
            : `${remaining}% ${t("usageAccountQuota.leftSuffix")}`}
          {window.resetsAt !== undefined && resetsInFuture
            ? ` · ${formatRelativeTimeUntilLabel(window.resetsAt)}`
            : window.resetsAt !== undefined
              ? ` · ${formatDateTimeShort(window.resetsAt, undefined, language)}`
              : ""}
        </span>
      </div>
      {remaining === null ? null : (
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full ${WINDOW_BAR_CLASSES[window.status]}`}
            style={{ width: `${remaining}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function usageLimitsBannerItem(input: {
  readonly id: string;
  readonly providers: readonly MergedAccountQuotaProvider[];
  readonly environmentsCount: number;
  readonly instanceLabel: (
    environmentId: EnvironmentId,
    instanceId: string | undefined,
  ) => string | undefined;
  readonly onDismiss: () => void;
}): ComposerBannerStackItem {
  const { providers } = input;
  const accountCounts = new Map<string, number>();
  for (const provider of providers) {
    accountCounts.set(provider.provider, (accountCounts.get(provider.provider) ?? 0) + 1);
  }
  return {
    id: input.id,
    variant: "info",
    icon: <GaugeIcon />,
    title: t("usageLimits.commandTitle"),
    dismissLabel: t("usageLimits.dismiss"),
    onDismiss: input.onDismiss,
    description: (
      <div className="flex min-w-0 flex-col gap-2.5 pt-1">
        {providers.map((provider) => {
          const instanceLabel = input.instanceLabel(
            provider.environmentId,
            provider.providerInstanceId,
          );
          const externalUsage = externalUsageLinkForProvider(provider.provider);
          return (
            <div
              key={`${provider.provider}:${provider.providerInstanceId ?? ""}`}
              className="flex min-w-0 flex-col gap-1.5"
            >
              {providers.length > 1 ? (
                <span className="truncate text-xs font-medium text-muted-foreground">
                  {provider.provider}
                  {instanceLabel !== undefined && (accountCounts.get(provider.provider) ?? 0) > 1
                    ? ` · ${instanceLabel}`
                    : ""}
                  {provider.planName !== undefined ? ` · ${provider.planName}` : ""}
                  {input.environmentsCount > 1 ? ` · ${provider.environmentLabel}` : ""}
                </span>
              ) : null}
              {provider.windows.map((window) => (
                <QuotaWindowLine key={window.id} window={window} />
              ))}
              {externalUsage === null ? null : (
                <a
                  className="w-fit text-[10px] text-muted-foreground underline-offset-2 hover:underline"
                  href={externalUsage.url}
                  rel="noreferrer"
                  target="_blank"
                >
                  {externalUsage.label} ↗
                </a>
              )}
            </div>
          );
        })}
      </div>
    ),
  };
}
