import { RefreshCwIcon } from "lucide-react";

import { formatCount, formatDateTimeShort, formatTokens } from "@codework/shared/usageFormat";

import { t, useResolvedLanguage } from "../../i18n";
import { cn } from "../../lib/utils";
import { useLocalPoolUsage } from "../../state/localPoolUsage";
import { Button } from "../ui/button";

const USAGE_CARD_CLASS =
  "rounded-2xl border border-border/70 bg-card p-4 shadow-[0_1px_1px_rgb(0_0_0/0.03),0_8px_30px_rgb(0_0_0/0.035)] sm:p-5";

const PROVIDER_LABELS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  xai: "Grok",
};

/**
 * 本地账号池的按账号调用统计。没有任何账号池活动的环境（含未绑定账号池的
 * 远程环境）不渲染对应区块，页面保持只有真实有数据的卡片。
 */
export function UsageLocalPoolPanel() {
  const language = useResolvedLanguage();
  const { environments, refresh } = useLocalPoolUsage();
  const visible = environments.filter((entry) => entry.usage.length > 0 || entry.isPending);
  if (visible.length === 0) return null;
  return (
    <section className={cn(USAGE_CARD_CLASS, "flex flex-col gap-3")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{t("usage.poolUsage.title")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("usage.poolUsage.hint")}</p>
        </div>
        <Button size="icon-sm" variant="ghost" aria-label={t("refreshUsage")} onClick={refresh}>
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
      {visible.map((environment) => (
        <div
          key={environment.environmentId}
          className="flex min-w-0 flex-col gap-2 rounded-xl border border-border/50 p-3"
        >
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="truncate font-medium">{environment.label}</span>
            {environment.isPending ? <span>{t("usage.poolUsage.loading")}</span> : null}
          </div>
          <div className="flex flex-col gap-1.5">
            {environment.usage.map((entry) => (
              <div key={entry.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {entry.id}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {PROVIDER_LABELS[entry.provider] ?? entry.provider}
                </span>
                <span className="shrink-0 tabular-nums">
                  {t("usage.poolUsage.requests", { countValue: formatCount(entry.requests) })}
                </span>
                {entry.failed > 0 ? (
                  <span className="shrink-0 tabular-nums text-destructive">
                    {t("usage.poolUsage.failed", { countValue: formatCount(entry.failed) })}
                  </span>
                ) : null}
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {t("usage.poolUsage.tokens", {
                    input: formatTokens(entry.inputTokens),
                    output: formatTokens(entry.outputTokens),
                  })}
                </span>
                {entry.lastUsedAt !== null ? (
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {formatDateTimeShort(entry.lastUsedAt, undefined, language)}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
