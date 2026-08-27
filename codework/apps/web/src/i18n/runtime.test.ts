import { afterEach, describe, expect, it } from "vite-plus/test";

import { setCurrentLanguage, t } from "./runtime";

afterEach(() => setCurrentLanguage("zh-CN"));

describe("web i18n runtime", () => {
  it("switches languages and interpolates complete messages", () => {
    setCurrentLanguage("en");
    expect(t("composer.promptTooLong", { count: 2, excess: 2, limit: 120_000 })).toBe(
      "Prompt is 2 characters over the 120000-character limit. Shorten or split it before sending.",
    );

    setCurrentLanguage("zh-CN");
    expect(t("composer.promptTooLong", { count: 2, excess: 2, limit: 120_000 })).toBe(
      "提示词超出 120000 字符限制 2 个字符。请缩短内容或拆分后再发送。",
    );
  });
});
