import { describe, expect, it } from "vite-plus/test";

import { resolveConfirmDialogCopy } from "./ConfirmDialogHost.tsx";

describe("resolveConfirmDialogCopy", () => {
  it("splits an ASCII question title from its description lines", () => {
    expect(
      resolveConfirmDialogCopy(
        ["Revert this thread to checkpoint 0?", "Line one.", "Line two."].join("\n"),
      ),
    ).toEqual({
      title: "Revert this thread to checkpoint 0?",
      description: "Line one.\nLine two.",
    });
  });

  it("splits a full-width question title for localized copy", () => {
    expect(
      resolveConfirmDialogCopy(
        ["将此线程回退到检查点 0？", "这将丢弃较新的消息。", "此操作无法撤销。"].join("\n"),
      ),
    ).toEqual({
      title: "将此线程回退到检查点 0？",
      description: "这将丢弃较新的消息。\n此操作无法撤销。",
    });
  });

  it("falls back to a single-question split without newlines", () => {
    expect(resolveConfirmDialogCopy("Delete this thread? This cannot be undone.")).toEqual({
      title: "Delete this thread?",
      description: "This cannot be undone.",
    });
  });

  it("keeps a full-width question in the inline fallback split", () => {
    expect(resolveConfirmDialogCopy("删除这个线程？该操作无法撤销。")).toEqual({
      title: "删除这个线程？",
      description: "该操作无法撤销。",
    });
  });
});
