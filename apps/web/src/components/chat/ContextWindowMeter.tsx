import { Button } from "../ui/button";
import {
  type AccountQuotaSnapshot,
  type ContextWindowSnapshot,
  formatContextWindowTokens,
} from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { formatContextWindowCompactionMessage } from "./ContextWindowMeter.logic";
import { Minimize2Icon } from "lucide-react";
import { t } from "~/i18n";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot | null;
  accountQuota?: AccountQuotaSnapshot | null;
  modelDisplayName?: string | null;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
}) {
  const {
    usage,
    accountQuota,
    modelDisplayName,
    onCompact,
    compactDisabled,
    compactDisabledReason,
  } = props;
  const usedPercentage = formatPercentage(usage?.usedPercentage ?? null);
  const normalizedPercentage = Math.max(0, Math.min(100, usage?.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const totalProcessedTokens = usage?.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded
    ? "var(--color-error)"
    : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";
  const triggerValue = usage
    ? (usedPercentage ?? formatContextWindowTokens(usage.usedTokens))
    : "pending";

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={onCompact ? 150 : 0}
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="size-7 rounded-full text-muted-foreground hover:bg-muted/45 hover:text-foreground data-pressed:text-foreground"
            data-context-window-meter="true"
            aria-label={
              usage && usage.maxTokens !== null && usedPercentage
                ? t("contextWindowUsed", { usedPercentage: usedPercentage })
                : usage
                  ? t("contextWindowTokensUsed", {
                      value1: formatContextWindowTokens(usage.usedTokens),
                    })
                  : t("contextWindowNotAvailable")
            }
          >
            <span
              className="relative flex size-4 items-center justify-center"
              data-context-window-value={triggerValue}
            >
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted-foreground) 32%, transparent)"
                  strokeWidth="2.5"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={usageColor}
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
          </Button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="p-0"
        className="w-56 max-w-[calc(100vw-1rem)] rounded-xl border border-border/70 bg-popover/95 text-left whitespace-normal shadow-xl"
      >
        <div className="flex flex-col gap-2.5 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="font-semibold text-foreground text-xs">{t("contextWindow")}</div>
            {usage && usage.maxTokens !== null && usedPercentage ? (
              <div className="text-secondary-label text-[11px] tabular-nums">
                <span>{usedPercentage}</span>
                <span className="mx-1">·</span>
                <span>
                  {formatContextWindowTokens(usage.usedTokens)}/
                  {formatContextWindowTokens(usage.maxTokens ?? null)}
                </span>
              </div>
            ) : (
              <div className="text-secondary-label text-[11px] tabular-nums">
                {usage
                  ? formatContextWindowTokens(usage.usedTokens)
                  : t("contextWindowNotAvailable")}
              </div>
            )}
          </div>
          {usage && usage.maxTokens !== null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label={t("contextWindowUsage")}
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
              <span className="text-secondary-label">{t("chat.totalProcessed")}</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usage?.compactsAutomatically ? (
            <div className="mt-1 text-pretty text-secondary-label text-[11px] font-medium">
              {formatContextWindowCompactionMessage(modelDisplayName, usage.autoCompactThreshold)}
            </div>
          ) : null}
          {accountQuota ? (
            <div className="mt-1 border-t border-border/60 pt-2">
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                {t("accountQuota")}
              </div>
              {accountQuota.unlimited ? (
                <div className="text-[11px] text-secondary-label">{t("accountQuotaUnlimited")}</div>
              ) : null}
              {accountQuota.balance !== null ? (
                <div className="text-[11px] tabular-nums text-secondary-label">
                  {t("accountQuotaBalance", {
                    value1: `${accountQuota.balance.toLocaleString()}${accountQuota.currency ? ` ${accountQuota.currency}` : ""}`,
                  })}
                </div>
              ) : null}
              {accountQuota.windows.map((window) => (
                <div
                  key={window.label}
                  className="flex items-center justify-between gap-3 text-[11px]"
                >
                  <span className="text-secondary-label">{window.label}</span>
                  <span className="tabular-nums text-secondary-label">
                    {window.usedPercentage !== null
                      ? `${formatPercentage(window.usedPercentage)} ${t("accountQuotaUsedSuffix")}`
                      : window.remaining !== null
                        ? t("accountQuotaRemaining", { value1: window.remaining.toLocaleString() })
                        : "—"}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {onCompact ? (
            <>
              <Button
                size="xs"
                variant="outline"
                className="mt-1 w-full justify-center"
                disabled={compactDisabled}
                onClick={onCompact}
              >
                <Minimize2Icon aria-hidden="true" />
                {t("compactContext")}
              </Button>
              {compactDisabled && compactDisabledReason ? (
                <div className="text-pretty text-secondary-label text-[11px]">
                  {compactDisabledReason}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
