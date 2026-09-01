import type { TerminalSummary } from "@codework/contracts";

/** Human-readable label for a terminal tab; matches mobile and web sidebars. */
export function getTerminalLabel(terminalId: string): string {
  const numericSuffix = /^term(?:inal)?-(\d+)$/i.exec(terminalId)?.[1];
  if (numericSuffix) {
    return `Terminal ${numericSuffix}`;
  }

  return terminalId;
}

export interface TerminalLabelTranslation {
  readonly key: "terminal.defaultTabLabel";
  readonly params: Readonly<{ index: string }>;
}

/**
 * 服务端 wire label 与本地兜底都生成英文默认名 "Terminal N"（shared 拿不到
 * UI 语言）；各端展示前用它换算成稳定 i18n key + 序号参数，非默认名原样。
 */
export function terminalLabelTranslation(label: string): TerminalLabelTranslation | null {
  const match = /^Terminal (\d+)$/.exec(label.trim());
  if (!match) return null;
  return { key: "terminal.defaultTabLabel", params: { index: match[1]! } };
}

/** Prefer server summary label when present; otherwise fall back to `getTerminalLabel`. */
export function resolveTerminalSessionLabel(
  terminalId: string,
  summary: Pick<TerminalSummary, "label"> | null | undefined,
): string {
  const trimmed = summary?.label?.trim();
  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }
  return getTerminalLabel(terminalId);
}

/**
 * Client-side terminal id allocator. Ids are ALWAYS chosen by the client and sent explicitly
 * on every `terminal.open` / `terminal.attach` call — the server never allocates.
 *
 * Returns the lowest unused `term-N` id (starting at `term-1`), skipping any ids already in
 * `existingTerminalIds`.
 */
export function nextTerminalId(existingTerminalIds: ReadonlyArray<string>): string {
  const usedIds = new Set(existingTerminalIds.filter((id) => id.trim().length > 0));
  let nextIndex = 1;
  while (usedIds.has(`term-${nextIndex}`)) {
    nextIndex += 1;
  }

  return `term-${nextIndex}`;
}
