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

class DeferredCasStorage extends ObservableMemoryStorage {
  private pending:
    | {
        readonly result: LocalPluginStorageCompareAndSwapResult;
        readonly resolve: (result: LocalPluginStorageCompareAndSwapResult) => void;
      }
    | undefined;

  override compareAndSwap(
    input: LocalPluginStorageCompareAndSwapInput,
  ): Promise<LocalPluginStorageCompareAndSwapResult> {
    const currentRevision =
      this.value === null ? 0 : (decodeLocalPluginStorageDocument(this.value).revision ?? 0);
    const swapped =
      this.value === input.expectedValue && currentRevision === input.expectedRevision;
    if (swapped) this.write(input.nextValue);
    const result = { swapped, currentValue: this.value };
    return new Promise((resolve) => {
      this.pending = { result, resolve };
    });
  }

  releaseCas(): void {
    const pending = this.pending;
    if (!pending) throw new Error("没有待恢复的 CAS continuation。");
    this.pending = undefined;
    pending.resolve(pending.result);
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

  it("隔离 storageStatus 订阅者异常并继续通知其他订阅者", async () => {
    const storage = new ObservableMemoryStorage();
    const runtime = createLocalPluginRuntime({ storage, now: () => 1, writerId: "writer-a" });
    const throwingListener = vi.fn(() => {
      throw new Error("listener failed");
    });
    const healthyListener = vi.fn();
    runtime.storageStatus.subscribe(throwingListener);
    runtime.storageStatus.subscribe(healthyListener);

    const result = await runtime.lifecycle.install(storedPlugin("acme.observer").manifest);

    expect(result).toEqual({ ok: true });
    expect(throwingListener).toHaveBeenCalledTimes(1);
    expect(healthyListener).toHaveBeenCalledTimes(1);
    expect(storage.write).toHaveBeenCalledTimes(1);
    expect(runtime.registry.getSnapshot().plugins.map((plugin) => plugin.manifest.id)).toEqual([
      "acme.observer",
    ]);
  });

  it("CAS continuation 不回退已同步的更高修订和状态", async () => {
    const storage = new DeferredCasStorage(
      encodeLocalPluginStorageDocument([storedPlugin("acme.seed")], {
        revision: 7,
        writerId: "seed-writer",
      }),
    );
    const runtime = createLocalPluginRuntime({ storage, now: () => 1, writerId: "writer-a" });

    const installPromise = runtime.lifecycle.install(storedPlugin("acme.a").manifest);
    const afterA = decodeLocalPluginStorageDocument(storage.value ?? "");
    expect(afterA.revision).toBe(8);
    storage.value = encodeLocalPluginStorageDocument([...afterA.plugins, storedPlugin("acme.b")], {
      revision: 9,
      writerId: "writer-b",
    });
    storage.emit();

    expect(runtime.storageStatus.getSnapshot()).toEqual({
      phase: "synchronize",
      result: { ok: true },
    });
    expect(runtime.registry.getSnapshot().plugins.map((plugin) => plugin.manifest.id)).toEqual([
      "acme.seed",
      "acme.a",
      "acme.b",
    ]);

    storage.releaseCas();
    expect(await installPromise).toEqual({ ok: true });
    expect(runtime.registry.getSnapshot().plugins.map((plugin) => plugin.manifest.id)).toEqual([
      "acme.seed",
      "acme.a",
      "acme.b",
    ]);
    expect(runtime.storageStatus.getSnapshot()).toEqual({
      phase: "synchronize",
      result: { ok: true },
    });
  });

  it("旧 mutation completion 不覆盖更新的同步冲突", async () => {
    const storage = new DeferredCasStorage(
      encodeLocalPluginStorageDocument([storedPlugin("acme.seed")], {
        revision: 7,
        writerId: "seed-writer",
      }),
    );
    const runtime = createLocalPluginRuntime({ storage, now: () => 1, writerId: "writer-a" });

    const installPromise = runtime.lifecycle.install(storedPlugin("acme.a").manifest);
    expect(decodeLocalPluginStorageDocument(storage.value ?? "").revision).toBe(8);
    storage.value = encodeLocalPluginStorageDocument([storedPlugin("acme.rollback")], {
      revision: 7,
      writerId: "writer-b",
    });
    storage.emit();

    expect(runtime.storageStatus.getSnapshot()).toMatchObject({
      phase: "synchronize",
      result: { ok: false, error: { code: "storage-conflict" } },
    });

    storage.releaseCas();
    expect(await installPromise).toMatchObject({
      ok: false,
      error: { code: "storage-conflict" },
    });
    expect(runtime.registry.getSnapshot().plugins.map((plugin) => plugin.manifest.id)).toEqual([
      "acme.rollback",
    ]);
    expect(runtime.storageStatus.getSnapshot()).toMatchObject({
      phase: "synchronize",
      result: { ok: false, error: { code: "storage-conflict" } },
    });
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

  it.each([
    {
      name: "安装",
      phase: "install",
      stored: [storedPlugin("acme.target")],
      mutate: (runtime: ReturnType<typeof createLocalPluginRuntime>) =>
        runtime.lifecycle.install(storedPlugin("acme.new").manifest),
    },
    {
      name: "更新",
      phase: "install",
      stored: [storedPlugin("acme.target")],
      mutate: (runtime: ReturnType<typeof createLocalPluginRuntime>) =>
        runtime.lifecycle.install({
          ...storedPlugin("acme.target").manifest,
          version: "2.0.0",
        }),
    },
    {
      name: "启用",
      phase: "enable",
      stored: [{ ...storedPlugin("acme.target"), enabled: false }],
      mutate: (runtime: ReturnType<typeof createLocalPluginRuntime>) =>
        runtime.lifecycle.enable("acme.target"),
    },
    {
      name: "禁用",
      phase: "disable",
      stored: [storedPlugin("acme.target")],
      mutate: (runtime: ReturnType<typeof createLocalPluginRuntime>) =>
        runtime.lifecycle.disable("acme.target"),
    },
    {
      name: "卸载",
      phase: "uninstall",
      stored: [storedPlugin("acme.target")],
      mutate: (runtime: ReturnType<typeof createLocalPluginRuntime>) =>
        runtime.lifecycle.uninstall("acme.target"),
    },
  ] as const)("同标签成功$name后清除旧同步冲突", async ({ phase, stored, mutate }) => {
    const storage = new ObservableMemoryStorage(
      encodeLocalPluginStorageDocument(stored, { revision: 2, writerId: "writer-a" }),
    );
    const runtime = createLocalPluginRuntime({ storage, now: () => 1, writerId: "writer-a" });
    storage.value = encodeLocalPluginStorageDocument(stored, {
      revision: 1,
      writerId: "writer-b",
    });
    storage.emit();
    const statusListener = vi.fn();
    runtime.storageStatus.subscribe(statusListener);

    expect(runtime.storageStatus.getSnapshot()).toMatchObject({
      phase: "synchronize",
      result: { ok: false, error: { code: "storage-conflict" } },
    });
    expect(await mutate(runtime)).toEqual({ ok: true });
    expect(runtime.storageStatus.getSnapshot()).toEqual({
      phase,
      result: { ok: true },
    });
    expect(statusListener).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "安装",
      mutate: (runtime: ReturnType<typeof createLocalPluginRuntime>) =>
        runtime.lifecycle.install(storedPlugin("acme.new").manifest),
    },
    {
      name: "更新",
      mutate: (runtime: ReturnType<typeof createLocalPluginRuntime>) =>
        runtime.lifecycle.install({
          ...storedPlugin("acme.duplicate").manifest,
          version: "2.0.0",
        }),
    },
    {
      name: "启用",
      mutate: (runtime: ReturnType<typeof createLocalPluginRuntime>) =>
        runtime.lifecycle.enable("acme.duplicate"),
    },
    {
      name: "禁用",
      mutate: (runtime: ReturnType<typeof createLocalPluginRuntime>) =>
        runtime.lifecycle.disable("acme.duplicate"),
    },
    {
      name: "卸载",
      mutate: (runtime: ReturnType<typeof createLocalPluginRuntime>) =>
        runtime.lifecycle.uninstall("acme.duplicate"),
    },
  ] as const)("恢复失败继续阻止$name且保留稳定存储错误码", async ({ mutate }) => {
    const duplicate = storedPlugin("acme.duplicate");
    const originalValue = JSON.stringify({ version: 1, plugins: [duplicate, duplicate] });
    const storage = new ObservableMemoryStorage(originalValue);
    const runtime = createLocalPluginRuntime({ storage, now: () => 1, writerId: "writer-a" });

    expect(await mutate(runtime)).toMatchObject({
      ok: false,
      error: { code: "storage-duplicate-id" },
    });
    expect(runtime.storageStatus.getSnapshot()).toMatchObject({
      result: { ok: false, error: { code: "storage-duplicate-id" } },
    });
    expect(storage.value).toBe(originalValue);
    expect(storage.write).not.toHaveBeenCalled();
  });
});
