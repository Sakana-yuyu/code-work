import { describe, expect, it } from "vite-plus/test";

import {
  localPluginWorkspacePanelSurface,
  parseLocalPluginWorkspacePanelSurface,
} from "./localPluginWorkspacePanelSurface";

describe("localPluginWorkspacePanelSurface", () => {
  it("为每个插件面板生成稳定且可恢复的 surface", () => {
    const surface = localPluginWorkspacePanelSurface("acme.workspace", "overview");

    expect(surface).toEqual({
      id: "plugin:acme.workspace:overview",
      kind: "plugin",
      pluginId: "acme.workspace",
      contributionId: "overview",
    });
    expect(parseLocalPluginWorkspacePanelSurface(surface)).toEqual(surface);
  });

  it("拒绝标识不合法、字段缺失或 ID 不匹配的持久化 surface", () => {
    expect(
      parseLocalPluginWorkspacePanelSurface({
        id: "plugin:acme.workspace:overview",
        kind: "plugin",
        pluginId: "Bad Plugin",
        contributionId: "overview",
      }),
    ).toBeNull();
    expect(
      parseLocalPluginWorkspacePanelSurface({
        id: "plugin:acme.workspace:other",
        kind: "plugin",
        pluginId: "acme.workspace",
        contributionId: "overview",
      }),
    ).toBeNull();
    expect(parseLocalPluginWorkspacePanelSurface({ kind: "plugin" })).toBeNull();
  });
});
