import type { LocalPluginManifest } from "@codework/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { LocalPluginFailureJournal } from "./localPluginFailureJournal";
import { runIsolatedLocalPluginContribution } from "./localPluginIsolation";
import {
  LocalPluginLifecycle,
  type LocalPluginLifecycleMutationResult,
} from "./localPluginLifecycle";
import { LocalPluginRegistry } from "./localPluginRegistry";
import {
  decodeLocalPluginStorageDocument,
  encodeLocalPluginStorageDocument,
  type LocalPluginStorageCompareAndSwapInput,
  type LocalPluginStorageCompareAndSwapResult,
  type LocalPluginStorage,
  type StoredLocalPlugin,
} from "./localPluginStorage";

const manifest = (id: string): LocalPluginManifest => ({
  manifestVersion: 1,
  apiVersion: { major: 1, minor: 0 },
  id,
  name: `插件 ${id}`,
  version: "1.0.0",
  permissions: ["composer.prompt.write"],
  contributions: {
    commands: [
      {
        id: "insert",
        title: "插入提示词",
        action: { type: "composer.prompt.insert", text: "检查当前改动" },
      },
    ],
  },
});

class MemoryStorage implements LocalPluginStorage {
  value: string | null = null;
  readError: Error | null = null;
  writeError: Error | null = null;

  read(): string | null {
    if (this.readError) throw this.readError;
    return this.value;
  }

  write(value: string): void {
    if (this.writeError) throw this.writeError;
    this.value = value;
  }

  async compareAndSwap(
    input: LocalPluginStorageCompareAndSwapInput,
  ): Promise<LocalPluginStorageCompareAndSwapResult> {
    const currentValue = this.read();
    const currentRevision =
      currentValue === null ? 0 : (decodeLocalPluginStorageDocument(currentValue).revision ?? 0);
    if (currentValue !== input.expectedValue || currentRevision !== input.expectedRevision) {
      return { swapped: false, currentValue };
    }
    this.write(input.nextValue);
    const persistedValue = this.read();
    return { swapped: persistedValue === input.nextValue, currentValue: persistedValue };
  }
}

class CoordinatedMemoryStorage extends MemoryStorage {
  private pendingWriterA:
    | {
        readonly input: LocalPluginStorageCompareAndSwapInput;
        readonly resolve: (result: LocalPluginStorageCompareAndSwapResult) => void;
      }
    | undefined;

  override compareAndSwap(
    input: LocalPluginStorageCompareAndSwapInput,
  ): Promise<LocalPluginStorageCompareAndSwapResult> {
    const writerId = decodeLocalPluginStorageDocument(input.nextValue).writerId;
    if (writerId !== "writer-a") return super.compareAndSwap(input);
    return new Promise((resolve) => {
      this.pendingWriterA = { input, resolve };
    });
  }

  async releaseWriterA(): Promise<void> {
    const pending = this.pendingWriterA;
    if (pending === undefined) throw new Error("writer-a 没有待释放的 CAS 请求");
    this.pendingWriterA = undefined;
    pending.resolve(await super.compareAndSwap(pending.input));
  }
}

function createRuntime(
  storage = new MemoryStorage(),
  writerId = "writer-a",
  onMutationResult?: (input: LocalPluginLifecycleMutationResult) => void,
) {
  const registry = new LocalPluginRegistry();
  const failures = new LocalPluginFailureJournal({
    now: () => 1_000,
    makeId: (sequence) => `failure-${sequence}`,
  });
  const lifecycle = new LocalPluginLifecycle({
    registry,
    failures,
    storage,
    now: () => 500,
    writerId,
    ...(onMutationResult === undefined ? {} : { onMutationResult }),
  });
  return { failures, lifecycle, registry, storage };
}

const storedRegistration = (id: string): StoredLocalPlugin => ({
  manifest: manifest(id),
  enabled: true,
  installedAtUnixMs: 100,
  updatedAtUnixMs: 100,
});

