import { AlertTriangle, PanelsTopLeft } from "lucide-react";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { t } from "~/i18n";
import { resolveLocalPluginWorkspacePanel } from "~/localPlugins/adapters/localPluginWorkspacePanelAdapter";
import type { LocalPluginWorkspacePanelSurface } from "~/localPlugins/adapters/localPluginWorkspacePanelSurface";
import { localPluginRuntime, type LocalPluginRuntime } from "~/localPlugins/localPluginRuntime";
import type { LocalPluginWorkspaceContext } from "~/localPlugins/localPluginTemplate";
import { ScrollArea } from "~/components/ui/scroll-area";

export function LocalPluginWorkspacePanel(props: {
  readonly surface: LocalPluginWorkspacePanelSurface;
  readonly workspace: LocalPluginWorkspaceContext | null;
  readonly runtime?: LocalPluginRuntime;
}) {
  const runtime = props.runtime ?? localPluginRuntime;
  const registrySnapshot = useSyncExternalStore(
    runtime.registry.subscribe,
    runtime.registry.getSnapshot,
    runtime.registry.getSnapshot,
  );
  const resolution = useMemo(
    () =>
      resolveLocalPluginWorkspacePanel({
        registry: runtime.registry,
        surface: props.surface,
        workspace: props.workspace,
      }),
    [props.surface, props.workspace, registrySnapshot, runtime.registry],
  );
  const recordedFailureRef = useRef<string | null>(null);

  useEffect(() => {
    if (resolution.ok) {
      recordedFailureRef.current = null;
      return;
    }
    const failureKey = `${props.surface.id}:${resolution.error.message}`;
    if (recordedFailureRef.current === failureKey) return;
    recordedFailureRef.current = failureKey;
    runtime.failures.record({
      pluginId: props.surface.pluginId,
      phase: "render",
      contributionKind: "workspacePanels",
      contributionId: props.surface.contributionId,
      error: resolution.error,
    });
  }, [props.surface, resolution, runtime.failures]);

  if (!resolution.ok) {
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center px-6 py-10"
        data-local-plugin-panel-state="unavailable"
      >
        <div className="max-w-sm text-center">
          <AlertTriangle className="mx-auto size-5 text-warning" />
          <h2 className="mt-3 font-medium text-sm">{t("localPlugins.panelUnavailable")}</h2>
          <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
            {t("localPlugins.panelUnavailableDescription")}
          </p>
        </div>
      </div>
    );
  }

  const panel = resolution.panel;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-local-plugin-panel-state="ready">
      <header className="shrink-0 border-border border-b px-5 py-4">
        <div className="flex items-start gap-3">
          <PanelsTopLeft className="mt-0.5 size-4 shrink-0 text-icon-muted" />
          <div className="min-w-0">
            <h2 className="font-medium text-sm text-foreground">{panel.title}</h2>
            {panel.description ? (
              <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground text-xs leading-relaxed">
                {panel.description}
              </p>
            ) : null}
            <p className="mt-2 text-muted-foreground text-[11px]">
              {panel.pluginName} · {panel.pluginVersion}
            </p>
          </div>
        </div>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="divide-y divide-border">
          {panel.sections.map((section, index) => (
            <section className="px-5 py-4" key={`${index}:${section.heading ?? ""}`}>
              {section.heading ? (
                <h3 className="font-medium text-xs text-foreground">{section.heading}</h3>
              ) : null}
              <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground text-sm leading-relaxed">
                {section.body}
              </p>
            </section>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
