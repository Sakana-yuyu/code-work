// 缓存停在顶层闭合围栏或空行结束的段落之后；可继续增长的容器仍交给原解析器。
interface Point {
  line: number;
  column: number;
  offset?: number;
}

interface MarkdownNode {
  type: string;
  value?: unknown;
  position?: { start: Point; end: Point };
  children?: MarkdownNode[];
}

interface MarkdownDocument extends MarkdownNode {
  children: MarkdownNode[];
}

interface MarkdownProcessor {
  parser?: (source: string, file: unknown) => MarkdownDocument;
}

function hasDocumentReferences(node: MarkdownNode): boolean {
  return (
    /^(?:definition|footnoteDefinition|footnoteReference|linkReference|imageReference)$/.test(
      node.type,
    ) ||
    (node.type === "text" && typeof node.value === "string" && node.value.includes("[")) ||
    (node.children?.some(hasDocumentReferences) ?? false)
  );
}

function closedFenceEnd(node: MarkdownNode, source: string): number {
  if (node.type !== "code" || node.position?.start.column !== 1) return 0;
  const start = node.position.start.offset;
  const end = node.position.end.offset;
  if (start === undefined || end === undefined) return 0;
  const lines = source.slice(start, end).split(/\r\n|\r|\n/);
  const opening = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0] ?? "")?.[1];
  if (opening === undefined || lines.length < 2) return 0;
  const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(lines.at(-1) ?? "")?.[1];
  if (closing === undefined || closing[0] !== opening[0] || closing.length < opening.length)
    return 0;
  // EOF 处的闭合行仍可追加文字而变成代码内容，只有换行后才能冻结。
  if (source[end] !== "\n" && source[end] !== "\r") return 0;
  return end + (source.startsWith("\r\n", end) ? 2 : 1);
}

function completedBlockEnd(node: MarkdownNode, source: string): number {
  const fenceEnd = closedFenceEnd(node, source);
  if (fenceEnd > 0) return fenceEnd;
  const end = node.position?.end.offset;
  if (end === undefined || !["paragraph", "heading", "thematicBreak", "table"].includes(node.type))
    return 0;
  const separator = /^(?:[ \t]*(?:\r\n|\r(?!\n)|\n)){2}/.exec(source.slice(end))?.[0];
  return separator === undefined ? 0 : end + separator.length;
}

function shiftPositions(node: MarkdownNode, offset: number, lines: number): void {
  if (node.position !== undefined) {
    for (const point of [node.position.start, node.position.end]) {
      point.line += lines;
      if (point.offset !== undefined) point.offset += offset;
    }
  }
  node.children?.forEach((child) => shiftPositions(child, offset, lines));
}

export function createMarkdownPrefixCache() {
  let prefix = "";
  let prefixChildren: MarkdownNode[] = [];
  let prefixLines = 0;
  return function (this: unknown) {
    const processor = this as MarkdownProcessor;
    const parse = processor.parser;
    if (parse === undefined) return;
    processor.parser = (source, file) => {
      // 列表恢复插件的嵌套解析不能覆盖当前消息的缓存。
      if (source.startsWith("codework-markdown-inline-prefix:")) return parse(source, file);
      const canReuse =
        prefix.length > 0 &&
        source.startsWith(prefix) &&
        !/(?:^|\n|\r) {0,3}\[[^\]\r\n]+\]:/.test(source.slice(prefix.length));
      let document: MarkdownDocument;
      if (canReuse) {
        document = parse(source.slice(prefix.length), file);
        shiftPositions(document, prefix.length, prefixLines);
        document.children.unshift(...structuredClone(prefixChildren));
        if (document.position !== undefined)
          document.position.start = { line: 1, column: 1, offset: 0 };
      } else {
        document = parse(source, file);
      }
      // 后来的定义可能改变之前的链接/脚注，因此带引用的文档不冻结。
      if (hasDocumentReferences(document)) {
        if (canReuse) document = parse(source, file);
        prefix = "";
        prefixChildren = [];
        return document;
      }
      let boundary = 0;
      let childCount = 0;
      for (const [index, node] of document.children.entries()) {
        const end = completedBlockEnd(node, source);
        if (end > boundary) {
          boundary = end;
          childCount = index + 1;
        }
      }
      if (boundary > 0 && !source.slice(0, boundary).endsWith("\r")) {
        prefix = source.slice(0, boundary);
        prefixChildren = structuredClone(document.children.slice(0, childCount));
        prefixLines = prefix.split(/\r\n|\r|\n/).length - 1;
      } else {
        prefix = "";
        prefixChildren = [];
      }
      return document;
    };
  };
}
