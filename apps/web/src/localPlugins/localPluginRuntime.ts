import { randomUUID } from "~/lib/utils";

import type { LocalPluginFailurePhase } from "./localPluginFailureJournal";
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
  readonly phase: Exclude<LocalPluginFailurePhase, "invoke" | "render">;
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
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // 单个界面订阅者不能阻断其他观察者或领域操作。
      }
    }
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

function isStorageFailureResult(result: LocalPluginLifecycleResult): boolean {
  if (result.ok) return false;
  return (
    result.error.code === "storage-invalid" ||
    result.error.code === "storage-duplicate-id" ||
    result.error.code === "storage-lock-unavailable" ||
    result.error.code === "storage-conflict" ||
    result.error.code === "storage-write-failed"
  );
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
  const storageStatus = new LocalPluginRuntimeStorageStatusStore({
    phase: "restore",
    result: { ok: true },
  });
  let synchronizeGeneration = 0;
  const lifecycle = new LocalPluginLifecycle({
    registry,
    failures,
    storage,
    now,
    writerId,
    onMutationStart: () => synchronizeGeneration,
    onMutationResult: ({ phase, result, generation }) => {
      if (generation !== synchronizeGeneration) return;
      if (result.ok || isStorageFailureResult(result)) storageStatus.update({ phase, result });
    },
  });
  const restoreResult = lifecycle.restore();
  storageStatus.update({ phase: "restore", result: restoreResult });
  let lastSynchronizeResult: LocalPluginLifecycleResult | null = null;
  const unsubscribe = storage.subscribe?.(() => {
    synchronizeGeneration += 1;
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
