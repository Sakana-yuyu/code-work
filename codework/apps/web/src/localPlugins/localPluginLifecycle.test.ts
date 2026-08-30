import type { LocalPluginManifest } from "@codework/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { LocalPluginFailureJournal } from "./localPluginFailureJournal";
import { runIsolatedLocalPluginContribution } from "./localPluginIsolation";
import { LocalPluginLifecycle } from "./localPluginLifecycle";
import { LocalPluginRegistry } from "./localPluginRegistry";
import type { LocalPluginStorage } from "./localPluginStorage";

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
}

function createRuntime(storage = new MemoryStorage()) {
  const registry = new LocalPluginRegistry();
  const failures = new LocalPluginFailureJournal({
    now: () => 1_000,
    makeId: (sequence) => `failure-${sequence}`,
  });
  const lifecycle = new LocalPluginLifecycle({ registry, failures, storage, now: () => 500 });
  return { failures, lifecycle, registry, storage };
}

describe("LocalPluginLifecycle", () => {
  it("安装通过策略校验的 manifest，并向订阅者发布快照", () => {
    const runtime = createRuntime();
    const listener = vi.fn();
    runtime.registry.subscribe(listener);

    const installed = runtime.lifecycle.install(manifest("acme.one"));

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

  it("拒绝权限不闭合的 manifest，且不污染注册表或持久化", () => {
    const runtime = createRuntime();
    const invalid = { ...manifest("acme.invalid"), permissions: [] };

    const installed = runtime.lifecycle.install(invalid);

    expect(installed).toMatchObject({ ok: false, error: { code: "manifest-invalid" } });
    expect(runtime.registry.getSnapshot().plugins).toEqual([]);
    expect(runtime.storage.value).toBeNull();
    expect(runtime.failures.getSnapshot()[0]).toMatchObject({
      pluginId: "acme.invalid",
      phase: "install",
    });
  });

  it("启用、禁用和删除均先持久化再发布，禁用贡献不会被枚举", () => {
    const runtime = createRuntime();
    runtime.lifecycle.install(manifest("acme.one"));

    expect(runtime.lifecycle.disable("acme.one")).toMatchObject({ ok: true });
    expect(runtime.registry.listEnabled("commands")).toEqual([]);
    expect(runtime.lifecycle.enable("acme.one")).toMatchObject({ ok: true });
    expect(runtime.registry.listEnabled("commands")).toHaveLength(1);
    expect(runtime.lifecycle.uninstall("acme.one")).toMatchObject({ ok: true });
    expect(runtime.registry.getSnapshot().plugins).toEqual([]);
  });

  it("更新同 ID 插件时保留用户禁用状态与首次安装时间", () => {
    const runtime = createRuntime();
    runtime.lifecycle.install(manifest("acme.one"));
    runtime.lifecycle.disable("acme.one");

    runtime.lifecycle.install({ ...manifest("acme.one"), version: "1.1.0" });

    expect(runtime.registry.getSnapshot().plugins[0]).toMatchObject({
      enabled: false,
      installedAtUnixMs: 500,
      updatedAtUnixMs: 500,
      manifest: { version: "1.1.0" },
    });
  });

  it("从版本化存储恢复插件，并隔离损坏的存储文档", () => {
    const first = createRuntime();
    first.lifecycle.install(manifest("acme.one"));

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

  it("读取存储失败时保留当前快照并记录恢复失败", () => {
    const runtime = createRuntime();
    runtime.lifecycle.install(manifest("acme.one"));
    runtime.storage.readError = new Error("storage blocked");

    expect(runtime.lifecycle.restore()).toMatchObject({
      ok: false,
      error: { code: "storage-invalid" },
    });
    expect(runtime.registry.listEnabled("commands")).toHaveLength(1);
    expect(runtime.failures.getSnapshot().at(-1)).toMatchObject({ phase: "restore" });
  });

  it("持久化失败时回滚内存发布，不产生半安装状态", () => {
    const runtime = createRuntime();
    runtime.storage.writeError = new Error("quota exceeded");

    expect(runtime.lifecycle.install(manifest("acme.one"))).toMatchObject({
      ok: false,
      error: { code: "storage-write-failed" },
    });
    expect(runtime.registry.getSnapshot().plugins).toEqual([]);
  });

  it("单贡献执行失败会留下可观测记录，且不会阻断其他插件", async () => {
    const runtime = createRuntime();
    runtime.lifecycle.install(manifest("acme.one"));
    runtime.lifecycle.install(manifest("acme.two"));

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
