import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { setCurrentLanguage } from "~/i18n/runtime";
import { SettingsBreadcrumb } from "./SettingsBreadcrumb";

describe("SettingsBreadcrumb", () => {
  beforeEach(() => setCurrentLanguage("en", false));

  it("为本地插件独立设置页显示本地化层级", () => {
    const html = renderToStaticMarkup(<SettingsBreadcrumb pathname="/settings/local-plugins" />);

    expect(html).toContain(">Settings<");
    expect(html).toContain('aria-current="page"');
    expect(html).toContain(">Local plugins<");
  });
});
