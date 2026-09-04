import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_NAV_ITEMS } from "./SettingsSidebarNav";
import { SETTINGS_SECTION_LABELS } from "./settingsSearch";
import { t } from "~/i18n";

describe("SETTINGS_NAV_ITEMS", () => {
  it("包含本地插件独立设置入口", () => {
    expect(SETTINGS_NAV_ITEMS.find((item) => item.to === "/settings/local-plugins")).toMatchObject({
      label: "localPlugins.title",
      to: "/settings/local-plugins",
    });
  });

  it("以“团队”命名团队入口且仍指向 /settings/squads", () => {
    expect(SETTINGS_NAV_ITEMS.find((item) => item.to === "/settings/squads")).toMatchObject({
      label: "settings.squads",
      to: "/settings/squads",
    });
    expect(t("settings.squads")).toBe("AI 团队");
    expect(t(SETTINGS_SECTION_LABELS["/settings/squads"])).toBe(t("settings.squads"));
  });

  it("导航可见文案不出现 Multica", () => {
    const labels = SETTINGS_NAV_ITEMS.map((item) => t(item.label));
    for (const label of labels) {
      expect(label.toLowerCase()).not.toContain("multica");
    }
  });
});
