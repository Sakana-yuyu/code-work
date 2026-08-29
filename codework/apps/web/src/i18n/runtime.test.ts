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

  it("translates persisted Squad execution history states and enrichment errors", () => {
    setCurrentLanguage("en");
    expect(t("squadRun.status.planning")).toBe("Planning");
    expect(t("squadRun.status.awaiting_approval")).toBe("Awaiting approval");
    expect(t("squadRun.status.paused")).toBe("Paused");
    expect(t("squadRun.status.cancelling")).toBe("Cancelling");
    expect(t("squadRun.historyEnrichmentFailed", { message: "offline" })).toBe(
      "Task details could not be loaded: offline",
    );

    setCurrentLanguage("zh-CN");
    expect(t("squadRun.status.planning")).toBe("规划中");
    expect(t("squadRun.status.awaiting_approval")).toBe("等待审批");
    expect(t("squadRun.status.paused")).toBe("已暂停");
    expect(t("squadRun.status.cancelling")).toBe("正在取消");
    expect(t("squadRun.historyEnrichmentFailed", { message: "离线" })).toBe(
      "无法加载任务详情：离线",
    );
  });
});
