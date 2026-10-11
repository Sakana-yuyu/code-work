import { describe, expect, it } from "vite-plus/test";
import { AssistantTextBuffer } from "./AssistantTextBuffer.ts";

describe("增量 Markdown 回复缓冲", () => {
  it("段落闭合才输出，保留最后的未闭合尾段", () => {
    const buffer = new AssistantTextBuffer();
    expect(buffer.append("第一段\n", "paragraph")).toBe("");
    expect(buffer.append("\n尾", "paragraph")).toBe("第一段\n\n");
    expect(buffer.append("段", "paragraph")).toBe("");
    expect(buffer.take()).toBe("尾段");
    expect(buffer.take()).toBe("");
  });

  it.each(["```", "~~~~"])("围栏 %s 内的空行和较短围栏不会提前闭合代码块", (fence) => {
    const buffer = new AssistantTextBuffer();
    const start = `${fence}ts\nconst x = 1;\n\n`;
    expect(buffer.append(start, "paragraph")).toBe("");
    expect(buffer.append(fence.slice(0, 2) + "\n", "paragraph")).toBe("");
    expect(buffer.append(fence + "\n", "paragraph")).toBe(
      start + fence.slice(0, 2) + "\n" + fence + "\n",
    );
  });

  it("超过旧缓冲上限的代码块也等到闭合", () => {
    const buffer = new AssistantTextBuffer();
    const text = "```txt\n" + "x\n".repeat(20_000);
    expect(buffer.append(text, "paragraph")).toBe("");
    expect(buffer.append("```\n", "paragraph")).toBe(text + "```\n");
  });

  it("小标题与空行保留到正文出现并闭合", () => {
    const buffer = new AssistantTextBuffer();
    expect(buffer.append("## 结果\n\n", "paragraph")).toBe("");
    expect(buffer.append("正文\n", "paragraph")).toBe("");
    expect(buffer.append("\n", "paragraph")).toBe("## 结果\n\n正文\n\n");
  });

  it.each(["-", "1."])("紧凑列表 %s 逐项输出，嵌套内容归属于其父项", (marker) => {
    const buffer = new AssistantTextBuffer();
    const first = `${marker} 第一项\n  - 子项\n`;
    expect(buffer.append(first, "paragraph")).toBe("");
    expect(buffer.append(`${marker} 第二项\n`, "paragraph")).toBe(first);
    expect(buffer.take()).toBe(`${marker} 第二项\n`);
  });

  it("引用中的代码块也等待闭合", () => {
    const buffer = new AssistantTextBuffer();
    const start = "> ```js\n> x()\n>\n";
    expect(buffer.append(start, "paragraph")).toBe("");
    expect(buffer.append("> ```\n", "paragraph")).toBe(start + "> ```\n");
  });

  it("紧凑列表的下一项刚开始时输出上一项", () => {
    const buffer = new AssistantTextBuffer();
    expect(buffer.append("- 第一项\n- 第", "paragraph")).toBe("- 第一项\n");
    expect(buffer.append("二项\n- 第三项", "paragraph")).toBe("- 第二项\n");
    expect(buffer.take()).toBe("- 第三项");
  });

  it("下划线小标题同样等待正文", () => {
    const buffer = new AssistantTextBuffer();
    expect(buffer.append("标题\n---\n\n", "paragraph")).toBe("");
    expect(buffer.append("正文\n\n", "paragraph")).toBe("标题\n---\n\n正文\n\n");
  });

  it("缩进代码块保留内部空行，到正文开始时才输出", () => {
    const buffer = new AssistantTextBuffer();
    const code = "    code\n\n    more\n\n";
    expect(buffer.append(code, "paragraph")).toBe("");
    expect(buffer.append("正文\n", "paragraph")).toBe(code);
    expect(buffer.take()).toBe("正文\n");
  });

  it("turn 模式完整保留长回复；切换 token 时先发出已有尾段", () => {
    const buffer = new AssistantTextBuffer();
    const text = "x".repeat(40_000);
    expect(buffer.append(text, "turn")).toBe("");
    expect(buffer.append("tail", "token")).toBe(text + "tail");
    expect(buffer.append("next", "token")).toBe("next");
    expect(buffer.take()).toBe("");
  });

  it("任意分块位置均保持闭合块与尾段的完整文本顺序", () => {
    const text = "## 标题\r\n\r\n正文😀\r\n\r\n- 一\n- 二\n\n```ts\n代码\n\n```\n尾段";
    for (let split = 0; split <= text.length; split++) {
      const buffer = new AssistantTextBuffer();
      const output =
        buffer.append(text.slice(0, split), "paragraph") +
        buffer.append(text.slice(split), "paragraph") +
        buffer.take();
      expect(output, `分块位置 ${split}`).toBe(text);
    }
    const buffer = new AssistantTextBuffer();
    let output = "";
    for (const char of text) output += buffer.append(char, "paragraph");
    expect(output + buffer.take()).toBe(text);
  });
});
