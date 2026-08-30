import { LocalPluginFailureJournal } from "./localPluginFailureJournal";
import { LocalPluginLifecycle } from "./localPluginLifecycle";
import { LocalPluginRegistry } from "./localPluginRegistry";
import { BrowserLocalPluginStorage, type LocalPluginStorage } from "./localPluginStorage";

export interface LocalPluginRuntime {
  readonly failures: LocalPluginFailureJournal;
  readonly lifecycle: LocalPluginLifecycle;
  readonly registry: LocalPluginRegistry;
}

class VolatileLocalPluginStorage implements LocalPluginStorage {
  private value: string | null = null;

  read(): string | null {
    return this.value;
  }

  write(value: string): void {
    this.value = value;
  }
}

export function createLocalPluginRuntime(input?: {
  readonly storage?: LocalPluginStorage;
  readonly now?: () => number;
}): LocalPluginRuntime {
  const registry = new LocalPluginRegistry();
  const now = input?.now ?? Date.now;
  const failures = new LocalPluginFailureJournal({
    now,
    makeId: (sequence) => `local-plugin-failure-${sequence}`,
  });
  const browserStorage = (): LocalPluginStorage => {
    if (typeof window === "undefined") return new VolatileLocalPluginStorage();
    try {
      return new BrowserLocalPluginStorage(window.localStorage);
    } catch {
      return new VolatileLocalPluginStorage();
    }
  };
  const storage = input?.storage ?? browserStorage();
  const lifecycle = new LocalPluginLifecycle({ registry, failures, storage, now });
  return { failures, lifecycle, registry };
}

export const localPluginRuntime = createLocalPluginRuntime();
localPluginRuntime.lifecycle.restore();
