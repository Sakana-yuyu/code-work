import { describe, expect, it, vi } from "vite-plus/test";

import type { ComposerHandleRef } from "~/composerHandleContext";
import { commitLocalPluginAttachmentToComposer } from "./localPluginAttachmentComposerPort";

function composerHandle(input: {
  readonly addDroppedFiles: (files: File[]) => Promise<boolean>;
  readonly insertTextAtEnd?: (text: string) => boolean;
}): NonNullable<ComposerHandleRef["current"]> {
  return {
    addDroppedFiles: input.addDroppedFiles,
    insertTextAtEnd: input.insertTextAtEnd ?? (() => true),
  } as unknown as NonNullable<ComposerHandleRef["current"]>;
}

function composerRef(current: ComposerHandleRef["current"]): ComposerHandleRef {
  return {
    current,
  };
}

describe("localPluginAttachmentComposerPort", () => {
  it("Composer 宿主不存在时返回 rejected", async () => {
    await expect(
      commitLocalPluginAttachmentToComposer(composerRef(null), {
        files: [new File(["image"], "diagram.png", { type: "image/png" })],
      }),
    ).resolves.toEqual({ status: "rejected" });
  });

  it("等待 Composer 异步写入并返回真实结果", async () => {
    const addDroppedFiles = vi.fn(async () => true);
    const file = new File(["image"], "diagram.png", { type: "image/png" });

    await expect(
      commitLocalPluginAttachmentToComposer(composerRef(composerHandle({ addDroppedFiles })), {
        files: [file],
      }),
    ).resolves.toEqual({ status: "complete" });
    expect(addDroppedFiles).toHaveBeenCalledWith([file]);
  });

  it("Composer 拒绝附件时返回 rejected", async () => {
    const addDroppedFiles = vi.fn(async () => false);

    await expect(
      commitLocalPluginAttachmentToComposer(composerRef(composerHandle({ addDroppedFiles })), {
        files: [new File(["image"], "diagram.png", { type: "image/png" })],
      }),
    ).resolves.toEqual({ status: "rejected" });
  });

  it("Composer 附件写入抛错时保留宿主错误", async () => {
    const error = new Error("compression failed");
    const addDroppedFiles = vi.fn(async () => {
      throw error;
    });

    await expect(
      commitLocalPluginAttachmentToComposer(composerRef(composerHandle({ addDroppedFiles })), {
        files: [new File(["image"], "diagram.png", { type: "image/png" })],
      }),
    ).resolves.toEqual({ status: "rejected", error });
  });

  it("附件成功但提示词被拒绝时返回 attachment-only", async () => {
    const addDroppedFiles = vi.fn(async () => true);
    const insertTextAtEnd = vi.fn(() => false);

    await expect(
      commitLocalPluginAttachmentToComposer(
        composerRef(composerHandle({ addDroppedFiles, insertTextAtEnd })),
        {
          files: [new File(["image"], "diagram.png", { type: "image/png" })],
          promptPrefix: "请结合附件分析：",
        },
      ),
    ).resolves.toEqual({ status: "attachment-only", reason: "prompt-rejected" });
  });

  it("附件成功但提示词写入抛错时返回 attachment-only", async () => {
    const addDroppedFiles = vi.fn(async () => true);
    const insertTextAtEnd = vi.fn(() => {
      throw new Error("editor unavailable");
    });

    await expect(
      commitLocalPluginAttachmentToComposer(
        composerRef(composerHandle({ addDroppedFiles, insertTextAtEnd })),
        {
          files: [new File(["image"], "diagram.png", { type: "image/png" })],
          promptPrefix: "请结合附件分析：",
        },
      ),
    ).resolves.toMatchObject({ status: "attachment-only", reason: "prompt-error" });
  });

  it("异步附件写入期间句柄切换时仍向原 Composer 写入提示词", async () => {
    let resolveAttachment!: (accepted: boolean) => void;
    const pendingAttachment = new Promise<boolean>((resolve) => {
      resolveAttachment = resolve;
    });
    const originalInsertPrompt = vi.fn(() => true);
    const nextInsertPrompt = vi.fn(() => true);
    const originalComposer = composerHandle({
      addDroppedFiles: vi.fn(() => pendingAttachment),
      insertTextAtEnd: originalInsertPrompt,
    });
    const ref = composerRef(originalComposer);

    const commit = commitLocalPluginAttachmentToComposer(ref, {
      files: [new File(["image"], "diagram.png", { type: "image/png" })],
      promptPrefix: "请结合附件分析：",
    });
    ref.current = composerHandle({
      addDroppedFiles: vi.fn(async () => true),
      insertTextAtEnd: nextInsertPrompt,
    });
    resolveAttachment(true);

    await expect(commit).resolves.toEqual({ status: "complete" });
    expect(originalInsertPrompt).toHaveBeenCalledWith("请结合附件分析：", {
      ensureLeadingBoundary: true,
    });
    expect(nextInsertPrompt).not.toHaveBeenCalled();
  });
});
