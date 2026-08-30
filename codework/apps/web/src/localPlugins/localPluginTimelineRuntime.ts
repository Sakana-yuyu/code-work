import type { LocalPluginFailureJournal } from "./localPluginFailureJournal";
import { localPluginRuntime } from "./localPluginRuntime";
import { LocalPluginTimelineJournal } from "./localPluginTimelineJournal";
import {
  BrowserLocalPluginTimelineStorage,
  type LocalPluginTimelineStorage,
} from "./localPluginTimelineStorage";

class VolatileLocalPluginTimelineStorage implements LocalPluginTimelineStorage {
  private value: string | null = null;

  read(): string | null {
    return this.value;
  }

  write(value: string): void {
    this.value = value;
  }
}

function browserStorage(): LocalPluginTimelineStorage {
  if (typeof window === "undefined") return new VolatileLocalPluginTimelineStorage();
  try {
    return new BrowserLocalPluginTimelineStorage(window.localStorage);
  } catch {
    return new VolatileLocalPluginTimelineStorage();
  }
}

export function createLocalPluginTimelineRuntime(input: {
  readonly failures: LocalPluginFailureJournal;
  readonly storage?: LocalPluginTimelineStorage;
  readonly now?: () => number;
  readonly makeId?: (sequence: number) => string;
}): LocalPluginTimelineJournal {
  const now = input.now ?? Date.now;
  const journal = new LocalPluginTimelineJournal({
    storage: input.storage ?? browserStorage(),
    now,
    makeId:
      input.makeId ??
      ((sequence) => `local-plugin-timeline-${now().toString(36)}-${sequence.toString(36)}`),
  });
  try {
    journal.restore();
  } catch (error) {
    input.failures.record({
      pluginId: "local-plugin-timeline",
      phase: "restore",
      contributionKind: "timeline",
      error,
    });
  }
  return journal;
}

export const localPluginTimelineJournal = createLocalPluginTimelineRuntime({
  failures: localPluginRuntime.failures,
});
