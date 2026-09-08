import { afterEach, describe, expect, it } from "vite-plus/test";

import { setCurrentLanguage, t } from "./runtime";

afterEach(() => setCurrentLanguage("zh-CN"));

describe("mobile i18n runtime", () => {
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

  it("switches languages and interpolates placeholders", () => {
    setCurrentLanguage("en");
    expect(t("interface.value-agent", { value1: 3 })).toBe("3 agent");

    setCurrentLanguage("zh-CN");
    expect(t("interface.value-agent", { value1: 3 })).toBe("3 Agent");
  });

  it("translates every Squad execution history status", () => {
    setCurrentLanguage("en");
    expect(t("squadExecutionHistory.title")).toBe("Squad execution history");
    expect(
      [
        "queued",
        "planning",
        "awaitingApproval",
        "running",
        "inReview",
        "paused",
        "cancelling",
        "completed",
        "failed",
        "cancelled",
      ].map((status) => t(`squadExecutionHistory.status.${status}`)),
    ).toEqual([
      "Queued",
      "Planning",
      "Awaiting approval",
      "Running",
      "In review",
      "Paused",
      "Cancelling",
      "Completed",
      "Failed",
      "Cancelled",
    ]);

    setCurrentLanguage("zh-CN");
    expect(t("squadExecutionHistory.title")).toBe("Squad 执行历史");
    expect(
      [
        "queued",
        "planning",
        "awaitingApproval",
        "running",
        "inReview",
        "paused",
        "cancelling",
        "completed",
        "failed",
        "cancelled",
      ].map((status) => t(`squadExecutionHistory.status.${status}`)),
    ).toEqual([
      "排队中",
      "规划中",
      "等待审批",
      "运行中",
      "审查中",
      "已暂停",
      "正在取消",
      "已完成",
      "失败",
      "已取消",
    ]);
  });
});
