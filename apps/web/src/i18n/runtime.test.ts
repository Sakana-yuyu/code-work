import { afterEach, describe, expect, it } from "vite-plus/test";

import { en, zhCN } from "./messages";
import { setCurrentLanguage, t } from "./runtime";

afterEach(() => setCurrentLanguage("zh-CN"));

// 内部代号不允许出现在面向用户的文案里（详见设置页第一眼测试标准 2）。
const INTERNAL_CODENAMES = /cursor-byok|cursor byok|\btcode\b/i;

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

  it("keeps internal codenames out of user-facing copy in both catalogs", () => {
    for (const [catalogName, catalog] of [
      ["en", en],
      ["zh-CN", zhCN],
    ] as const) {
      const offending = Object.entries(catalog)
        .filter(([, value]) => INTERNAL_CODENAMES.test(value))
        .map(([key]) => `${catalogName}:${key}`);
      expect(offending).toEqual([]);
    }
  });

  it("translates the facilities hint and getting-started copy in both catalogs", () => {
    const keys = [
      "facilitiesGuide.emptyHint",
      "gettingStarted.title",
      "gettingStarted.addProvider",
      "gettingStarted.providerReady",
      "delegationWorkspace.openConnections",
      "delegationWorkspace.openByokSettings",
      "byokAdapters.empty",
      "byokAdapters.description",
      "facilitiesGuide.providers.pageDescription",
    ] as const;
    for (const [catalogName, catalog] of [
      ["en", en],
      ["zh-CN", zhCN],
    ] as const) {
      const missing = keys.filter((key) => !(key in catalog) || catalog[key]?.trim().length === 0);
      expect(`${catalogName}: ${missing.join(", ")}`).toBe(`${catalogName}: `);
    }
    expect(zhCN["gettingStarted.addProvider"]).toBe("添加供应商");
    expect(en["facilitiesGuide.emptyHint"]).toContain("tour");
  });
});
