import type { MarkdownNode } from "react-native-nitro-markdown/headless";

function codeText(node: MarkdownNode): string {
  return node.content ?? (node.children ?? []).map(codeText).join("");
}

/** 起始字节位置标识代码块，重复内容也不会相互覆盖；正文来自完整 AST。 */
export function markdownCodeCopySources(document: MarkdownNode): ReadonlyMap<number, string> {
  const codes = new Map<number, string>();
  const visit = (node: MarkdownNode) => {
    if (node.type === "code_block" && node.beg !== undefined) {
      codes.set(node.beg, codeText(node).replace(/\r?\n$/, ""));
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(document);
  return codes;
}
