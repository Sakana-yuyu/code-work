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
    expect(runtime.storageStatus.getSnapshot()).toMatchObject({
      phase: "restore",
      result: { ok: false, error: { code: "storage-duplicate-id" } },
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
    const statusListener = vi.fn();
    runtime.storageStatus.subscribe(statusListener);
    storage.value = encodeLocalPluginStorageDocument([storedPlugin("acme.one")], {
      revision: 1,
      writerId: "writer-b",
    });

    storage.emit();
    expect(runtime.lastSynchronizeResult).toEqual({ ok: true });
    expect(runtime.storageStatus.getSnapshot()).toEqual({
      phase: "synchronize",
      result: { ok: true },
    });
    expect(statusListener).toHaveBeenCalledTimes(1);
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

  it("有效外部文档修复冷启动失败后清除当前阻断状态", async () => {
    const duplicate = storedPlugin("acme.duplicate");
    const storage = new ObservableMemoryStorage(
      JSON.stringify({ version: 1, plugins: [duplicate, duplicate] }),
    );
    const runtime = createLocalPluginRuntime({ storage, now: () => 1, writerId: "writer-a" });
    storage.value = encodeLocalPluginStorageDocument([storedPlugin("acme.repaired")], {
      revision: 1,
      writerId: "writer-b",
    });

    storage.emit();

    expect(runtime.storageStatus.getSnapshot()).toEqual({
      phase: "synchronize",
      result: { ok: true },
    });
    expect(await runtime.lifecycle.install(storedPlugin("acme.new").manifest)).toEqual({
      ok: true,
    });
  });

  it("保留 storage 事件同步失败的类型化结果，不把重复文档误报为冲突", () => {
    const storage = new ObservableMemoryStorage();
    const runtime = createLocalPluginRuntime({ storage, now: () => 1, writerId: "writer-a" });
    const duplicate = storedPlugin("acme.duplicate");
    storage.value = JSON.stringify({ version: 1, plugins: [duplicate, duplicate] });

    storage.emit();

    expect(runtime.lastSynchronizeResult).toMatchObject({
      ok: false,
      error: { code: "storage-duplicate-id" },
    });
    expect(runtime.storageStatus.getSnapshot()).toMatchObject({
      phase: "synchronize",
      result: { ok: false, error: { code: "storage-duplicate-id" } },
    });
    expect(runtime.failures.getSnapshot().at(-1)).toMatchObject({
      phase: "synchronize",
      code: "storage-duplicate-id",
    });
  });

  it("把修订回退冲突保留为当前类型化同步状态", () => {
    const storage = new ObservableMemoryStorage(
      encodeLocalPluginStorageDocument([storedPlugin("acme.one")], {
        revision: 2,
        writerId: "writer-a",
      }),
    );
    const runtime = createLocalPluginRuntime({ storage, now: () => 1, writerId: "writer-a" });
    storage.value = encodeLocalPluginStorageDocument([storedPlugin("acme.two")], {
      revision: 1,
      writerId: "writer-b",
    });

    storage.emit();

    expect(runtime.storageStatus.getSnapshot()).toMatchObject({
      phase: "synchronize",
      result: { ok: false, error: { code: "storage-conflict" } },
    });
  });
});
