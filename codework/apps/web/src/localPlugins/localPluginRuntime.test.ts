import type { LocalPluginManifest } from "@codework/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createLocalPluginRuntime } from "./localPluginRuntime";
import {
  decodeLocalPluginStorageDocument,
  encodeLocalPluginStorageDocument,
  type LocalPluginStorage,
  type LocalPluginStorageCompareAndSwapInput,
  type LocalPluginStorageCompareAndSwapResult,
  type StoredLocalPlugin,
} from "./localPluginStorage";

const storedPlugin = (id: string): StoredLocalPlugin => ({
  manifest: {
    manifestVersion: 1,
    apiVersion: { major: 1, minor: 0 },
    id,
    name: id,
    version: "1.0.0",
    permissions: [],
    contributions: {},
  } satisfies LocalPluginManifest,
  enabled: true,
  installedAtUnixMs: 1,
  updatedAtUnixMs: 1,
});

class ObservableMemoryStorage implements LocalPluginStorage {
  private listener: (() => void) | null = null;
  readonly unsubscribe = vi.fn(() => {
    this.listener = null;
  });
  readonly write = vi.fn((value: string) => {
    this.value = value;
  });

  constructor(public value: string | null = null) {}

  read(): string | null {
    return this.value;
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

  subscribe(listener: () => void): () => void {
    this.listener = listener;
    return this.unsubscribe;
  }

  emit(): void {
    this.listener?.();
  }
}

describe("createLocalPluginRuntime", () => {
  it("保留冷启动恢复结果，并记录可供设置页展示的全局失败", () => {
    const duplicate = storedPlugin("acme.duplicate");
    const storage = new ObservableMemoryStorage(
      JSON.stringify({ version: 1, plugins: [duplicate, duplicate] }),
    );

    const runtime = createLocalPluginRuntime({ storage, now: () => 1, writerId: "writer-a" });

    expect(runtime.restoreResult).toMatchObject({
      ok: false,
      error: { code: "storage-duplicate-id" },
    });
    expect(runtime.failures.getSnapshot()).toEqual([
      expect.objectContaining({ pluginId: "unknown-plugin", phase: "restore" }),
    ]);
    expect(runtime.registry.getSnapshot().plugins).toEqual([]);
    expect(storage.write).not.toHaveBeenCalled();
  });

  it("自动订阅外部存储变化，并在 dispose 后停止同步", () => {
    const storage = new ObservableMemoryStorage();
    const runtime = createLocalPluginRuntime({ storage, now: () => 1, writerId: "writer-a" });
    storage.value = encodeLocalPluginStorageDocument([storedPlugin("acme.one")], {
      revision: 1,
      writerId: "writer-b",
    });

    storage.emit();
    expect(runtime.registry.getSnapshot().plugins.map((plugin) => plugin.manifest.id)).toEqual([
      "acme.one",
    ]);

    runtime.dispose();
    storage.value = encodeLocalPluginStorageDocument([storedPlugin("acme.two")], {
      revision: 2,
      writerId: "writer-b",
    });
    storage.emit();

    expect(storage.unsubscribe).toHaveBeenCalledTimes(1);
    expect(runtime.registry.getSnapshot().plugins.map((plugin) => plugin.manifest.id)).toEqual([
      "acme.one",
    ]);
  });
});
