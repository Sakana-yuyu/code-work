import { useMemo, useSyncExternalStore } from "react";

import {
  listEnabledLocalPluginTimelineEntries,
  type EnabledLocalPluginTimelineEntry,
} from "./adapters/localPluginTimelineAdapter";
import { localPluginRuntime, type LocalPluginRuntime } from "./localPluginRuntime";
import type { LocalPluginTimelineJournal } from "./localPluginTimelineJournal";
import { localPluginTimelineJournal } from "./localPluginTimelineRuntime";

export function useEnabledLocalPluginTimelineEntries(
  threadKey: string,
  runtime: LocalPluginRuntime = localPluginRuntime,
  journal: LocalPluginTimelineJournal = localPluginTimelineJournal,
): ReadonlyArray<EnabledLocalPluginTimelineEntry> {
  const registrySnapshot = useSyncExternalStore(
    runtime.registry.subscribe,
    runtime.registry.getSnapshot,
    runtime.registry.getSnapshot,
  );
  const timelineSnapshot = useSyncExternalStore(
    journal.subscribe,
    journal.getSnapshot,
    journal.getSnapshot,
  );

  return useMemo(
    () =>
      listEnabledLocalPluginTimelineEntries({
        registry: runtime.registry,
        journal,
        threadKey,
      }),
    [journal, registrySnapshot, runtime.registry, threadKey, timelineSnapshot],
  );
}
