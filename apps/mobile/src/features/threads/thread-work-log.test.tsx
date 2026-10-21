import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import type { ThreadFeedActivity } from "../../lib/threadActivity";
import { reactHookHarness as hooks } from "../../../../web/src/test/reactHookHarness";

const animation = vi.hoisted(() => ({
  duration: vi.fn((milliseconds: number) => ({ milliseconds })),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  ...(await import("../../../../web/src/test/reactHookHarness")).reactHookHarness,
}));
vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("react-native", () => ({
  View: "View",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  LayoutAnimation: {
    Types: { easeInEaseOut: "easeInEaseOut" },
    Properties: { opacity: "opacity" },
  },
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: "AnimatedView" },
  FadeIn: animation,
}));
vi.mock("expo-haptics", () => ({}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../components/AppText", () => ({ AppText: "AppText" }));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#808080" }));
vi.mock("../../i18n", () => ({ t: (key: string) => key }));

import { ThreadWorkLog, ThreadWorkLogEntryFrame } from "./thread-work-log";

const now = "2026-10-12T03:00:00.000Z";
const child = "可选的完整正文";
const activityFor = (id: string, source: string): ThreadFeedActivity => ({
  id,
  createdAt: "2026-10-11T03:00:00.000Z",
  turnId: null,
  summary: "读取文件",
  detail: "简短预览",
  canExpand: true,
  getFullDetail: () => source,
  getCopyText: () => source,
  icon: "command",
  toolLike: true,
  status: "success",
});
const renderLog = (props: Parameters<typeof ThreadWorkLog>[0]) => {
  hooks.beginRender();
  const elements: ReactElement<{ children?: ReactNode }>[] = [];
  const visit = (node: ReactNode) => {
    Children.forEach(node, (element) => {
      if (!isValidElement<{ children?: ReactNode }>(element)) return;
      elements.push(element);
      visit(element.props.children);
    });
  };
  visit(ThreadWorkLog(props));
  return elements;
};
const render = (createdAt: string, children = child) => {
  hooks.beginRender();
  const frame = ThreadWorkLogEntryFrame({ createdAt, children });
  if (!isValidElement<{ children: string; entering?: { milliseconds: number } }>(frame))
    throw new Error("活动容器缺失");
  return frame;
};

