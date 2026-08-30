import type { LocalPluginManifest } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import { LocalPluginRegistry } from "../localPluginRegistry";
import { localPluginWorkspacePanelSurface } from "./localPluginWorkspacePanelSurface";
import {
  listEnabledLocalPluginWorkspacePanels,
  resolveLocalPluginWorkspacePanel,
} from "./localPluginWorkspacePanelAdapter";

const manifest: LocalPluginManifest = {
  manifestVersion: 1,
  apiVersion: { major: 1, minor: 0 },
  id: "acme.workspace",
  name: "工作区助手",
  version: "1.0.0",
  permissions: ["workspace.read"],
  contributions: {
    workspacePanels: [
      {
        id: "overview",
        title: "工作区概览",
        description: "{{workspace.name}}",
        sections: [{ heading: "根目录", body: "{{workspace.root}}" }],
        context: ["workspace.name", "workspace.root"],
      },
    ],
  },
};

const registration = (enabled: boolean, permissions = manifest.permissions) => ({
  manifest: { ...manifest, permissions },
  enabled,
  installedAtUnixMs: 1,
  updatedAtUnixMs: 1,
});

describe("localPluginWorkspacePanelAdapter", () => {
  it("枚举启用面板并生成只读、已展开的视图模型", () => {
    const registry = new LocalPluginRegistry();
    registry.replace([registration(true)]);

    expect(listEnabledLocalPluginWorkspacePanels(registry)).toEqual([
      {
        surface: localPluginWorkspacePanelSurface("acme.workspace", "overview"),
        title: "工作区概览",
      },
    ]);
    expect(
      resolveLocalPluginWorkspacePanel({
        registry,
        surface: localPluginWorkspacePanelSurface("acme.workspace", "overview"),
        workspace: { name: "Code Work", root: "C:\\workspace\\code-work" },
      }),
    ).toEqual({
      ok: true,
      panel: {
        pluginId: "acme.workspace",
        pluginName: "工作区助手",
        pluginVersion: "1.0.0",
        title: "工作区概览",
        description: "Code Work",
        sections: [{ heading: "根目录", body: "C:\\workspace\\code-work" }],
      },
    });
  });

  it("把禁用、权限漂移和上下文缺失限制为当前面板失败", () => {
    const surface = localPluginWorkspacePanelSurface("acme.workspace", "overview");
    const registry = new LocalPluginRegistry();

    registry.replace([registration(false)]);
    expect(resolveLocalPluginWorkspacePanel({ registry, surface, workspace: null })).toMatchObject({
      ok: false,
      error: { message: "插件已禁用。" },
    });

    registry.replace([registration(true, [])]);
    expect(resolveLocalPluginWorkspacePanel({ registry, surface, workspace: null })).toMatchObject({
      ok: false,
      error: { message: "插件缺少 workspace.read 权限。" },
    });

    registry.replace([registration(true)]);
    expect(resolveLocalPluginWorkspacePanel({ registry, surface, workspace: null })).toMatchObject({
      ok: false,
      error: { message: "当前没有可用的工作区上下文" },
    });
  });
});
