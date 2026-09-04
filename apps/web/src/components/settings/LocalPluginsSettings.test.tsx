import type { LocalPluginManifest } from "@codework/contracts";
// @effect-diagnostics nodeBuiltinImport:off - 静态约束测试必须读取规范 CSS 中的设计令牌。
import * as NodeFS from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
import { LOCAL_PLUGIN_CATALOG } from "~/localPlugins/localPluginCatalog";
import {
  LocalPluginsSettings,
  installLocalPluginJson,
  resolveLocalPluginStoreButtonState,
} from "./LocalPluginsSettings";

class MemoryStorage implements LocalPluginStorage {
  compareAndSwapError: Error | null = null;

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
    if (this.compareAndSwapError) throw this.compareAndSwapError;
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

function createRuntime(storage: LocalPluginStorage = new MemoryStorage()): LocalPluginRuntime {
  const registry = new LocalPluginRegistry();
  const failures = new LocalPluginFailureJournal({
    now: () => 1,
    makeId: (sequence) => `failure-${sequence}`,
  });
  const lifecycle = new LocalPluginLifecycle({
    registry,
    failures,
    storage,
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

function resolveThemeRadiusPx(css: string, className: string): number {
  const radiusName = className.match(/^rounded-(.+)$/)?.[1];
  if (!radiusName) throw new Error(`无法从类名 ${className} 解析圆角 token。`);
  const baseMatch = css.match(/--radius:\s*([\d.]+)rem;/);
  if (!baseMatch) throw new Error("未找到基础圆角 token。");
  const tokenMatch = css.match(new RegExp(`--radius-${radiusName}:\\s*([^;]+);`));
  if (!tokenMatch) throw new Error(`未找到 --radius-${radiusName}。`);
  const basePx = Number(baseMatch[1]) * 16;
  const expression = tokenMatch[1]?.trim();
  if (expression === "var(--radius)") return basePx;
  const calculated = expression?.match(/^calc\(var\(--radius\) ([+-]) ([\d.]+)px\)$/);
  if (!calculated) throw new Error(`无法计算 --radius-${radiusName}: ${expression ?? ""}。`);
  const offset = Number(calculated[2]);
  return calculated[1] === "+" ? basePx + offset : basePx - offset;
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
    const radiusClass = pluginCardClasses.find((className) =>
      /^rounded-[a-z0-9]+$/.test(className),
    );
    const indexCss = NodeFS.readFileSync(new URL("../../index.css", import.meta.url), "utf8");

    expect(html).toContain('data-local-plugin-id="acme.settings"');
    expect(radiusClass).toBeDefined();
    expect(resolveThemeRadiusPx(indexCss, radiusClass ?? "")).toBeLessThanOrEqual(8);
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

  it.each(["enable", "disable", "uninstall"] as const)(
    "失败日志订阅者异常不改变 %s 的类型化结果与本地化反馈",
    async (operation) => {
      const storage = new MemoryStorage();
      const runtime = createRuntime(storage);
      await runtime.lifecycle.install(pluginManifest);
      if (operation === "enable") {
        expect(await runtime.lifecycle.disable(pluginManifest.id)).toEqual({ ok: true });
      }
      const throwingListener = vi.fn(() => {
        throw new Error("listener failed");
      });
      const healthyListener = vi.fn();
      runtime.failures.subscribe(throwingListener);
      runtime.failures.subscribe(healthyListener);
      storage.compareAndSwapError = new Error("storage unavailable");

      await expect(runtime.lifecycle[operation](pluginManifest.id)).resolves.toMatchObject({
        ok: false,
        error: { code: "storage-write-failed" },
      });

      const html = renderToStaticMarkup(<LocalPluginsSettings runtime={runtime} />);
      expect(html).toContain('data-local-plugin-failure="failure-1"');
      expect(html).toContain("Local plugin settings could not be saved.");
      expect(html).not.toContain("storage unavailable");
      expect(throwingListener).toHaveBeenCalledTimes(1);
      expect(healthyListener).toHaveBeenCalledTimes(1);
    },
  );

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

  it("展示同步期类型化状态，并在同标签成功重试后清除告警", async () => {
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
    expect(conflictHtml).not.toContain("检测到本地插件存储修订冲突");

    expect(await conflictRuntime.lifecycle.install(pluginManifest)).toEqual({ ok: true });
    const recoveredHtml = renderToStaticMarkup(<LocalPluginsSettings runtime={conflictRuntime} />);
    expect(recoveredHtml).not.toContain("data-local-plugin-storage-failure");
    expect(recoveredHtml).not.toContain("Local plugin settings changed in another tab");
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

describe("LocalPluginsSettings 插件商店", () => {
  beforeEach(() => setCurrentLanguage("en", false));

  const gitCommands = LOCAL_PLUGIN_CATALOG.find(
    (item) => item.entry.id === "codework.git-commands",
  );
  if (!gitCommands) throw new Error("目录缺少 codework.git-commands");

  it("渲染商店区块、全部目录卡片与三态按钮（未装→安装）", () => {
    const html = renderToStaticMarkup(<LocalPluginsSettings runtime={createRuntime()} />);

    expect(html).toContain("Plugin store");
    for (const item of LOCAL_PLUGIN_CATALOG) {
      expect(html).toContain(`data-local-plugin-store-card="${item.entry.id}"`);
      expect(html).toContain(`data-local-plugin-store-state="install"`);
      expect(html).toContain(item.entry.name);
      expect(html).toContain(`v${item.entry.version}`);
    }
    expect(html).toContain("Command palette helpers for standardized commit messages");
  });

  it("三态解析：同版本→已安装禁用，本地更旧→更新", () => {
    expect(resolveLocalPluginStoreButtonState(undefined, "1.0.0")).toBe("install");
    expect(resolveLocalPluginStoreButtonState("1.0.0", "1.0.0")).toBe("installed");
    expect(resolveLocalPluginStoreButtonState("0.9.0", "1.0.0")).toBe("update");
    expect(resolveLocalPluginStoreButtonState("1.1.0", "1.0.0")).toBe("installed");
  });

  it("已装同版本显示禁用按钮，已装旧版本显示更新", async () => {
    const runtime = createRuntime();
    await runtime.lifecycle.install(gitCommands.entry);
    const sameVersionHtml = renderToStaticMarkup(<LocalPluginsSettings runtime={runtime} />);
    const sameVersionMatch = sameVersionHtml.match(actionPatternFor("codework.git-commands"));
    expect(sameVersionMatch?.[1]).toBe("installed");
    // 禁用态：按钮标签带 disabled 属性（同一段标签内）。
    const installedButtonTag = sameVersionHtml.match(
      /<button[^>]*data-local-plugin-store-action="codework\.git-commands"[^>]*>/,
    )?.[0];
    expect(installedButtonTag).toContain("disabled");

    const olderRuntime = createRuntime();
    await olderRuntime.lifecycle.install({ ...gitCommands.entry, version: "0.9.0" });
    const olderHtml = renderToStaticMarkup(<LocalPluginsSettings runtime={olderRuntime} />);
    expect(olderHtml.match(actionPatternFor("codework.git-commands"))?.[1]).toBe("update");
  });

  it("从商店安装后 registry 出现该插件（与导入共用 install 管线）", async () => {
    const runtime = createRuntime();
    expect(await runtime.lifecycle.install(gitCommands.entry)).toEqual({ ok: true });

    const html = renderToStaticMarkup(<LocalPluginsSettings runtime={runtime} />);
    expect(html).toContain('data-local-plugin-id="codework.git-commands"');
    expect(html.match(actionPatternFor("codework.git-commands"))?.[1]).toBe("installed");
  });

  it("安装失败的目录插件在商店区块展示类型化失败并可清理", async () => {
    const runtime = createRuntime();
    // 版本号非法 → install 被策略拒绝并记入 journal，插件不会出现在已装列表。
    expect(
      await runtime.lifecycle.install({ ...gitCommands.entry, version: "not-a-version" }),
    ).toMatchObject({ ok: false, error: { code: "schema-invalid" } });

    const html = renderToStaticMarkup(<LocalPluginsSettings runtime={runtime} />);
    expect(html).toContain('data-local-plugin-store-failure="failure-1"');
    expect(html).not.toContain('data-local-plugin-id="codework.git-commands"');

    runtime.failures.clear();
    const clearedHtml = renderToStaticMarkup(<LocalPluginsSettings runtime={runtime} />);
    expect(clearedHtml).not.toContain("data-local-plugin-store-failure");
  });

  it("已装插件的失败只出现在已安装区块，不在商店区块重复", async () => {
    const runtime = createRuntime();
    await runtime.lifecycle.install(gitCommands.entry);
    runtime.failures.record({
      pluginId: "codework.git-commands",
      phase: "invoke",
      code: "contribution-invoke-failed",
      contributionKind: "commands",
      contributionId: "commit-message",
      error: new Error("执行失败"),
    });

    const html = renderToStaticMarkup(<LocalPluginsSettings runtime={runtime} />);
    expect(html).not.toContain("data-local-plugin-store-failure");
    expect(html).toContain('data-local-plugin-failure="failure-1"');
  });
});

function actionPatternFor(id: string): RegExp {
  return new RegExp(
    `<button[^>]*data-local-plugin-store-action="${id}"[^>]*data-local-plugin-store-state="([a-z]+)"`,
  );
}
