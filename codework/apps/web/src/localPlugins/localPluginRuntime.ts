import { randomUUID } from "~/lib/utils";

import { LocalPluginFailureJournal } from "./localPluginFailureJournal";
import { LocalPluginLifecycle, type LocalPluginLifecycleResult } from "./localPluginLifecycle";
import { LocalPluginRegistry } from "./localPluginRegistry";
import {
  BrowserLocalPluginStorage,
  decodeLocalPluginStorageDocument,
  type LocalPluginStorage,
  type LocalPluginStorageCompareAndSwapInput,
  type LocalPluginStorageCompareAndSwapResult,
} from "./localPluginStorage";

export interface LocalPluginRuntime {
  readonly failures: LocalPluginFailureJournal;
  readonly lifecycle: LocalPluginLifecycle;
  readonly registry: LocalPluginRegistry;
  readonly restoreResult: LocalPluginLifecycleResult;
  readonly dispose: () => void;
}

class VolatileLocalPluginStorage implements LocalPluginStorage {
  private value: string | null = null;

  read(): string | null {
    return this.value;
  }

  write(value: string): void {
    this.value = value;
  }

  async compareAndSwap(
    input: LocalPluginStorageCompareAndSwapInput,
  ): Promise<LocalPluginStorageCompareAndSwapResult> {
    const currentRevision =
      this.value === null ? 0 : (decodeLocalPluginStorageDocument(this.value).revision ?? 0);
    if (this.value !== input.expectedValue || currentRevision !== input.expectedRevision) {
      return { swapped: false, currentValue: this.value };
    }
    this.write(input.nextValue);
    return { swapped: true, currentValue: this.value };
  }
}

export function createLocalPluginRuntime(input?: {
  readonly storage?: LocalPluginStorage;
  readonly now?: () => number;
  readonly writerId?: string;
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
  const writerId = input?.writerId ?? `local-plugin:${randomUUID()}`;
  const lifecycle = new LocalPluginLifecycle({ registry, failures, storage, now, writerId });
  const unsubscribe = storage.subscribe?.(() => {
    lifecycle.synchronize();
  });
  const restoreResult = lifecycle.restore();
  let disposed = false;
  return {
    failures,
    lifecycle,
    registry,
    restoreResult,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
    },
  };
}

export const localPluginRuntime = createLocalPluginRuntime();
