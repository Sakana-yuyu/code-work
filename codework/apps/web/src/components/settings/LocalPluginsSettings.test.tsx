import type { LocalPluginManifest } from "@codework/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { LocalPluginFailureJournal } from "~/localPlugins/localPluginFailureJournal";
import { LocalPluginLifecycle } from "~/localPlugins/localPluginLifecycle";
import { LocalPluginRegistry } from "~/localPlugins/localPluginRegistry";
import type { LocalPluginRuntime } from "~/localPlugins/localPluginRuntime";
import type { LocalPluginStorage } from "~/localPlugins/localPluginStorage";
import { setCurrentLanguage } from "~/i18n/runtime";
import { LocalPluginsSettings, installLocalPluginJson } from "./LocalPluginsSettings";

class MemoryStorage implements LocalPluginStorage {
  value: string | null = null;
  read(): string | null {
    return this.value;
  }
  write(value: string): void {
    this.value = value;
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
  return { failures, lifecycle, registry };
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

  it("渲染插件版本、权限、贡献计数、启停和删除入口", () => {
    const runtime = createRuntime();
    runtime.lifecycle.install(pluginManifest);

    const html = renderToStaticMarkup(<LocalPluginsSettings runtime={runtime} />);

    expect(html).toContain('data-local-plugin-id="acme.settings"');
    expect(html).toContain("设置插件");
    expect(html).toContain("1.0.0");
    expect(html).toContain("composer.prompt.write");
    expect(html).toContain("1 command");
    expect(html).toContain('data-local-plugin-toggle="acme.settings"');
    expect(html).toContain('data-local-plugin-remove="acme.settings"');
  });

  it("展示单插件最新失败，并允许清理失败记录", () => {
    const runtime = createRuntime();
    runtime.lifecycle.install(pluginManifest);
    runtime.failures.record({
      pluginId: "acme.settings",
      phase: "invoke",
      contributionKind: "commands",
      contributionId: "insert",
      error: new Error("执行失败"),
    });

    const html = renderToStaticMarkup(<LocalPluginsSettings runtime={runtime} />);

    expect(html).toContain('data-local-plugin-failure="failure-1"');
    expect(html).toContain("执行失败");
    expect(html).toContain("Clear failures");
  });

  it("导入函数区分非法 JSON 与策略拒绝", () => {
    const runtime = createRuntime();

    expect(installLocalPluginJson(runtime, "not-json")).toMatchObject({
      ok: false,
      error: { code: "invalid-json" },
    });
    expect(
      installLocalPluginJson(runtime, JSON.stringify({ ...pluginManifest, permissions: [] })),
    ).toMatchObject({ ok: false, error: { code: "manifest-invalid" } });
    expect(installLocalPluginJson(runtime, JSON.stringify(pluginManifest))).toEqual({ ok: true });
  });
});
