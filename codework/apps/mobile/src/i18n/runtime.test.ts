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
