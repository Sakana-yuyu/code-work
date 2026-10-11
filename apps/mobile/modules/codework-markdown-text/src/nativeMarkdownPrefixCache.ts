import type { MarkdownNode } from "react-native-nitro-markdown/headless";

const LINE_BREAK = /\r\n|\r|\n/g;
const PARAGRAPH_SEPARATOR = /^[ \t]*(?:\r\n|\r(?!\n)|\n)[ \t]*(?:\r\n|\r(?!\n)|\n)/;

function utf8Width(character: string): number {
  const codePoint = character.codePointAt(0)!;
  return codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
}

function stringOffset(text: string, byteOffset: number): number | null {
  let bytes = 0;
  let offset = 0;
  for (const character of text) {
    if (bytes === byteOffset) return offset;
    bytes += utf8Width(character);
    offset += character.length;
    if (bytes > byteOffset) return null;
  }
  return bytes === byteOffset ? offset : null;
}

function utf8Length(text: string): number {
  let length = 0;
  for (const character of text) length += utf8Width(character);
  return length;
}

function closedFenceEnd(text: string, node: MarkdownNode): number | null {
  const start = stringOffset(text, node.beg ?? -1);
  if (start === null) return null;
  const source = text.slice(start);
  const lines = source.split(LINE_BREAK);
  const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[0] ?? "");
  if (!opening || (opening[1]![0] === "`" && opening[2]!.includes("`"))) return null;
  const marker = opening[1]!;
  const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`);
  let lineStart = start;
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index]!;
    const lineEnd = lineStart + line.length;
    const newlineLength = text.startsWith("\r\n", lineEnd) ? 2 : 1;
    if (index > 0 && closing.test(line)) return lineEnd + newlineLength;
    lineStart = lineEnd + newlineLength;
  }
  return null;
}

function completedPrefix(text: string, document: MarkdownNode) {
  let offset = 0;
  let count = 0;
  for (const [index, node] of (document.children ?? []).entries()) {
    let end: number | null = null;
    if (node.type === "code_block") {
      end = closedFenceEnd(text, node);
    } else if (node.type === "paragraph" || node.type === "heading") {
      const contentEnd = stringOffset(text, node.end ?? -1);
      const separator =
        contentEnd === null ? null : PARAGRAPH_SEPARATOR.exec(text.slice(contentEnd));
      if (separator) end = contentEnd! + separator[0].length;
    }
    if (end !== null && end > offset) {
      offset = end;
      count = index + 1;
    }
  }
  return { offset, count };
}

function shiftNode(node: MarkdownNode, byteOffset: number): MarkdownNode {
  if (
    node.type === "soft_break" ||
    node.type === "line_break" ||
    (node.beg === 0 && node.end === 0 && node.type !== "code_block" && node.type !== "document")
  )
    return node;
  return {
    ...node,
    ...(node.beg === undefined ? {} : { beg: node.beg + byteOffset }),
    // md4c 为列表等容器返回 end=0，表示没有位置；不能把它变成有效结束位置。
    ...(node.end === undefined || node.end === 0 ? {} : { end: node.end + byteOffset }),
    ...(node.children
      ? { children: node.children.map((child) => shiftNode(child, byteOffset)) }
      : {}),
  };
}

function hasUnpositionedCodeText(node: MarkdownNode): boolean {
  return (
    (node.type === "code_block" &&
      node.children?.some(
        (child) => child.type === "text" && (child.beg ?? 0) <= (node.beg ?? 0),
      ) === true) ||
    node.children?.some(hasUnpositionedCodeText) === true
  );
}

function hasDocumentReferences(node: MarkdownNode): boolean {
  if (node.type === "code_block" || node.type === "code_inline") return false;
  // 原生 AST 不保留链接来源类别；链接/图片和未解析方括号保守地使用完整上下文。
  return (
    node.type === "link" ||
    node.type === "image" ||
    (node.type === "text" && node.content?.includes("[") === true) ||
    node.children?.some(hasDocumentReferences) === true
  );
}

/** 每个挂载的消息独享缓存；只解析未闭合尾部，引用语法和正文替换重新解析全文。 */
export function createNativeMarkdownPrefixCache(parse: (text: string) => MarkdownNode) {
  let previousText: string | null = null;
  let previousDocument: MarkdownNode | null = null;
  let prefixText = "";
  let prefixBytes = 0;
  let prefixNodes: MarkdownNode[] = [];

  return (text: string): MarkdownNode => {
    if (text === previousText && previousDocument !== null) return previousDocument;
    if (!text.startsWith(prefixText)) {
      prefixText = "";
      prefixBytes = 0;
      prefixNodes = [];
    }

    let tailText = text.slice(prefixText.length);
    let parsedTail = parse(tailText);
    // 原生解析器对空代码行可能沿用前一块的位置；这种树必须在完整上下文中生成。
    if (
      prefixBytes > 0 &&
      (hasUnpositionedCodeText(parsedTail) || hasDocumentReferences(parsedTail))
    ) {
      prefixText = "";
      prefixBytes = 0;
      prefixNodes = [];
      tailText = text;
      parsedTail = parse(text);
    }
    const tailNodes =
      prefixBytes === 0
        ? (parsedTail.children ?? [])
        : (parsedTail.children ?? []).map((node) => shiftNode(node, prefixBytes));
    const document: MarkdownNode =
      prefixNodes.length === 0
        ? parsedTail
        : {
            ...parsedTail,
            beg: 0,
            end: prefixBytes + (parsedTail.end ?? utf8Length(tailText)),
            children: [...prefixNodes, ...tailNodes],
          };

    // 引用定义可以改写前文；代码中的方括号没有引用语义，仍可复用闭合代码块。
    if (!hasDocumentReferences(parsedTail)) {
      const completed = completedPrefix(tailText, parsedTail);
      if (completed.count > 0) {
        prefixNodes = [...prefixNodes, ...tailNodes.slice(0, completed.count)];
        prefixText += tailText.slice(0, completed.offset);
        prefixBytes += utf8Length(tailText.slice(0, completed.offset));
      }
    }
    previousText = text;
    previousDocument = document;
    return document;
  };
}
