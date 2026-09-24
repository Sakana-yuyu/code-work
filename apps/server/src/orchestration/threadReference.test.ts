import { describe, expect, it } from "vite-plus/test";

import { buildThreadReference } from "./threadReference.ts";

const message = (role: "user" | "assistant", text: string, streaming = false) => ({
  role,
  text,
  streaming,
});

describe("thread reference", () => {
  it("只引用最近已完成消息并标记截断", () => {
    const messages = [
      message("user", "旧问题"),
      ...Array.from({ length: 6 }, (_, index) => message("assistant", `结论 ${index}`)),
      message("assistant", "仍在输出", true),
    ];
    const result = buildThreadReference({ messages });
    expect(result.excerpt).not.toContain("旧问题");
    expect(result.excerpt).not.toContain("仍在输出");
    expect(result.excerpt).toContain("结论 5");
    expect(result.truncated).toBe(true);
  });

  it("对长消息设置总长度上限", () => {
    const result = buildThreadReference({ messages: [message("user", "字".repeat(20_000))] });
    expect(result.excerpt.length).toBeLessThanOrEqual(6_000);
    expect(result.truncated).toBe(true);
  });
});
