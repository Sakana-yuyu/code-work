import { useMemo, useSyncExternalStore } from "react";

import { listEnabledLocalPluginWorkspacePanels } from "./adapters/localPluginWorkspacePanelAdapter";
import { localPluginRuntime, type LocalPluginRuntime } from "./localPluginRuntime";

export interface EnabledLocalPluginWorkspacePanels {
  readonly surfaceIds: ReadonlyArray<string>;
  readonly titlesBySurfaceId: Readonly<Record<string, string>>;
}

export function useEnabledLocalPluginWorkspacePanels(
  runtime: LocalPluginRuntime = localPluginRuntime,
): EnabledLocalPluginWorkspacePanels {
  const snapshot = useSyncExternalStore(
    runtime.registry.subscribe,
    runtime.registry.getSnapshot,
    runtime.registry.getSnapshot,
  );

  return useMemo(() => {
    const panels = listEnabledLocalPluginWorkspacePanels(runtime.registry);
    return {
      surfaceIds: panels.map((panel) => panel.surface.id),
      titlesBySurfaceId: Object.fromEntries(panels.map((panel) => [panel.surface.id, panel.title])),
    };
  }, [runtime, snapshot]);
}