beforeEach(() => {
  hooks.reset();
  animation.duration.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

describe("历史活动容器的挂载与选择边界", () => {
  it.each(["2026-10-11T03:00:00.000Z", "invalid-date"])(
    "历史或无效时间 %s 直接使用普通 View，不创建动画",
    (createdAt) => {
      const frame = render(createdAt);
      expect(frame.type).toBe("View");
      expect(frame.props.children).toBe(child);
      expect(frame.props.entering).toBeUndefined();
      expect(animation.duration).not.toHaveBeenCalled();
    },
  );

  it("新活动保持 200ms 入场，时间越过窗口后不更换父节点或动画对象", () => {
    const first = render(now);
    expect(first.type).toBe("AnimatedView");
    expect(first.props.entering).toEqual({ milliseconds: 200 });
    vi.advanceTimersByTime(5_000);
    const next = render(now, "增量与详情更新");
    expect(next.type).toBe(first.type);
    expect(next.props.entering).toBe(first.props.entering);
    expect(next.props.children).toBe("增量与详情更新");
    expect(animation.duration).toHaveBeenCalledTimes(1);
  });

  it("已挂载的历史容器不因后续时间字段更新而重建可选子节点", () => {
    const first = render("2026-10-11T03:00:00.000Z");
    const next = render(now, "最新详情");
    expect(next.type).toBe(first.type);
    expect(next.type).toBe("View");
    expect(next.props.children).toBe("最新详情");
    expect(animation.duration).not.toHaveBeenCalled();
  });

  it("虚拟列表离屏后重挂载已过时的活动不会重播入场", () => {
    expect(render(now).type).toBe("AnimatedView");
    vi.advanceTimersByTime(5_000);
    hooks.reset();
    expect(render(now).type).toBe("View");
    expect(animation.duration).toHaveBeenCalledTimes(1);
  });

  it("真实日志行保留活动身份、展开详情和长按复制的完整来源", () => {
    const source = "完整命令\r\n保留换行与 👩‍💻";
    const activity = activityFor("tool-601", source);
    const copy = vi.fn();
    const toggle = vi.fn();
    const elements = renderLog({
      activities: [activity],
      copiedRowId: null,
      expandedRows: { [activity.id]: true },
      iconSubtleColor: "#808080",
      onCopyRow: copy,
      onToggleRow: toggle,
    });
    const frame = elements.find((element) => element.type === ThreadWorkLogEntryFrame);
    expect(frame?.key).toBe(activity.id);
    const pressable = elements.find((element) => String(element.type) === "Pressable");
    if (!isValidElement<{ onLongPress: () => void }>(pressable)) throw new Error("复制入口缺失");
    pressable.props.onLongPress();
    expect(copy).toHaveBeenCalledWith(activity.id, source);
    expect(toggle).not.toHaveBeenCalled();
    const detail = elements.find((element) => element.props.children === source);
    if (!isValidElement<{ selectable: boolean }>(detail)) throw new Error("可选详情缺失");
    expect(detail.props.selectable).toBe(true);
  });

  it("思考与进度标题隐藏 emoji，展开正文交给共用渲染器且复制原文", () => {
    const source = '⌛ 18s · 等待首个 token\n`const icon = "😀"`';
    const activity = {
      ...activityFor("reasoning-emoji", source),
      summary: "⏳正在连接",
      detail: "✅已收到请求",
      toolLike: false,
    };
    const copy = vi.fn();
    const renderTextDetail = vi.fn((text: string) => <span>{text}</span>);
    const elements = renderLog({
      activities: [activity],
      copiedRowId: null,
      expandedRows: { [activity.id]: true },
      iconSubtleColor: "#808080",
      onCopyRow: copy,
      onToggleRow: vi.fn(),
      renderTextDetail,
    });
    const pressable = elements.find((element) => String(element.type) === "Pressable");
    if (!isValidElement<{ accessibilityLabel: string; onLongPress: () => void }>(pressable))
      throw new Error("活动行缺失");
    expect(pressable.props.accessibilityLabel).toBe("正在连接 已收到请求");
    expect(renderTextDetail).toHaveBeenCalledWith(source);
    pressable.props.onLongPress();
    expect(copy).toHaveBeenCalledWith(activity.id, source);
  });

  it("历史单行复用后长按复制更新到新活动的身份与全文", () => {
    const copy = vi.fn();
    const keys = [];
    for (const row of [
      activityFor("tool-601", "第一份来源"),
      activityFor("tool-602", "第二份来源 👩‍💻"),
    ]) {
      const elements = renderLog({
        activities: [row],
        reuseHistoricalRow: true,
        copiedRowId: null,
        expandedRows: {},
        iconSubtleColor: "#808080",
        onCopyRow: copy,
        onToggleRow: vi.fn(),
      });
      keys.push(elements.find((element) => element.type === ThreadWorkLogEntryFrame)?.key);
      const pressable = elements.find((element) => String(element.type) === "Pressable");
      if (!isValidElement<{ onLongPress: () => void }>(pressable))
        throw new Error("历史复制入口缺失");
      pressable.props.onLongPress();
    }
    expect(keys[1]).toBe(keys[0]);
    expect(copy.mock.calls).toEqual([
      ["tool-601", "第一份来源"],
      ["tool-602", "第二份来源 👩‍💻"],
    ]);
  });

  it("多行容器即便收到复用标记也保留每个活动的独立身份", () => {
    const rows = [activityFor("tool-601", "第一份来源"), activityFor("tool-602", "第二份来源")];
    const elements = renderLog({
      activities: rows,
      reuseHistoricalRow: true,
      copiedRowId: null,
      expandedRows: {},
      iconSubtleColor: "#808080",
      onCopyRow: vi.fn(),
      onToggleRow: vi.fn(),
    });
    expect(
      elements
        .filter((element) => element.type === ThreadWorkLogEntryFrame)
        .map((element) => element.key),
    ).toEqual(rows.map((row) => row.id));
  });
});
