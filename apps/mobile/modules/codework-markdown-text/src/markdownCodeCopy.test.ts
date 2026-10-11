import { describe, expect, it } from "vite-plus/test";
import { markdownCodeCopySources } from "./markdownCodeCopy";

describe("原生代码复制的完整来源", () => {
  it("相同前缀代码按位置区分，嵌套引用和列表同样读完整内容", () => {
    const sources = markdownCodeCopySources({
      type: "document",
      children: [
        { type: "code_block", beg: 0, content: "same\nfirst-tail\n" },
        {
          type: "blockquote",
          children: [
            {
              type: "list",
              children: [
                {
                  type: "code_block",
                  beg: 100,
                  children: [
                    { type: "text", content: "same\n" },
                    { type: "text", content: "second-tail🌏\n" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(sources.get(0)).toBe("same\nfirst-tail");
    expect(sources.get(100)).toBe("same\nsecond-tail🌏");
  });

  it("缺少起始位置不猜身份，不截断 CRLF 或空代码块", () => {
    const sources = markdownCodeCopySources({
      type: "document",
      children: [
        { type: "code_block", content: "没有位置" },
        { type: "code_block", beg: 30, content: "" },
        { type: "code_block", beg: 60, content: "甲\r\n乙\r\n" },
      ],
    });
    expect(sources.size).toBe(2);
    expect(sources.get(30)).toBe("");
    expect(sources.get(60)).toBe("甲\r\n乙");
  });
});
