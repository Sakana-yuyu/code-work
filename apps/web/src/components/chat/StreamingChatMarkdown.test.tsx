import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  fullText: "完整正文及尾文",
  visibleText: "完整正文",
  pending: true,
  catchUp: vi.fn(),
  hold: vi.fn(),
  release: vi.fn(),
}));
vi.mock("@codework/client-runtime/text-reveal", () => ({ useTextReveal: () => state }));
vi.mock("../ChatMarkdown", () => ({ default: (props: { text: string }) => <p>{props.text}</p> }));

import { StreamingChatMarkdown } from "./StreamingChatMarkdown";

describe("显示前缀与完整几何", () => {
  it("积压期间全文测量不可见且不可交互，显示挂载只读前缀", () => {
    state.pending = true;
    const html = renderToStaticMarkup(
      <StreamingChatMarkdown text={state.fullText} cwd={undefined} isStreaming pacing />,
    );
    expect(html).toContain('aria-hidden="true" inert=""');
    expect(html).toContain('data-full-text-geometry="true"><p>完整正文及尾文</p>');
    expect(html).toContain('data-revealed-text="true"><p>完整正文</p>');
    expect(html).toContain("position:absolute");
  });

  it("追上全文后仅保留一个正文挂载，没有空闲测量层", () => {
    state.pending = false;
    state.visibleText = state.fullText;
    const html = renderToStaticMarkup(
      <StreamingChatMarkdown text={state.fullText} cwd={undefined} pacing />,
    );
    expect(html).not.toContain("data-full-text-geometry");
    expect(html).not.toContain("position:absolute");
    expect(html.match(/<p>/g)).toHaveLength(1);
  });
});