describe("LocalPluginLifecycle", () => {
  it("安装通过策略校验的 manifest，并向订阅者发布快照", async () => {
    const runtime = createRuntime();
    const listener = vi.fn();
    runtime.registry.subscribe(listener);

    const installed = await runtime.lifecycle.install(manifest("acme.one"));

    expect(installed.ok).toBe(true);
    expect(runtime.registry.listEnabled("commands")).toHaveLength(1);
    expect(runtime.registry.getSnapshot().plugins[0]).toMatchObject({
      enabled: true,
      installedAtUnixMs: 500,
      manifest: { id: "acme.one" },
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(runtime.storage.value).toContain("acme.one");
  });

  it("mutation 观察者异常不反转已完成的持久化结果", async () => {
    const onMutationResult = vi.fn(() => {
      throw new Error("observer failed");
    });
    const runtime = createRuntime(new MemoryStorage(), "writer-a", onMutationResult);

    const result = await runtime.lifecycle.install(manifest("acme.observer"));

    expect(result).toEqual({ ok: true });
    expect(onMutationResult).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "install", result: { ok: true } }),
    );
    expect(runtime.registry.getSnapshot().plugins.map((plugin) => plugin.manifest.id)).toEqual([
      "acme.observer",
    ]);
    expect(decodeLocalPluginStorageDocument(runtime.storage.value ?? "").plugins).toHaveLength(1);
    expect(runtime.failures.getSnapshot()).toEqual([]);
  });

  it("拒绝权限不闭合的 manifest，且不污染注册表或持久化", async () => {
    const runtime = createRuntime();
    const invalid = { ...manifest("acme.invalid"), permissions: [] };

    const installed = await runtime.lifecycle.install(invalid);

    expect(installed).toMatchObject({ ok: false, error: { code: "manifest-invalid" } });
    expect(runtime.registry.getSnapshot().plugins).toEqual([]);
    expect(runtime.storage.value).toBeNull();
    expect(runtime.failures.getSnapshot()[0]).toMatchObject({
      pluginId: "acme.invalid",
      phase: "install",
    });
  });

  it("启用、禁用和删除均先持久化再发布，禁用贡献不会被枚举", async () => {
    const runtime = createRuntime();
    await runtime.lifecycle.install(manifest("acme.one"));

    expect(await runtime.lifecycle.disable("acme.one")).toMatchObject({ ok: true });
    expect(runtime.registry.listEnabled("commands")).toEqual([]);
    expect(await runtime.lifecycle.enable("acme.one")).toMatchObject({ ok: true });
    expect(runtime.registry.listEnabled("commands")).toHaveLength(1);
    expect(await runtime.lifecycle.uninstall("acme.one")).toMatchObject({ ok: true });
    expect(runtime.registry.getSnapshot().plugins).toEqual([]);
  });

  it("更新同 ID 插件时保留用户禁用状态与首次安装时间", async () => {
    const runtime = createRuntime();
    await runtime.lifecycle.install(manifest("acme.one"));
    await runtime.lifecycle.disable("acme.one");

    await runtime.lifecycle.install({ ...manifest("acme.one"), version: "1.1.0" });

    expect(runtime.registry.getSnapshot().plugins[0]).toMatchObject({
      enabled: false,
      installedAtUnixMs: 500,
      updatedAtUnixMs: 500,
      manifest: { version: "1.1.0" },
    });
  });

  it("每次变更前重读共享存储，避免顺序操作覆盖其他标签页插件", async () => {
    const storage = new MemoryStorage();
    const first = createRuntime(storage, "writer-a");
    const second = createRuntime(storage, "writer-b");

    expect(await first.lifecycle.install(manifest("acme.one"))).toEqual({ ok: true });
    expect(await second.lifecycle.install(manifest("acme.two"))).toEqual({ ok: true });

    expect(second.registry.getSnapshot().plugins.map((plugin) => plugin.manifest.id)).toEqual([
      "acme.one",
      "acme.two",
    ]);
    expect(first.lifecycle.synchronize()).toEqual({ ok: true });
    expect(first.registry.getSnapshot().plugins.map((plugin) => plugin.manifest.id)).toEqual([
      "acme.one",
      "acme.two",
    ]);
  });

  async function runStaleMutationScenario(input: {
    readonly seed: StoredLocalPlugin;
    readonly mutate: (runtime: ReturnType<typeof createRuntime>) => Promise<unknown>;
  }) {
    const storage = new CoordinatedMemoryStorage();
    storage.value = encodeLocalPluginStorageDocument([input.seed], {
      revision: 7,
      writerId: "seed-writer",
    });
    const first = createRuntime(storage, "writer-a");
    const second = createRuntime(storage, "writer-b");
    expect(first.lifecycle.restore()).toEqual({ ok: true });
    expect(second.lifecycle.restore()).toEqual({ ok: true });

    const staleResultPromise = input.mutate(first);
    const winnerResult = await second.lifecycle.install(manifest("acme.winner"));
    expect(winnerResult).toEqual({ ok: true });
    await storage.releaseWriterA();

    return {
      first,
      staleResult: await staleResultPromise,
      stored: decodeLocalPluginStorageDocument(storage.value ?? ""),
    };
  }

  it("A/B 同读 rev7 时拒绝 A 的陈旧安装，不丢失 B 的 rev8 安装", async () => {
    const result = await runStaleMutationScenario({
      seed: storedRegistration("acme.seed"),
      mutate: (runtime) => runtime.lifecycle.install(manifest("acme.stale")),
    });

    expect(result.staleResult).toMatchObject({
      ok: false,
      error: { code: "storage-conflict" },
    });
    expect(result.stored.revision).toBe(8);
    expect(result.stored.plugins.map((plugin) => plugin.manifest.id)).toEqual([
      "acme.seed",
      "acme.winner",
    ]);
  });

  it("A/B 同读 rev7 时拒绝 A 的陈旧更新，不丢失 B 的 rev8 安装", async () => {
    const result = await runStaleMutationScenario({
      seed: storedRegistration("acme.target"),
      mutate: (runtime) =>
        runtime.lifecycle.install({ ...manifest("acme.target"), version: "2.0.0" }),
    });

    expect(result.staleResult).toMatchObject({
      ok: false,
      error: { code: "storage-conflict" },
    });
    expect(result.stored.revision).toBe(8);
    expect(result.stored.plugins.map((plugin) => plugin.manifest.id)).toEqual([
      "acme.target",
      "acme.winner",
    ]);
    expect(result.stored.plugins[0]?.manifest.version).toBe("1.0.0");
  });

  it("A/B 同读 rev7 时拒绝 A 的陈旧启用，不丢失 B 的 rev8 安装", async () => {
    const result = await runStaleMutationScenario({
      seed: { ...storedRegistration("acme.target"), enabled: false },
      mutate: (runtime) => runtime.lifecycle.enable("acme.target"),
    });

    expect(result.staleResult).toMatchObject({
      ok: false,
      error: { code: "storage-conflict" },
    });
    expect(result.stored.revision).toBe(8);
    expect(result.stored.plugins.map((plugin) => plugin.manifest.id)).toEqual([
      "acme.target",
      "acme.winner",
    ]);
    expect(result.stored.plugins[0]?.enabled).toBe(false);
  });

  it("A/B 同读 rev7 时拒绝 A 的陈旧卸载，不丢失 B 的 rev8 安装", async () => {
    const result = await runStaleMutationScenario({
      seed: storedRegistration("acme.target"),
      mutate: (runtime) => runtime.lifecycle.uninstall("acme.target"),
    });

    expect(result.staleResult).toMatchObject({
      ok: false,
      error: { code: "storage-conflict" },
    });
    expect(result.stored.revision).toBe(8);
    expect(result.stored.plugins.map((plugin) => plugin.manifest.id)).toEqual([
      "acme.target",
      "acme.winner",
    ]);
  });

  it("检测同修订号的其他写入者覆盖，记录冲突并采用最终持久化状态", async () => {
    const runtime = createRuntime(new MemoryStorage(), "writer-a");
    await runtime.lifecycle.install(manifest("acme.one"));
    const current = decodeLocalPluginStorageDocument(runtime.storage.value ?? "");
    const replacement: StoredLocalPlugin = {
      manifest: manifest("acme.two"),
      enabled: true,
      installedAtUnixMs: 600,
      updatedAtUnixMs: 600,
    };
    runtime.storage.value = encodeLocalPluginStorageDocument([replacement], {
      revision: current.revision ?? 0,
      writerId: "writer-b",
    });

    expect(runtime.lifecycle.synchronize()).toMatchObject({
      ok: false,
      error: { code: "storage-conflict" },
    });
    expect(runtime.registry.getSnapshot().plugins.map((plugin) => plugin.manifest.id)).toEqual([
      "acme.two",
    ]);
    expect(runtime.failures.getSnapshot().at(-1)).toMatchObject({
      pluginId: "unknown-plugin",
      phase: "synchronize",
    });
  });

  it("原子写入回读发现非协作覆盖时返回冲突并采用持久化结果", async () => {
    const storage = new MemoryStorage();
    const replacement: StoredLocalPlugin = {
      manifest: manifest("acme.two"),
      enabled: true,
      installedAtUnixMs: 600,
      updatedAtUnixMs: 600,
    };
    vi.spyOn(storage, "write").mockImplementation(() => {
      storage.value = encodeLocalPluginStorageDocument([replacement], {
        revision: 1,
        writerId: "writer-b",
      });
    });
    const runtime = createRuntime(storage, "writer-a");

    expect(await runtime.lifecycle.install(manifest("acme.one"))).toMatchObject({
      ok: false,
      error: { code: "storage-conflict" },
    });
    expect(runtime.registry.getSnapshot().plugins.map((plugin) => plugin.manifest.id)).toEqual([
      "acme.two",
    ]);
    expect(runtime.failures.getSnapshot().at(-1)).toMatchObject({
      pluginId: "acme.one",
      phase: "install",
    });
  });

  it("从版本化存储恢复插件，并隔离损坏的存储文档", async () => {
    const first = createRuntime();
    await first.lifecycle.install(manifest("acme.one"));

    const restored = createRuntime(first.storage);
    expect(restored.lifecycle.restore()).toMatchObject({ ok: true });
    expect(restored.registry.listEnabled("commands")).toHaveLength(1);

    restored.storage.value = '{"version":2,"plugins":[]}';
    expect(restored.lifecycle.restore()).toMatchObject({
      ok: false,
      error: { code: "storage-invalid" },
    });
    expect(restored.registry.listEnabled("commands")).toHaveLength(1);
  });

  it("恢复旧版无修订元数据的存储文档", () => {
    const runtime = createRuntime();
    const legacy: StoredLocalPlugin = {
      manifest: manifest("acme.legacy"),
      enabled: true,
      installedAtUnixMs: 100,
      updatedAtUnixMs: 100,
    };
    runtime.storage.value = JSON.stringify({ version: 1, plugins: [legacy] });

    expect(runtime.lifecycle.restore()).toEqual({ ok: true });
    expect(runtime.registry.getSnapshot().plugins.map((plugin) => plugin.manifest.id)).toEqual([
      "acme.legacy",
    ]);
  });

  it("读取存储失败时保留当前快照并记录恢复失败", async () => {
    const runtime = createRuntime();
    await runtime.lifecycle.install(manifest("acme.one"));
    runtime.storage.readError = new Error("storage blocked");

    expect(runtime.lifecycle.restore()).toMatchObject({
      ok: false,
      error: { code: "storage-invalid" },
    });
    expect(runtime.registry.listEnabled("commands")).toHaveLength(1);
    expect(runtime.failures.getSnapshot().at(-1)).toMatchObject({ phase: "restore" });
  });

  it("冷启动重复文档阻止所有变更路径，并保持原始存储逐字不变", async () => {
    const runtime = createRuntime();
    const duplicate = storedRegistration("acme.duplicate");
    runtime.storage.value = JSON.stringify({ version: 1, plugins: [duplicate, duplicate] });
    const originalValue = runtime.storage.value;
    const write = vi.spyOn(runtime.storage, "write");

    expect(runtime.lifecycle.restore()).toMatchObject({
      ok: false,
      error: { code: "storage-duplicate-id" },
    });
    expect(runtime.registry.getSnapshot().plugins).toEqual([]);
    const blockedResults = await Promise.all([
      runtime.lifecycle.install(manifest("acme.new")),
      runtime.lifecycle.install({ ...manifest("acme.duplicate"), version: "2.0.0" }),
      runtime.lifecycle.enable("acme.duplicate"),
      runtime.lifecycle.disable("acme.duplicate"),
      runtime.lifecycle.uninstall("acme.duplicate"),
    ]);
    expect(blockedResults).toEqual(
      Array.from({ length: 5 }, () => ({
        ok: false,
        error: expect.objectContaining({ code: "storage-duplicate-id" }),
      })),
    );
    expect(runtime.storage.value).toBe(originalValue);
    expect(write).not.toHaveBeenCalled();
    expect(runtime.failures.getSnapshot()).toHaveLength(1);
    expect(runtime.failures.getSnapshot()[0]).toMatchObject({
      pluginId: "unknown-plugin",
      phase: "restore",
      code: "storage-duplicate-id",
    });
  });

  it("写入侧重复 ID 返回专用错误，不误报为存储写入失败", async () => {
    const runtime = createRuntime();
    const duplicate = storedRegistration("acme.duplicate");
    runtime.registry.replace([duplicate, duplicate]);

    expect(await runtime.lifecycle.install(manifest("acme.new"))).toMatchObject({
      ok: false,
      error: { code: "storage-duplicate-id" },
    });
    expect(runtime.storage.value).toBeNull();
    expect(runtime.failures.getSnapshot().at(-1)).toMatchObject({
      pluginId: "acme.new",
      phase: "install",
      code: "storage-duplicate-id",
    });
  });

  it("持久化失败时回滚内存发布，不产生半安装状态", async () => {
    const runtime = createRuntime();
    runtime.storage.writeError = new Error("quota exceeded");

    expect(await runtime.lifecycle.install(manifest("acme.one"))).toMatchObject({
      ok: false,
      error: { code: "storage-write-failed" },
    });
    expect(runtime.registry.getSnapshot().plugins).toEqual([]);
  });

  it("单贡献执行失败会留下可观测记录，且不会阻断其他插件", async () => {
    const runtime = createRuntime();
    await runtime.lifecycle.install(manifest("acme.one"));
    await runtime.lifecycle.install(manifest("acme.two"));

    const failed = await runIsolatedLocalPluginContribution({
      failures: runtime.failures,
      pluginId: "acme.one",
      contributionKind: "commands",
      contributionId: "insert",
      run: async () => {
        throw new Error("clipboard unavailable");
      },
    });
    const succeeded = await runIsolatedLocalPluginContribution({
      failures: runtime.failures,
      pluginId: "acme.two",
      contributionKind: "commands",
      contributionId: "insert",
      run: async () => "ok",
    });

    expect(failed).toMatchObject({ ok: false, failure: { pluginId: "acme.one" } });
    expect(succeeded).toEqual({ ok: true, value: "ok" });
    expect(runtime.registry.listEnabled("commands")).toHaveLength(2);
    expect(runtime.failures.getSnapshot()).toHaveLength(1);
  });
});
