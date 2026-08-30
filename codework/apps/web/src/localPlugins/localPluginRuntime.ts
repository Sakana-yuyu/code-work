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
  readonly lastSynchronizeResult: LocalPluginLifecycleResult | null;
  readonly storageStatus: LocalPluginRuntimeStorageStatus;
  readonly dispose: () => void;
}

export interface LocalPluginRuntimeStorageStatusSnapshot {
  readonly phase: "restore" | "synchronize";
  readonly result: LocalPluginLifecycleResult;
}

export interface LocalPluginRuntimeStorageStatus {
  readonly getSnapshot: () => LocalPluginRuntimeStorageStatusSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
}

class LocalPluginRuntimeStorageStatusStore implements LocalPluginRuntimeStorageStatus {
  private readonly listeners = new Set<() => void>();

  constructor(private snapshot: LocalPluginRuntimeStorageStatusSnapshot) {}

  readonly getSnapshot = (): LocalPluginRuntimeStorageStatusSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(snapshot: LocalPluginRuntimeStorageStatusSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
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
  const restoreResult = lifecycle.restore();
  const storageStatus = new LocalPluginRuntimeStorageStatusStore({
    phase: "restore",
    result: restoreResult,
  });
  let lastSynchronizeResult: LocalPluginLifecycleResult | null = null;
  const unsubscribe = storage.subscribe?.(() => {
    lastSynchronizeResult = lifecycle.synchronize();
    storageStatus.update({ phase: "synchronize", result: lastSynchronizeResult });
  });
  let disposed = false;
  return {
    failures,
    lifecycle,
    registry,
    restoreResult,
    get lastSynchronizeResult() {
      return lastSynchronizeResult;
    },
    storageStatus,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
    },
  };
}

export const localPluginRuntime = createLocalPluginRuntime();
