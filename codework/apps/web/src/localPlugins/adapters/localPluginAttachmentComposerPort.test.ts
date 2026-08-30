import { describe, expect, it, vi } from "vite-plus/test";

import type { ComposerHandleRef } from "~/composerHandleContext";
import { addFilesToLocalPluginComposer } from "./localPluginAttachmentComposerPort";

function composerRef(
  addDroppedFiles: ((files: File[]) => Promise<boolean>) | null,
): ComposerHandleRef {
  return {
    current:
      addDroppedFiles === null
        ? null
        : ({ addDroppedFiles } as unknown as ComposerHandleRef["current"]),
  };
}

describe("localPluginAttachmentComposerPort", () => {
  it("Composer 宿主不存在时返回 false", async () => {
    await expect(
      addFilesToLocalPluginComposer(composerRef(null), [
        new File(["image"], "diagram.png", { type: "image/png" }),
      ]),
    ).resolves.toBe(false);
  });

  it("等待 Composer 异步写入并返回真实结果", async () => {
    const addDroppedFiles = vi.fn(async () => true);
    const file = new File(["image"], "diagram.png", { type: "image/png" });

    await expect(addFilesToLocalPluginComposer(composerRef(addDroppedFiles), [file])).resolves.toBe(
      true,
    );
    expect(addDroppedFiles).toHaveBeenCalledWith([file]);
  });

  it("Composer 异步失败时把异常交给 contribution isolation", async () => {
    const addDroppedFiles = vi.fn(async () => {
      throw new Error("compression failed");
    });

    await expect(
      addFilesToLocalPluginComposer(composerRef(addDroppedFiles), [
        new File(["image"], "diagram.png", { type: "image/png" }),
      ]),
    ).rejects.toThrow("compression failed");
  });
});
