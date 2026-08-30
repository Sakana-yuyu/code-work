import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { setCurrentLanguage } from "~/i18n/runtime";

vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: vi.fn() },
}));

import { toastManager } from "~/components/ui/toast";
import { notifyLocalPluginCommandFailure } from "./useLocalPluginCommandPaletteItems";

describe("本地插件命令 Palette 反馈", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCurrentLanguage("en", false);
  });

  it("命令失败只按稳定错误码展示，不直出原始异常", () => {
    notifyLocalPluginCommandFailure({
      id: "failure-1",
      pluginId: "acme.commands",
      phase: "invoke",
      code: "contribution-invoke-failed",
      message: "原始中文异常",
      occurredAtUnixMs: 1,
    });

    expect(toastManager.add).toHaveBeenCalledWith({
      type: "error",
      title: "Plugin command failed",
      description: "The plugin action could not be completed.",
    });
    expect(toastManager.add).not.toHaveBeenCalledWith(
      expect.objectContaining({ description: "原始中文异常" }),
    );
  });
});
