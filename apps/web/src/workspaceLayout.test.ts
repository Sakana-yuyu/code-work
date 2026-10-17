import * as Schema from "effect/Schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@codework/contracts";

import {
  ideChatWidthForEditor,
  ideEditorGivesWay,
  resolveWorkspaceLayout,
  shouldUseIdeShell,
  useIdeViewportAvailable,
  WorkspaceLayoutSchema,
} from "./workspaceLayout";

const split = vi.hoisted(() => ({
  primaryThreadRef: null as ScopedThreadRef | null,
  secondaryThreadRef: null as ScopedThreadRef | null,
}));
vi.mock("./hooks/useMediaQuery", () => ({ useMediaQuery: () => true }));
vi.mock("./threadSplitStore", () => ({
  useThreadSplitStore: (selector: (state: typeof split) => boolean) => selector(split),
}));

describe("工作区布局", () => {
  it("分屏时外层导航和内部工作区共用同一可用性判断，关闭后恢复", () => {
    const Availability = () => String(useIdeViewportAvailable());
    const render = () => renderToStaticMarkup(createElement(Availability));
    const first = {
      environmentId: EnvironmentId.make("local"),
      threadId: ThreadId.make("first"),
    };
    split.primaryThreadRef = first;
    expect(render()).toBe("true");
    split.secondaryThreadRef = { ...first, threadId: ThreadId.make("second") };
    expect(render()).toBe("false");
    split.secondaryThreadRef = first;
    expect(render()).toBe("true");
    split.secondaryThreadRef = null;
    expect(render()).toBe("true");
  });
  it("只在有工作区的宽屏路由替换主侧栏", () => {
    expect(shouldUseIdeShell("ide", 1446, true)).toBe(true);
    expect(shouldUseIdeShell("ide", 900, true)).toBe(false);
    expect(shouldUseIdeShell("ide", 1446, false)).toBe(false);
    expect(shouldUseIdeShell("chat", 1446, true)).toBe(false);
  });

  it("只有选择 IDE 且工作区足够宽时才显示 IDE", () => {
    expect(resolveWorkspaceLayout("chat", 1600)).toBe("chat");
    expect(resolveWorkspaceLayout("ide", 900)).toBe("ide");
    expect(resolveWorkspaceLayout("ide", 899)).toBe("chat");
    expect(resolveWorkspaceLayout("ide", 0)).toBe("chat");
    expect(resolveWorkspaceLayout("ide", 1200)).toBe("ide");
  });

  it("对话拖过编辑器最小宽度后编辑器让位，打开文件时再把对话收回", () => {
    expect(ideEditorGivesWay(1200, 360)).toBe(false);
    expect(ideEditorGivesWay(1200, 720)).toBe(false);
    expect(ideEditorGivesWay(1200, 721)).toBe(true);
    expect(ideEditorGivesWay(700, 600)).toBe(false);
    expect(ideChatWidthForEditor(1200, 900)).toBe(720);
    expect(ideChatWidthForEditor(1200, 360)).toBe(360);
  });

  it("持久化只接受对话和 IDE 两种布局", () => {
    const decode = Schema.decodeUnknownSync(WorkspaceLayoutSchema);
    expect(decode("ide")).toBe("ide");
    expect(decode("chat")).toBe("chat");
    expect(() => decode("unknown")).toThrow();
  });
});
