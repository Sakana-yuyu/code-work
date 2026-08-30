import type { LocalPluginManifest } from "@codework/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { LocalPluginRegistry } from "./localPluginRegistry";

const plugin = (id: string, enabled: boolean) => ({
  manifest: {
    manifestVersion: 1,
    apiVersion: { major: 1, minor: 0 },
    id,
    name: id,
    version: "1.0.0",
    permissions: ["composer.prompt.write"],
    contributions: {
      commands: [
        {
          id: "insert",
          title: "插入",
          action: { type: "composer.prompt.insert", text: id },
        },
      ],
    },
  } satisfies LocalPluginManifest,
  enabled,
  installedAtUnixMs: 1,
  updatedAtUnixMs: 1,
});

describe("LocalPluginRegistry", () => {
  it("只枚举启用贡献，并按插件检查已声明权限", () => {
    const registry = new LocalPluginRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);

    registry.replace([plugin("acme.enabled", true), plugin("acme.disabled", false)]);

    expect(registry.listEnabled("commands").map((entry) => entry.pluginId)).toEqual([
      "acme.enabled",
    ]);
    expect(registry.hasPermission("acme.enabled", "composer.prompt.write")).toBe(true);
    expect(registry.hasPermission("acme.disabled", "composer.prompt.write")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("隔离订阅者异常，并继续发布已更新快照", () => {
    const registry = new LocalPluginRegistry();
    const throwingListener = vi.fn(() => {
      throw new Error("listener failed");
    });
    const healthyListener = vi.fn();
    registry.subscribe(throwingListener);
    registry.subscribe(healthyListener);

    expect(() => registry.replace([plugin("acme.enabled", true)])).not.toThrow();

    expect(registry.getSnapshot().plugins.map((entry) => entry.manifest.id)).toEqual([
      "acme.enabled",
    ]);
    expect(throwingListener).toHaveBeenCalledTimes(1);
    expect(healthyListener).toHaveBeenCalledTimes(1);
  });
});
