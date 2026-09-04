import { describe, expect, it } from "vite-plus/test";

import { controlInvalidatesScreenshot } from "./ThreadPreviewRouteScreen.logic";

describe("移动端预览截图状态", () => {
  it("在画面可能变化后要求重新截图", () => {
    for (const control of [
      "back",
      "hardReload",
      "captureScreenshot",
      "setColorScheme",
      "click",
      "type",
      "press",
      "scroll",
    ] as const) {
      expect(controlInvalidatesScreenshot(control)).toBe(true);
    }
  });

  it("不改变预览画面的桌面窗口操作保留当前截图", () => {
    for (const control of ["openDevTools", "startRecording", "openInSystemBrowser"] as const) {
      expect(controlInvalidatesScreenshot(control)).toBe(false);
    }
  });
});
