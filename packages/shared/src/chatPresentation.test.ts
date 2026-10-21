import { describe, expect, it } from "vite-plus/test";
import { withoutChatEmoji, withoutChatEmojiInTree } from "./chatPresentation.js";

describe("会话 emoji 显示", () => {
  it("去除沙漏和完整 emoji 序列，保留状态、中文和数学符号", () => {
    expect(withoutChatEmoji("⌛ 0s · 已收到请求\n⏳ 18s · 等待首个 token")).toBe(
      " 0s · 已收到请求\n 18s · 等待首个 token",
    );
    expect(
      withoutChatEmoji("👩🏽‍💻🇨🇳1️⃣❤️🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}完成"),
    ).toBe("完成");
    expect(withoutChatEmoji("1 + 2 = 3，x ≤ 5 → 结论，© 2026™")).toBe(
      "1 + 2 = 3，x ≤ 5 → 结论，© 2026™",
    );
    expect(withoutChatEmoji("↔ ↔️ © ©️")).toBe("↔  © ");
  });

  it("保留 Web 和原生代码节点、链接属性与原始 AST", () => {
    const codeNodes = [
      { type: "element", tagName: "pre", children: [{ type: "text", value: "😀" }] },
      { type: "element", tagName: "code", children: [{ type: "text", value: "😀" }] },
      { type: "code_block", children: [{ type: "text", content: "😀" }] },
      { type: "code_inline", content: "😀" },
    ];
    const tree = {
      type: "root",
      children: [
        { type: "text", value: "⏳进度" },
        { type: "text", content: "✅完成" },
        {
          type: "element",
          properties: { href: "https://example.com/😀" },
          children: [{ type: "text", value: "🔗链接" }],
        },
        ...codeNodes,
      ],
    };
    const result = withoutChatEmojiInTree(tree);
    expect(result.children[0]).toEqual({ type: "text", value: "进度" });
    expect(result.children[1]).toEqual({ type: "text", content: "完成" });
    expect(result.children[2]).toEqual({
      type: "element",
      properties: { href: "https://example.com/😀" },
      children: [{ type: "text", value: "链接" }],
    });
    expect(result.children.slice(3)).toEqual(codeNodes);
    expect(tree.children[0]).toEqual({ type: "text", value: "⏳进度" });
    expect(withoutChatEmojiInTree(tree)).toBe(result);
    expect(withoutChatEmojiInTree(codeNodes[0]!)).toBe(codeNodes[0]);
  });

  it("复用无 emoji 节点及流式前缀，新增尾文独立处理", () => {
    const prefix = { type: "text", value: "已显示" };
    const first = { type: "root", children: [prefix] };
    expect(withoutChatEmojiInTree(first)).toBe(first);
    const next = { type: "root", children: [prefix, { type: "text", value: "⏳等待" }] };
    const result = withoutChatEmojiInTree(next);
    expect(result.children[0]).toBe(prefix);
    expect(result.children[1]?.value).toBe("等待");
  });
});
