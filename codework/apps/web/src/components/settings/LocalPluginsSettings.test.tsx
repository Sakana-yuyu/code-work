import type { LocalPluginManifest } from "@codework/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { LocalPluginFailureJournal } from "~/localPlugins/localPluginFailureJournal";
import { LocalPluginLifecycle } from "~/localPlugins/localPluginLifecycle";
import { LocalPluginRegistry } from "~/localPlugins/localPluginRegistry";
import {
  createLocalPluginRuntime,
  type LocalPluginRuntime,
} from "~/localPlugins/localPluginRuntime";
import {
  decodeLocalPluginStorageDocument,
  encodeLocalPluginStorageDocument,
  type LocalPluginStorage,
  type LocalPluginStorageCompareAndSwapInput,
  type LocalPluginStorageCompareAndSwapResult,
} from "~/localPlugins/localPluginStorage";
import { setCurrentLanguage } from "~/i18n/runtime";
import { LocalPluginsSettings, installLocalPluginJson } from "./LocalPluginsSettings";

class MemoryStorage implements LocalPluginStorage {
  constructor(public value: string | null = null) {}
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

class ObservableMemoryStorage extends MemoryStorage {
  private listener: (() => void) | null = null;

  subscribe(listener: () => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  emit(): void {
    this.listener?.();
  }
}

const pluginManifest: LocalPluginManifest = {
  manifestVersion: 1,
  apiVersion: { major: 1, minor: 0 },
  id: "acme.settings",
  name: "设置插件",
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
};

function createRuntime(): LocalPluginRuntime {
  const registry = new LocalPluginRegistry();
  const failures = new LocalPluginFailureJournal({
    now: () => 1,
    makeId: (sequence) => `failure-${sequence}`,
  });
  const lifecycle = new LocalPluginLifecycle({
    registry,
    failures,
    storage: new MemoryStorage(),
    now: () => 1,
  });
  return {
    failures,
    lifecycle,
    registry,
    restoreResult: { ok: true },
    lastSynchronizeResult: null,
    storageStatus: {
      getSnapshot: () => ({ phase: "restore", result: { ok: true } }),
      subscribe: () => () => undefined,
    },
    dispose: () => undefined,
  };
}

function storedPlugin(id: string) {
  return {
    manifest: { ...pluginManifest, id },
    enabled: true,
    installedAtUnixMs: 1,
    updatedAtUnixMs: 1,
  } as const;
}

describe("LocalPluginsSettings", () => {
  beforeEach(() => setCurrentLanguage("en", false));

  it("渲染空态和 JSON 导入入口", () => {
    const html = renderToStaticMarkup(<LocalPluginsSettings runtime={createRuntime()} />);

    expect(html).toContain("Local plugins");
    expect(html).toContain("Import manifest");
    expect(html).toContain("No local plugins installed");
    expect(html).toContain('accept=".json,application/json"');
  });

  it("渲染插件版本、权限、贡献计数、启停和删除入口", async () => {
    const runtime = createRuntime();
    await runtime.lifecycle.install(pluginManifest);

    const html = renderToStaticMarkup(<LocalPluginsSettings runtime={runtime} />);
    const pluginCardClasses =
      html.match(/<div class="([^"]+)" data-local-plugin-id="acme\.settings"/)?.[1]?.split(" ") ??
      [];

    expect(html).toContain('data-local-plugin-id="acme.settings"');
    expect(pluginCardClasses).toContain("rounded-lg");
    expect(pluginCardClasses).not.toContain("rounded-xl");
    expect(html).toContain("设置插件");
    expect(html).toContain("1.0.0");
    expect(html).toContain("composer.prompt.write");
    expect(html).toContain("1 command");
    expect(html).toContain('data-local-plugin-toggle="acme.settings"');
    expect(html).toContain('data-local-plugin-remove="acme.settings"');
  });

  it("展示单插件最新失败，并允许清理失败记录", async () => {
    const runtime = createRuntime();
    await runtime.lifecycle.install(pluginManifest);
    runtime.failures.record({
      pluginId: "acme.settings",
      phase: "invoke",
      code: "contribution-invoke-failed",
      contributionKind: "commands",
      contributionId: "insert",
      error: new Error("执行失败"),
    });

    const html = renderToStaticMarkup(<LocalPluginsSettings runtime={runtime} />);

    expect(html).toContain('data-local-plugin-failure="failure-1"');
    expect(html).toContain("The plugin action could not be completed");
    expect(html).not.toContain("执行失败");
    expect(html).toContain("Clear failures");
  });

  it("恢复失败只按类型化代码持续告警，清理 journal 不隐藏写保护", () => {
    const storage = new ObservableMemoryStorage();
    const duplicate = storedPlugin("acme.raw-secret");
    storage.value = JSON.stringify({ version: 1, plugins: [duplicate, duplicate] });
    const runtime = createLocalPluginRuntime({ storage, now: () => 1, writerId: "writer-a" });

    let html = renderToStaticMarkup(<LocalPluginsSettings runtime={runtime} />);

    expect(html).toContain('data-local-plugin-storage-failure="storage-duplicate-id"');
    expect(html).toContain("Stored local plugin data contains duplicate plugin IDs");
    expect(html).not.toContain("acme.raw-secret");

    runtime.failures.clear();
    html = renderToStaticMarkup(<LocalPluginsSettings runtime={runtime} />);
    expect(html).toContain('data-local-plugin-storage-failure="storage-duplicate-id"');
  });

  it("有效外部文档修复后清除恢复告警", () => {
    const storage = new ObservableMemoryStorage();
    const duplicate = storedPlugin("acme.duplicate");
    storage.value = JSON.stringify({ version: 1, plugins: [duplicate, duplicate] });
    const runtime = createLocalPluginRuntime({ storage, now: () => 1, writerId: "writer-a" });
    storage.value = encodeLocalPluginStorageDocument([], {
      revision: 1,
      writerId: "writer-b",
    });

    storage.emit();

    const html = renderToStaticMarkup(<LocalPluginsSettings runtime={runtime} />);
    expect(html).not.toContain("data-local-plugin-storage-failure");
    expect(html).not.toContain("Stored local plugin data contains duplicate plugin IDs");
  });

  it("展示同步期非法文档与修订冲突的当前类型化状态", () => {
    const invalidStorage = new ObservableMemoryStorage();
    const invalidRuntime = createLocalPluginRuntime({
      storage: invalidStorage,
      now: () => 1,
      writerId: "writer-a",
    });
    const duplicate = storedPlugin("acme.duplicate");
    invalidStorage.value = JSON.stringify({ version: 1, plugins: [duplicate, duplicate] });
    invalidStorage.emit();

    const invalidHtml = renderToStaticMarkup(<LocalPluginsSettings runtime={invalidRuntime} />);
    expect(invalidHtml).toContain('data-local-plugin-storage-phase="synchronize"');
    expect(invalidHtml).toContain('data-local-plugin-storage-failure="storage-duplicate-id"');

    const conflictStorage = new ObservableMemoryStorage(
      encodeLocalPluginStorageDocument([storedPlugin("acme.one")], {
        revision: 2,
        writerId: "writer-a",
      }),
    );
    const conflictRuntime = createLocalPluginRuntime({
      storage: conflictStorage,
      now: () => 1,
      writerId: "writer-a",
    });
    conflictStorage.value = encodeLocalPluginStorageDocument([storedPlugin("acme.two")], {
      revision: 1,
      writerId: "writer-b",
    });
    conflictStorage.emit();

    const conflictHtml = renderToStaticMarkup(<LocalPluginsSettings runtime={conflictRuntime} />);
    expect(conflictHtml).toContain('data-local-plugin-storage-failure="storage-conflict"');
    expect(conflictHtml).toContain("Local plugin settings changed in another tab");
  });

  it("导入函数区分非法 JSON 与策略拒绝", async () => {
    const runtime = createRuntime();

    expect(await installLocalPluginJson(runtime, "not-json")).toMatchObject({
      ok: false,
      error: { code: "invalid-json" },
    });
    expect(
      await installLocalPluginJson(runtime, JSON.stringify({ ...pluginManifest, permissions: [] })),
    ).toMatchObject({ ok: false, error: { code: "manifest-invalid" } });
    expect(await installLocalPluginJson(runtime, JSON.stringify(pluginManifest))).toEqual({
      ok: true,
    });
  });
});
