import { describe, expect, it, vi } from "vite-plus/test";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";
import { createNativeMarkdownPrefixCache } from "@codework/mobile-markdown-text/markdown";
import fixtures from "./fixtures/nativeMarkdownPrefixDocuments.json";

// 样本由已安装 0.5.8 的 MD4C 核心生成；普通测试无需原生设备或额外编译器。
const documents = new Map<string, MarkdownNode>(
  fixtures.documents.map(({ source, ast }) => [source, ast as MarkdownNode]),
);

function parser() {
  return vi.fn((source: string) => {
    const document = documents.get(source);
    if (!document) throw new Error(`缺少原生样本：${JSON.stringify(source)}`);
    return structuredClone(document);
  });
}

describe("移动端已完成 Markdown 前缀", () => {
  it.each(fixtures.scenarios)("与原生解析样本等价：%j", (...sources) => {
    const parse = createNativeMarkdownPrefixCache(parser());
    for (const source of sources) expect(parse(source)).toEqual(documents.get(source));
  });

  it("中文和 emoji 按 UTF-8 字节平移，闭合段落与重复输入保持引用", () => {
    const nativeParse = parser();
    const parse = createNativeMarkdownPrefixCache(nativeParse);
    const first = parse("中文🙂\n\n");
    const next = parse("中文🙂\n\n尾部");
    expect(next.children?.[0]).toBe(first.children?.[0]);
    expect(next.children?.[1]?.beg).toBe(12);
    expect(nativeParse).toHaveBeenLastCalledWith("尾部");
    expect(parse("中文🙂\n\n尾部")).toBe(next);
    expect(nativeParse).toHaveBeenCalledTimes(2);
  });

  it("围栏结束行尚无换行时仍解析全文，确认闭合后只解析尾部", () => {
    const nativeParse = parser();
    const parse = createNativeMarkdownPrefixCache(nativeParse);
    parse("```ts\nx\n```");
    const closed = parse("```ts\nx\n```\n");
    expect(nativeParse).toHaveBeenLastCalledWith("```ts\nx\n```\n");
    const appended = parse("```ts\nx\n```\n后续");
    expect(nativeParse).toHaveBeenLastCalledWith("后续");
    expect(appended.children?.[0]).toBe(closed.children?.[0]);
  });

  it("单个 CRLF 不被误认为段落分隔", () => {
    const nativeParse = parser();
    const parse = createNativeMarkdownPrefixCache(nativeParse);
    parse("甲\r\n");
    parse("甲\r\n乙");
    expect(nativeParse).toHaveBeenLastCalledWith("甲\r\n乙");
  });

  it("后置引用定义和正文替换重新解析，原生位置占位值保持不变", () => {
    for (const index of [3, 6, 7]) {
      const nativeParse = parser();
      const parse = createNativeMarkdownPrefixCache(nativeParse);
      const sources = fixtures.scenarios[index]!;
      for (const source of sources) expect(parse(source)).toEqual(documents.get(source));
      if (index !== 7) expect(nativeParse).toHaveBeenLastCalledWith(sources.at(-1));
    }
  });

  it("已闭合代码内的数组方括号不会禁用前缀复用", () => {
    const nativeParse = parser();
    const parse = createNativeMarkdownPrefixCache(nativeParse);
    const first = parse("```ts\nconst items = [1, 2];\n```\n");
    const next = parse("```ts\nconst items = [1, 2];\n```\n后续");
    expect(nativeParse).toHaveBeenLastCalledWith("后续");
    expect(next.children?.[0]).toBe(first.children?.[0]);
  });
});
