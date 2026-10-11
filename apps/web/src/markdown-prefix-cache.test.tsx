import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";
import { createMarkdownPrefixCache } from "./markdown-prefix-cache";
import { remarkGithubAlerts } from "./markdown-github-alerts";
import { remarkNormalizeListItemIndentation } from "./markdown-list-indentation";

type Plugins = NonNullable<Options["remarkPlugins"]>;
function render(
  source: string,
  cache?: ReturnType<typeof createMarkdownPrefixCache>,
  parses?: string[],
) {
  let tree: unknown;
  const observe = function (this: unknown) {
    const processor = this as { parser: (source: string, file: unknown) => unknown };
    const original = processor.parser;
    processor.parser = (text, file) => {
      parses?.push(text);
      return original(text, file);
    };
    return (root: unknown) => {
      tree = structuredClone(root);
    };
  };
  const plugins: Plugins = [
    observe,
    remarkGfm,
    remarkGithubAlerts,
    remarkNormalizeListItemIndentation,
    ...(cache ? [cache] : []),
  ];
  const html = renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={plugins}>{source}</ReactMarkdown>,
  );
  return { tree, html };
}

describe("已闭合 Markdown 前缀", () => {
  it("单个 CRLF 后的文字继续同一段落，不冻结为两段", () => {
    const cache = createMarkdownPrefixCache();
    const source = "第一行\r\n第二行\r\n\r\n下一段";
    for (let end = 0; end <= source.length; end++) {
      const chunk = source.slice(0, end);
      expect(render(chunk, cache), `字符边界 ${end}`).toEqual(render(chunk));
    }
  });
  it("普通段落结束后也只解析未完成尾部", () => {
    const cache = createMarkdownPrefixCache();
    const parses: string[] = [];
    render("首段 **完成**\n\n下一段", cache, parses);
    parses.length = 0;
    expect(render("首段 **完成**\n\n下一段追加", cache, parses)).toEqual(
      render("首段 **完成**\n\n下一段追加"),
    );
    expect(parses).toEqual(["下一段追加"]);
  });
  it("连续追加只解析围栏之后的尾部，并保持节点位置与完整解析一致", () => {
    const cache = createMarkdownPrefixCache();
    const before = "## 检查结果\n\n```ts\nconsole.log('通过');\n```\n\n";
    const parses: string[] = [];
    expect(render(before + "继续", cache, parses)).toEqual(render(before + "继续"));
    parses.length = 0;
    expect(render(before + "继续检查后续", cache, parses)).toEqual(render(before + "继续检查后续"));
    expect(parses).toEqual(["\n继续检查后续"]);
  });

  it.each(["\n", "\r\n", "\r"])("每一个字符边界保持 %j 换行文档的语义", (newline) => {
    const cache = createMarkdownPrefixCache();
    const source = [
      "# 核查",
      "",
      "~~~js",
      "const parts = [1, 2];",
      "~~~",
      "",
      "> [!TIP]",
      "> 核对原始输出",
      "",
      "- [ ] 第一项",
      "",
      "  继续说明",
      "",
      "标题",
      "---",
      "",
      "a | b",
      "--|--",
      "1 | 2",
    ].join(newline);
    for (let end = 0; end <= source.length; end++) {
      const chunk = source.slice(0, end);
      expect(render(chunk, cache), `字符边界 ${end}`).toEqual(render(chunk));
    }
  });

  it("迟到的链接及脚注定义能改写之前的内容", () => {
    const cache = createMarkdownPrefixCache();
    const before = "[文档] 与脚注[^说明]\n\n```text\n完成\n```\n\n";
    for (const tail of ["等待", "[文档]: /guide", "[文档]: /guide\n\n[^说明]: 新说明"]) {
      expect(render(before + tail, cache)).toEqual(render(before + tail));
    }
  });

  it("围栏闭合行仍可追加、嵌套围栏与替换文本不会冻结错误前缀", () => {
    const cache = createMarkdownPrefixCache();
    for (const source of [
      "```\n内容\n```",
      "```\n内容\n```后续",
      "```\n内容\n```\n结束",
      "> ```\n> 文本\n> ```\n\n继续",
      "- ```\n  内容\n  ```\n\n继续",
      "<script>\n```\n原文\n```\n\n",
      "替换为普通段落",
      "```\n新的内容\n```\n继续",
      "```\n新的内容\n```\n继续",
    ]) {
      expect(render(source, cache)).toEqual(render(source));
    }
  });

  it("列表恢复插件的二次解析不会污染当前消息的缓存", () => {
    const cache = createMarkdownPrefixCache();
    const before = "```text\n前缀\n```\n\n";
    const source =
      before +
      "-       文本\n\n        ```ts\n        const value = 2;\n        ```\n\n        尾部";
    expect(render(source, cache)).toEqual(render(source));
    expect(render(source + "追加", cache)).toEqual(render(source + "追加"));
  });
});
