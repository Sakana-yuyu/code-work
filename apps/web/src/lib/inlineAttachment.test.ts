import { describe, expect, it } from "vite-plus/test";

import {
  INLINE_ATTACHMENT_PLACEHOLDER,
  countInlineAttachmentPlaceholders,
  ensureInlineAttachmentPlaceholders,
  insertInlineAttachmentPlaceholder,
  materializeInlineAttachmentPrompt,
  removeInlineAttachmentPlaceholder,
} from "./inlineAttachment";

describe("inlineAttachment", () => {
  it("inserts at the cursor with word-boundary spacing", () => {
    const inserted = insertInlineAttachmentPlaceholder("look atthis", 7);
    expect(inserted.prompt).toBe(`look at ${INLINE_ATTACHMENT_PLACEHOLDER} this`);
    expect(inserted.attachmentIndex).toBe(0);
    expect(inserted.cursor).toBe("look at ".length + 2);
  });

  it("tracks the attachment index across existing placeholders", () => {
    const prompt = `a${INLINE_ATTACHMENT_PLACEHOLDER} mid${INLINE_ATTACHMENT_PLACEHOLDER} z`;
    const inserted = insertInlineAttachmentPlaceholder(prompt, prompt.length);
    expect(inserted.attachmentIndex).toBe(2);
  });

  it("removes the placeholder at the given index", () => {
    const prompt = `x${INLINE_ATTACHMENT_PLACEHOLDER} y${INLINE_ATTACHMENT_PLACEHOLDER} z`;
    const removed = removeInlineAttachmentPlaceholder(prompt, 0);
    expect(removed.prompt).toBe(`x y${INLINE_ATTACHMENT_PLACEHOLDER} z`);
    expect(removed.cursor).toBe(1);
  });

  it("ensures missing placeholders lead the prompt", () => {
    const prompt = ensureInlineAttachmentPlaceholders("text", 2);
    expect(prompt).toBe(`${INLINE_ATTACHMENT_PLACEHOLDER}${INLINE_ATTACHMENT_PLACEHOLDER}text`);
    expect(countInlineAttachmentPlaceholders(prompt)).toBe(2);
    expect(ensureInlineAttachmentPlaceholders(prompt, 2)).toBe(prompt);
  });

  it("materializes placeholders as bracketed file references", () => {
    const prompt = `see ${INLINE_ATTACHMENT_PLACEHOLDER} and ${INLINE_ATTACHMENT_PLACEHOLDER}end`;
    const result = materializeInlineAttachmentPrompt(prompt, [
      { id: "a", kind: "image", name: "shot.png" },
      { id: "b", kind: "file", name: 'notes "quoted".txt' },
    ]);
    expect(result).toBe(
      `see [Attached file "shot.png"] and [Attached file "notes 'quoted'.txt"]end`,
    );
  });

  it("drops placeholders whose ref is missing", () => {
    const prompt = `a${INLINE_ATTACHMENT_PLACEHOLDER}b`;
    expect(materializeInlineAttachmentPrompt(prompt, [])).toBe("ab");
  });
});
