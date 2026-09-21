import { afterEach, describe, expect, it } from "vite-plus/test";

import { setDesktopLanguageOverride, t } from "./i18n.js";

describe("desktop i18n language override", () => {
  afterEach(() => {
    setDesktopLanguageOverride(null);
  });

  it("prefers the pushed app language over the OS locale", () => {
    setDesktopLanguageOverride("zh-CN");
    expect(t("pick.describeChange")).toBe("描述要做的修改…");
    expect(t("pick.attach")).toBe("附加");
  });

  it("follows the latest pushed language", () => {
    setDesktopLanguageOverride("zh-CN");
    setDesktopLanguageOverride("ja");
    expect(t("pick.attach")).toBe("添付");
  });

  it("falls back to OS-locale resolution when cleared", () => {
    setDesktopLanguageOverride("en");
    expect(t("pick.attach")).toBe("Attach");
    setDesktopLanguageOverride(null);
    // Whatever the OS reports, the key must resolve to a catalog string.
    expect(t("pick.attach").length).toBeGreaterThan(0);
  });

  it("interpolates params in the override language", () => {
    setDesktopLanguageOverride("zh-CN");
    expect(t("pick.colorValueAria", { label: "文字颜色" })).toBe("文字颜色值");
  });
});
