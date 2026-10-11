import { describe, expect, it } from "vite-plus/test";
import {
  createMarkdownCodeDisplaySelector,
  type MarkdownHighlightedCode,
} from "./markdownCodeDisplay";

const context = { enabled: true, language: "typescript", theme: "dark" as const };
const text = (rows: MarkdownHighlightedCode) =>
  rows.map((line) => line.map((token) => token.content).join("")).join("\n");
const highlighted = (code: string, color = "#abc"): MarkdownHighlightedCode =>
  code.split("\n").map((content) => [{ content, color, fontStyle: null }]);

describe("移动端代码显示缓存", () => {
  it("初次无高亮也使用完整行结构，后续纯文本追加保留完成行", () => {
    const select = createMarkdownCodeDisplaySelector();
    const first = select({ ...context, code: "第一行\n第二行", highlighted: null });
    const next = select({ ...context, code: "第一行\n第二行\n第三行😀", highlighted: null });
    expect(next[0]).toBe(first[0]);
    expect(next[1]).toBe(first[1]);
    expect(text(next)).toBe("第一行\n第二行\n第三行😀");
    expect(select({ ...context, code: text(next), highlighted: null })).toBe(next);
  });

  it("异步高亮等待与失败期间保留已着色完成行，当前尾行仍完整", () => {
    const select = createMarkdownCodeDisplaySelector();
    const first = select({
      ...context,
      code: "const a = 1;\n尾部",
      highlighted: highlighted("const a = 1;\n尾部"),
    });
    const waiting = select({ ...context, code: "const a = 1;\n尾部追加", highlighted: null });
    expect(waiting[0]).toBe(first[0]);
    expect(waiting[0]?.[0]?.color).toBe("#abc");
    expect(text(waiting)).toBe("const a = 1;\n尾部追加");
    expect(select({ ...context, code: text(waiting), highlighted: null })).toBe(waiting);
    const later = select({ ...context, code: text(waiting) + "\n下一行", highlighted: null });
    expect(later[0]).toBe(first[0]);
    expect(later[1]).toBe(waiting[1]);
    expect(text(first)).toBe("const a = 1;\n尾部");
  });

  it("高亮返回后复用相同完成行，语法导致的颜色变化仍更新", () => {
    const select = createMarkdownCodeDisplaySelector();
    const first = select({
      ...context,
      code: "第一行\n第二行",
      highlighted: highlighted("第一行\n第二行"),
    });
    select({ ...context, code: "第一行\n第二行\n第三行", highlighted: null });
    const ready = select({
      ...context,
      code: "第一行\n第二行\n第三行",
      highlighted: highlighted("第一行\n第二行\n第三行"),
    });
    expect(ready[0]).toBe(first[0]);
    expect(ready[1]).toBe(first[1]);
    const recolored = select({
      ...context,
      code: text(ready),
      highlighted: highlighted(text(ready), "#def"),
    });
    expect(recolored[0]).not.toBe(ready[0]);
    expect(recolored[0]?.[0]?.color).toBe("#def");
  });

  it("语言、主题、开关与替换不沿用旧颜色，重新启用后恢复实际高亮", () => {
    for (const change of [
      { language: "python" },
      { theme: "light" as const },
      { enabled: false },
      { code: "替换" },
    ]) {
      const select = createMarkdownCodeDisplaySelector();
      select({ ...context, code: "初始", highlighted: highlighted("初始") });
      const next = select({ ...context, code: "初始追加", highlighted: null, ...change });
      expect(next.flat().every((token) => token.color === null)).toBe(true);
      expect(text(next)).toBe(change.code ?? "初始追加");
      const restored = select({
        ...context,
        code: text(next),
        highlighted: highlighted(text(next)),
      });
      expect(restored[0]?.[0]?.color).toBe("#abc");
    }
  });

  it("不一致或旧高亮不会截断新正文，空行与 CRLF 始终完整", () => {
    const select = createMarkdownCodeDisplaySelector();
    const code = "\n中文😀\r\n\n";
    const stale = select({ ...context, code, highlighted: highlighted("旧正文") });
    expect(text(stale)).toBe(code);
    const next = select({
      ...context,
      code: code + "尾段",
      highlighted: highlighted("\n中文😀\n\n尾段"),
    });
    expect(text(next)).toBe(code + "尾段");
    expect(next[0]).toBe(stale[0]);
    expect(next[1]).toBe(stale[1]);
  });

  it("各代码块独享缓存，重复输入复用当前结果", () => {
    const left = createMarkdownCodeDisplaySelector();
    const right = createMarkdownCodeDisplaySelector();
    const input = { ...context, code: "同文", highlighted: highlighted("同文") };
    const first = left(input);
    expect(left(input)).toBe(first);
    expect(right({ ...input, highlighted: null })[0]?.[0]?.color).toBeNull();
    expect(left({ ...context, code: "同文追加", highlighted: null })[0]?.[0]?.color).toBe("#abc");
  });
});
