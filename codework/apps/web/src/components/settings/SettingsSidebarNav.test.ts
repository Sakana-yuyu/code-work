import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_NAV_ITEMS } from "./SettingsSidebarNav";

describe("SETTINGS_NAV_ITEMS", () => {
  it("包含本地插件独立设置入口", () => {
    expect(SETTINGS_NAV_ITEMS.find((item) => item.to === "/settings/local-plugins")).toMatchObject({
      label: "localPlugins.title",
      to: "/settings/local-plugins",
    });
  });
});
