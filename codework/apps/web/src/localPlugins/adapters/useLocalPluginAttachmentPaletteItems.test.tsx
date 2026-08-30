import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { setCurrentLanguage } from "~/i18n/runtime";

vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: vi.fn() },
}));

import { toastManager } from "~/components/ui/toast";
import { notifyLocalPluginAttachmentResult } from "./useLocalPluginAttachmentPaletteItems";

describe("本地插件附件 Palette 反馈", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCurrentLanguage("en", false);
  });

  it("附件已写入但提示词失败时显示避免重复附加的警告", () => {
    notifyLocalPluginAttachmentResult({
      ok: true,
      value: {
        status: "attachment-only",
        promptFailure: "prompt-rejected",
        acceptedFiles: ["diagram.png"],
        rejectedFiles: [],
      },
    });

    expect(toastManager.add).toHaveBeenCalledWith({
      type: "warning",
      title: "Attachment added without plugin prompt",
      description:
        "The files are already attached. Add the prompt manually instead of attaching them again.",
    });
  });
});
