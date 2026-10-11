import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { ResponseStreamingModeControl } from "./ResponseStreamingModeControl";

vi.mock("~/i18n", () => ({ t: (key: string) => key }));

describe("回复模式选择器", () => {
  it.each(["turn", "paragraph", "token"] as const)("显示当前模式 %s 和可访问名称", (mode) => {
    const html = renderToStaticMarkup(
      <ResponseStreamingModeControl mode={mode} supported onChange={vi.fn()} />,
    );
    expect(html).toContain(`settings.responseStreaming.${mode}`);
    expect(html).toContain('aria-label="settings.responseStreamingMode"');
    expect(html).not.toContain('aria-disabled="true"');
  });

  it("旧服务端禁用三态控制", () => {
    const html = renderToStaticMarkup(
      <ResponseStreamingModeControl mode="paragraph" supported={false} onChange={vi.fn()} />,
    );
    expect(html).toContain('disabled=""');
  });
});
