import { describe, expect, it } from "vite-plus/test";

import { en, zhCN } from "~/i18n/messages";
import { decodeAllowedLocalPluginManifest } from "~/localPlugins/localPluginPolicy";
import { LOCAL_PLUGIN_CATALOG } from "./localPluginCatalog";

describe("localPluginCatalog", () => {
  it("目录里的每一项都能通过安装管线的完整策略校验", () => {
    expect(LOCAL_PLUGIN_CATALOG.length).toBeGreaterThan(0);
    for (const item of LOCAL_PLUGIN_CATALOG) {
      expect(() => decodeAllowedLocalPluginManifest(item.entry)).not.toThrow();
    }
  });

  it("插件 id 不重复，summary 键在双语目录中都存在", () => {
    const ids = LOCAL_PLUGIN_CATALOG.map((item) => item.entry.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const item of LOCAL_PLUGIN_CATALOG) {
      expect(en[item.summaryKey]).toEqual(expect.any(String));
      expect(zhCN[item.summaryKey]).toEqual(expect.any(String));
      expect(en[item.summaryKey]).not.toBe("");
      expect(zhCN[item.summaryKey]).not.toBe("");
    }
  });

  it("精选目录覆盖全部四种贡献类型", () => {
    const kinds = new Set<string>();
    for (const item of LOCAL_PLUGIN_CATALOG) {
      const { contributions } = item.entry;
      if (contributions.workspacePanels) kinds.add("workspacePanels");
      if (contributions.commands) kinds.add("commands");
      if (contributions.timeline) kinds.add("timeline");
      if (contributions.attachments) kinds.add("attachments");
    }
    expect([...kinds].sort()).toEqual(["attachments", "commands", "timeline", "workspacePanels"]);
  });

  it("每个插件只申请它真正用到的权限", () => {
    for (const item of LOCAL_PLUGIN_CATALOG) {
      const used = new Set<string>();
      const { contributions, permissions } = item.entry;
      for (const command of contributions.commands ?? []) {
        if (command.action.type === "clipboard.write") {
          used.add("clipboard.write");
          if (command.action.text.includes("{{workspace.")) used.add("workspace.read");
        }
        if (command.action.type === "composer.prompt.insert") used.add("composer.prompt.write");
        if (command.action.type === "timeline.post") used.add("timeline.write");
      }
      if (contributions.workspacePanels?.some((panel) => (panel.context?.length ?? 0) > 0)) {
        used.add("workspace.read");
      }
      if (contributions.attachments) {
        used.add("composer.attachment.add");
        if (contributions.attachments.some((attachment) => attachment.promptPrefix)) {
          used.add("composer.prompt.write");
        }
      }
      if (contributions.timeline) used.add("timeline.write");
      if (contributions.attachments) used.add("composer.attachment.add");

      for (const permission of permissions) {
        expect(used).toContain(permission);
      }
    }
  });
});
