/**
 * Inline attachment references: pasted images and dropped files leave a
 * placeholder inside the prompt text so the attachment sits at its position in
 * the sentence instead of only in the tray below. The draft's `attachmentRefs`
 * list maps each placeholder, in order, to a composer attachment.
 *
 * The placeholder is a Private Use Area codepoint: it survives plain-text
 * round-trips through Lexical and the persisted draft, cannot be typed from a
 * keyboard, and is legal XML (unlike the U+FFFE/U+FFFF noncharacters).
 */

export const INLINE_ATTACHMENT_PLACEHOLDER = "\uE000";

export interface ComposerAttachmentRef {
  /** Composer attachment id (`ComposerImageAttachment.id` / `ComposerFileAttachment.id`). */
  id: string;
  kind: "image" | "file";
}

export function countInlineAttachmentPlaceholders(prompt: string): number {
  let count = 0;
  for (const char of prompt) {
    if (char === INLINE_ATTACHMENT_PLACEHOLDER) {
      count += 1;
    }
  }
  return count;
}

export function ensureInlineAttachmentPlaceholders(
  prompt: string,
  attachmentCount: number,
): string {
  const missingCount = attachmentCount - countInlineAttachmentPlaceholders(prompt);
  if (missingCount <= 0) {
    return prompt;
  }
  return `${INLINE_ATTACHMENT_PLACEHOLDER.repeat(missingCount)}${prompt}`;
}

function isInlineAttachmentBoundaryWhitespace(char: string | undefined): boolean {
  return char === undefined || char === " " || char === "\n" || char === "\t" || char === "\r";
}

export function insertInlineAttachmentPlaceholder(
  prompt: string,
  cursorInput: number,
): { prompt: string; cursor: number; attachmentIndex: number } {
  const cursor = Math.max(0, Math.min(prompt.length, Math.floor(cursorInput)));
  const needsLeadingSpace = !isInlineAttachmentBoundaryWhitespace(prompt[cursor - 1]);
  const replacement = `${needsLeadingSpace ? " " : ""}${INLINE_ATTACHMENT_PLACEHOLDER} `;
  const rangeEnd = prompt[cursor] === " " ? cursor + 1 : cursor;
  return {
    prompt: `${prompt.slice(0, cursor)}${replacement}${prompt.slice(rangeEnd)}`,
    cursor: cursor + replacement.length,
    attachmentIndex: countInlineAttachmentPlaceholders(prompt.slice(0, cursor)),
  };
}

export function removeInlineAttachmentPlaceholder(
  prompt: string,
  attachmentIndex: number,
): { prompt: string; cursor: number } {
  if (attachmentIndex < 0) {
    return { prompt, cursor: prompt.length };
  }

  let placeholderIndex = 0;
  for (let index = 0; index < prompt.length; index += 1) {
    if (prompt[index] !== INLINE_ATTACHMENT_PLACEHOLDER) {
      continue;
    }
    if (placeholderIndex === attachmentIndex) {
      return {
        prompt: prompt.slice(0, index) + prompt.slice(index + 1),
        cursor: index,
      };
    }
    placeholderIndex += 1;
  }

  return { prompt, cursor: prompt.length };
}

/**
 * Renders each attachment placeholder as a bracketed name so the model sees
 * where in the sentence the file was referenced; the trailing
 * `[Attached file "..." is saved at: ...]` block supplies the real paths.
 */
export function materializeInlineAttachmentPrompt(
  prompt: string,
  attachments: ReadonlyArray<ComposerAttachmentRef & { name: string }>,
): string {
  let nextIndex = 0;
  let result = "";
  for (const char of prompt) {
    if (char !== INLINE_ATTACHMENT_PLACEHOLDER) {
      result += char;
      continue;
    }
    const attachment = attachments[nextIndex] ?? null;
    nextIndex += 1;
    if (!attachment) {
      continue;
    }
    result += `[Attached file "${attachment.name.replaceAll('"', "'")}"]`;
  }
  return result;
}
