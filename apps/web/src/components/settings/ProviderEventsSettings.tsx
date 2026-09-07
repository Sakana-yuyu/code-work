import { RefreshCwIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { EnvironmentId, ProviderEventQueryStream } from "@codework/contracts";
import { ThreadId } from "@codework/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentThreadRefs, useThreadShells } from "../../state/entities";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";
import { t } from "~/i18n";

const STREAM_OPTIONS: ReadonlyArray<{ value: ProviderEventQueryStream | "all"; label: string }> = [
  { value: "all", label: "providerEvents.stream.all" },
  { value: "canonical", label: "providerEvents.stream.canonical" },
  { value: "native", label: "providerEvents.stream.native" },
  { value: "orchestration", label: "providerEvents.stream.orchestration" },
];

const STREAM_BADGE_CLASS: Record<ProviderEventQueryStream, string> = {
  canonical: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  native: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  orchestration: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
};

/**
 * Provider 事件日志查看器（Request Lab 底座）：按线程读取服务端落盘的
 * provider 事件，脱敏后只读展示。诊断用途，无任何写路径或重放入口。
 */
export function ProviderEventsSettings({ environmentId }: { environmentId: EnvironmentId | null }) {
  const threadRefs = useEnvironmentThreadRefs(environmentId);
  const threadShells = useThreadShells();
  const [threadIdInput, setThreadIdInput] = useState("");
  const [streamFilter, setStreamFilter] = useState<ProviderEventQueryStream | "all">("all");

  const titleByThreadId = useMemo(() => {
    const titles = new Map<string, string>();
    for (const shell of threadShells) {
      if (shell.environmentId !== environmentId) continue;
      titles.set(shell.id, shell.title);
    }
    return titles;
  }, [threadShells, environmentId]);

  const queryInput = useMemo(() => {
    const trimmed = threadIdInput.trim();
    if (trimmed.length === 0) return null;
    return {
      threadId: ThreadId.make(trimmed),
      ...(streamFilter === "all" ? {} : { stream: streamFilter }),
      limit: 100,
    } as const;
  }, [threadIdInput, streamFilter]);

  const { data, error, isPending, refresh } = useEnvironmentQuery(
    environmentId === null || queryInput === null
      ? null
      : serverEnvironment.providerEvents({ environmentId, input: queryInput }),
  );

  const refreshEvents = useCallback(() => {
    void refresh();
  }, [refresh]);

  const events = data?.events ?? [];

  return (
    <SettingsSection
      title={t("providerEvents.title")}
      headerAction={
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={t("providerEvents.refresh")}
          disabled={environmentId === null || queryInput === null || isPending}
          onClick={refreshEvents}
        >
          <RefreshCwIcon />
        </Button>
      }
    >
      <div className="flex flex-col gap-3 text-xs text-muted-foreground">
        <p>{t("providerEvents.description")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={t("providerEvents.thread")}
            className="h-8 min-w-0 max-w-[320px] flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            value={threadIdInput}
            onChange={(event) => setThreadIdInput(event.target.value)}
          >
            <option value="">{t("providerEvents.pickThread")}</option>
            {threadRefs.map((ref) => (
              <option key={`${ref.environmentId}:${ref.threadId}`} value={ref.threadId}>
                {titleByThreadId.get(ref.threadId) ?? ref.threadId}
              </option>
            ))}
          </select>
          <select
            aria-label={t("providerEvents.streamLabel")}
            className="h-8 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            value={streamFilter}
            onChange={(event) =>
              setStreamFilter(event.target.value as ProviderEventQueryStream | "all")
            }
          >
            {STREAM_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.label)}
              </option>
            ))}
          </select>
        </div>
        {error !== null ? (
          <p className="text-destructive">{t("providerEvents.loadFailed")}</p>
        ) : null}
        {data !== null && data.truncated ? <p>{t("providerEvents.truncated")}</p> : null}
        {events.length > 0 ? (
          <ul className="divide-y divide-border/60 rounded-md border border-border/70">
            {events.map((entry) => (
              <li
                key={
                  entry.eventId ??
                  `${entry.stream}:${entry.loggedAt ?? ""}:${entry.type ?? ""}:${entry.requestId ?? ""}`
                }
                className="min-w-0"
              >
                <details className="px-3 py-2">
                  <summary className="flex cursor-pointer list-none items-center gap-2 overflow-hidden">
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${STREAM_BADGE_CLASS[entry.stream]}`}
                    >
                      {entry.stream}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground/80">
                      {entry.loggedAt ?? "—"}
                    </span>
                    <span className="min-w-0 truncate text-foreground/90">
                      {entry.type ?? t("providerEvents.unknownType")}
                    </span>
                  </summary>
                  <pre className="mt-2 max-h-72 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-relaxed">
                    {JSON.stringify(entry.event, null, 2)}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-md border border-dashed border-border/70 px-3 py-6 text-center">
            {queryInput === null
              ? t("providerEvents.pickThreadHint")
              : isPending
                ? t("providerEvents.loading")
                : t("providerEvents.empty")}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
