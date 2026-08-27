import { afterEach, describe, expect, it } from "vite-plus/test";

import { setCurrentLanguage, t } from "./runtime";

afterEach(() => setCurrentLanguage("zh-CN"));

describe("mobile i18n runtime", () => {
  it("switches languages and interpolates placeholders", () => {
    setCurrentLanguage("en");
    expect(t("interface.value-agent", { value1: 3 })).toBe("3 agent");

    setCurrentLanguage("zh-CN");
    expect(t("interface.value-agent", { value1: 3 })).toBe("3 Agent");
  });
});
