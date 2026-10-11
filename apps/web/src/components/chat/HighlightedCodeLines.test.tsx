import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import {
  HighlightedCodeLines,
  sameHighlightedLine,
  type HighlightedCode,
} from "./HighlightedCodeLines";

it("代码按 React 行节点渲染，文字转义并保留字体样式", () => {
  const highlighted: HighlightedCode = {
    tokens: [
      [
        { content: "<script>", offset: 0, color: "#ccc", fontStyle: 1 },
        { content: "粗体", offset: 8, fontStyle: 2 },
        { content: "下划线", offset: 10, fontStyle: 4 },
      ],
      [{ content: "下一行", offset: 13, color: "#fff" }],
    ],
    fg: "#fff",
    bg: "#000",
    themeName: "test",
  };
  const html = renderToStaticMarkup(<HighlightedCodeLines highlighted={highlighted} />);
  expect(html).toContain("&lt;script&gt;");
  expect(html.match(/class="line"/g)).toHaveLength(2);
  expect(html).toContain("font-style:italic");
  expect(html).toContain("font-weight:bold");
  expect(html).toContain("text-decoration:underline");
});

it("文字和高亮相同的完成行可复用，颜色或字体变化必须更新", () => {
  const token: HighlightedCode["tokens"][number][number] = {
    content: "const value = 2;",
    offset: 0,
    color: "#ccc",
    fontStyle: 0,
  };
  const tokens = [token];
  expect(sameHighlightedLine(tokens, structuredClone(tokens))).toBe(true);
  expect(sameHighlightedLine(tokens, [{ ...token, color: "#fff" }])).toBe(false);
  expect(sameHighlightedLine(tokens, [{ ...token, fontStyle: 2 }])).toBe(false);
  expect(sameHighlightedLine(tokens, [{ ...token, content: "新的内容" }])).toBe(false);
});
