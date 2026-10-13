import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../../../web/src/test/reactHookHarness";
import { visitElements } from "../../../../web/src/test/reactElementTree";

const platform = vi.hoisted(() => ({ OS: "android" }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  ...(await import("../../../../web/src/test/reactHookHarness")).reactHookHarness,
  memo: (component: unknown) => component,
}));
vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("react-native", () => ({
  Modal: "Modal",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
  Platform: platform,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 16 }),
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../components/AppText", () => ({ AppText: "AppText" }));
vi.mock("../../components/CopyTextButton", () => ({ CopyTextButton: "CopyTextButton" }));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#808080" }));
vi.mock("../../i18n", () => ({ t: (key: string) => key }));

import {
  MessageTextSelection,
  MessageTextSelectionButton,
  useMessageTextSelection,
} from "./MessageTextSelection";

beforeEach(() => {
  hooks.reset();
  platform.OS = "android";
});

const renderSelection = (scope = "environment-a:thread-a") => {
  hooks.beginRender();
  return useMessageTextSelection(scope);
};

describe("手机正文选区", () => {
  it("保留打开时的全文、字素和 Markdown，增量与终态不更新已有选区", () => {
    const full = "  首段👩‍💻\r\n\r\n```ts\r\nconst stable = 1;\r\n```\r\n未显示的尾文\n";
    renderSelection().selectText(full);
    expect(renderSelection().text).toBe(full);
    // 会话可连续渲染后续正文与终态，只有用户再次打开才改变选择来源。
    for (let update = 0; update < 20; update++) {
      expect(renderSelection().text).toBe(full);
    }
  });

  it("关闭后释放正文，再次打开取最新的完整来源", () => {
    renderSelection().selectText("最初正文");
    renderSelection().close();
    expect(renderSelection().text).toBeNull();
    renderSelection().selectText("最初正文\n新增尾文");
    expect(renderSelection().text).toBe("最初正文\n新增尾文");
  });

  it("切换同名线程所在环境立即关闭，返回时不恢复旧选区", () => {
    renderSelection("environment-a:thread-a").selectText("环境 A 的正文");
    expect(renderSelection("environment-b:thread-a").text).toBeNull();
    expect(renderSelection("environment-a:thread-a").text).toBeNull();
    renderSelection("environment-a:thread-a").selectText("环境 A 的最新正文");
    expect(renderSelection("environment-a:thread-a").text).toBe("环境 A 的最新正文");
  });

  it.each(["android", "ios"])("%s 入口传完整消息，不裁剪空白或代码", (os) => {
    platform.OS = os;
    const text = "\n正文\n```ts\nconst x = 1;\n```\n尾文\n";
    const onSelect = vi.fn();
    hooks.beginRender();
    const button = visitElements(
      MessageTextSelectionButton({ text, onSelect }),
      (element) => element.props.accessibilityLabel === "messageTextSelection.action",
    );
    const press = button?.props.onPress;
    if (typeof press !== "function") throw new Error("缺少手机选择入口");
    press();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(text);
  });

  it("web 保留既有直接选区，不增加手机原生入口", () => {
    platform.OS = "web";
    hooks.beginRender();
    expect(MessageTextSelectionButton({ text: "正文", onSelect: vi.fn() })).toBeNull();
  });

  it("原生选择与全文复制使用同一固定正文，系统返回可以关闭", () => {
    const text = "全文\n新增但尚未揭示的尾文";
    const onClose = vi.fn();
    hooks.beginRender();
    const sheet = MessageTextSelection({ text, onClose });
    const selectedText = visitElements(sheet, (element) => element.props.selectable === true);
    const copy = visitElements(
      sheet,
      (element) => element.props.accessibilityLabel === "copyMessage",
    );
    const modal = visitElements(sheet, (element) => element.props.visible === true);
    expect(selectedText?.props.children).toBe(text);
    expect(copy?.props.text).toBe(text);
    expect(modal?.props.onRequestClose).toBe(onClose);
  });

  it("空消息没有入口，关闭状态不保留原生文本节点", () => {
    hooks.beginRender();
    expect(MessageTextSelectionButton({ text: "", onSelect: vi.fn() })).toBeNull();
    hooks.beginRender();
    const sheet = MessageTextSelection({ text: null, onClose: vi.fn() });
    expect(visitElements(sheet, (element) => element.props.selectable === true)).toBeNull();
    expect(visitElements(sheet, (element) => element.props.visible === false)).not.toBeNull();
  });
});
