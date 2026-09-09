import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { WorkspaceLayout } from "./WorkspaceLayout";

function renderLayout(ide: boolean, chatVisible = true) {
  return renderToStaticMarkup(
    <WorkspaceLayout
      ide={ide}
      width={1200}
      chatVisible={chatVisible}
      maximized={false}
      workbench={<iframe title="Code-OSS" />}
      header={<button>切换布局</button>}
      editor={<textarea defaultValue="未保存代码" />}
      terminal={<span>运行中的终端</span>}
    >
      <input defaultValue="未发送草稿" />
    </WorkspaceLayout>,
  );
}

describe("工作区布局容器", () => {
  it("切换仅改变区域位置，两种布局都保留单份编辑器、对话与终端节点", () => {
    for (const ide of [false, true]) {
      const markup = renderLayout(ide);
      expect(markup.match(/<textarea/g)).toHaveLength(1);
      expect(markup.match(/<input/g)).toHaveLength(1);
      expect(markup.match(/运行中的终端/g)).toHaveLength(1);
      expect(markup).toContain(`data-workspace-layout="${ide ? "ide" : "chat"}"`);
      expect(markup).toContain("data-workspace-header-slot");
    }
    expect(renderLayout(true)).toContain("&quot;workbench conversation&quot;");
    expect(renderLayout(false)).toContain("&quot;conversation editor&quot;");
  });

  it("隐藏 AI 面板仍保留草稿节点，回到对话模式恢复可见", () => {
    const hidden = renderLayout(true, false);
    expect(hidden).toMatch(/data-workspace-conversation[^>]*hidden=""/);
    expect(hidden).toContain("未发送草稿");
    expect(renderLayout(false, false)).not.toMatch(/data-workspace-conversation[^>]*hidden=""/);
  });

  it("IDE 只显示原生工作台，旧终端和编辑面板保留但隐藏", () => {
    const markup = renderLayout(true, false);
    expect(markup).toContain("&quot;workbench&quot;");
    expect(markup.match(/<iframe/g)).toHaveLength(1);
    expect(markup).toMatch(/hidden=""[^>]*data-workspace-terminal/);
    expect(markup).toMatch(/hidden=""[^>]*data-workspace-editor/);
    expect(markup).not.toContain("data-workspace-explorer");
  });

  it("对话分隔线可键盘调宽，允许缩小默认面板且完整露出拖动区域", () => {
    const markup = renderLayout(true);
    const conversation = markup.match(/<div[^>]*data-workspace-conversation[^>]*>/)?.[0];
    expect(conversation).toBeDefined();
    expect(conversation).not.toContain("overflow-hidden");
    const separator = markup.match(/<div[^>]*role="separator"[^>]*>/)?.[0];
    expect(separator).toContain('tabindex="0"');
    expect(separator).toContain('aria-valuemin="280"');
    expect(separator).toContain('aria-valuemax="720"');
    expect(separator).toContain('aria-valuenow="360"');
    expect(separator).toContain("touch-none");
    expect(renderLayout(false)).not.toContain('role="separator"');
  });
});
