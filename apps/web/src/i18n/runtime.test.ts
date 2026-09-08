import { afterEach, describe, expect, it } from "vite-plus/test";

import { en, zhCN } from "./messages";
import { setCurrentLanguage, t } from "./runtime";

afterEach(() => setCurrentLanguage("zh-CN"));

// 内部代号不允许出现在面向用户的文案里（详见设置页第一眼测试标准 2）。
const INTERNAL_CODENAMES = /cursor-byok|cursor byok|\btcode\b/i;

describe("web i18n runtime", () => {
  it("插值 BYOK 轮次上限错误", () => {
    for (const language of ["zh-CN", "en", "ja"] as const) {
      setCurrentLanguage(language);
      const message = t("session.byokMaxRoundsReached", { maxRounds: 8 });
      expect(message).toContain("8");
      expect(message).not.toContain("{");
    }
  });

  it("翻译运行中的运行器切换错误", () => {
    for (const [language, expected] of [
      [
        "en",
        "Cannot switch providers while a turn is running. Wait for it to finish or stop it first.",
      ],
      ["zh-CN", "当前任务正在运行，无法切换运行器。请等待完成或先停止后再切换。"],
      [
        "ja",
        "タスクの実行中はランタイムを切り替えられません。完了するまで待つか、先に停止してください。",
      ],
    ] as const) {
      setCurrentLanguage(language);
      expect(t("session.cannotSwitchProvidersWhileRunning")).toBe(expected);
    }
  });

  it("按当前语言插值模型选择器的供应商限制提示", () => {
    for (const [language, expected] of [
      [
        "en",
        "The current task is running. Wait for it to finish or stop it before switching to Codex Personal.",
      ],
      ["zh-CN", "当前任务正在运行。请等待完成或先停止，再切换到 Codex Personal 运行器。"],
      [
        "ja",
        "現在タスクを実行中です。完了するまで待つか停止してから、Codex Personal ランタイムに切り替えてください。",
      ],
    ] as const) {
      setCurrentLanguage(language);
      expect(t("modelPicker.providerUnavailableInThread", { providerName: "Codex Personal" })).toBe(
        expected,
      );
    }
  });

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
