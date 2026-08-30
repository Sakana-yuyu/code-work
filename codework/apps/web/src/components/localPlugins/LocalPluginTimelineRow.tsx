import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

import { t } from "~/i18n";
import type { EnabledLocalPluginTimelineEntry } from "~/localPlugins/adapters/localPluginTimelineAdapter";
import type { LocalPluginFailureJournal } from "~/localPlugins/localPluginFailureJournal";
import { localPluginRuntime } from "~/localPlugins/localPluginRuntime";
import { cn } from "~/lib/utils";

const TONE_PRESENTATION = {
  info: { icon: InfoIcon, className: "border-info/40 text-info" },
  success: { icon: CircleCheckIcon, className: "border-success/40 text-success" },
  warning: { icon: TriangleAlertIcon, className: "border-warning/40 text-warning" },
  error: { icon: CircleAlertIcon, className: "border-destructive/40 text-destructive" },
} as const;

export function recordLocalPluginTimelineRenderFailure(input: {
  readonly failures: LocalPluginFailureJournal;
  readonly entry: EnabledLocalPluginTimelineEntry;
  readonly error: unknown;
}): void {
  input.failures.record({
    pluginId: input.entry.pluginId,
    phase: "render",
    contributionKind: "timeline",
    contributionId: input.entry.contributionId,
    error: input.error,
  });
}

class LocalPluginTimelineRowBoundary extends Component<
  {
    readonly entry: EnabledLocalPluginTimelineEntry;
    readonly failures: LocalPluginFailureJournal;
    readonly children: ReactNode;
  },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo): void {
    recordLocalPluginTimelineRenderFailure({
      failures: this.props.failures,
      entry: this.props.entry,
      error,
    });
  }

  override render() {
    if (this.state.failed) {
      return (
        <div
          className="px-1 py-2 text-destructive text-sm"
          data-local-plugin-timeline-state="failed"
        >
          {t("localPlugins.timelineUnavailable")}
        </div>
      );
    }
    return this.props.children;
  }
}

export function LocalPluginTimelineRow(props: {
  readonly entry: EnabledLocalPluginTimelineEntry;
  readonly failures?: LocalPluginFailureJournal;
}) {
  const presentation = TONE_PRESENTATION[props.entry.tone];
  const Icon = presentation.icon;
  return (
    <LocalPluginTimelineRowBoundary
      entry={props.entry}
      failures={props.failures ?? localPluginRuntime.failures}
    >
      <div
        className={cn(
          "mx-1 flex min-w-0 items-start gap-2.5 border-l-2 px-3 py-2",
          presentation.className,
        )}
        data-local-plugin-timeline-state="ready"
        data-local-plugin-timeline-tone={props.entry.tone}
      >
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <p className="font-medium text-foreground text-sm">{props.entry.title}</p>
            <p className="truncate text-muted-foreground text-[11px]">{props.entry.pluginName}</p>
          </div>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-foreground/80 text-sm leading-relaxed">
            {props.entry.message}
          </p>
        </div>
      </div>
    </LocalPluginTimelineRowBoundary>
  );
}
