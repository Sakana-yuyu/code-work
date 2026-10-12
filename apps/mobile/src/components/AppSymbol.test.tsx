import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import IconCheck from "@tabler/icons-react-native/IconCheck";
import IconEye from "@tabler/icons-react-native/IconEye";
import IconSelectAll from "@tabler/icons-react-native/IconSelectAll";
import { isValidElement } from "react";
import type { SymbolViewProps } from "expo-symbols";

const platform = vi.hoisted(() => ({ OS: "android" }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  memo: (component: unknown) => component,
}));
vi.mock("react-native", () => ({
  Platform: platform,
  Modal: "Modal",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
}));
vi.mock("react-native-svg", () => ({ Svg: "Svg" }));
vi.mock("expo-symbols", () => ({ SymbolView: "ExpoSymbolView" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({}) }));
vi.mock("../lib/useThemeColor", () => ({ useThemeColor: () => "#808080" }));
vi.mock("../i18n", () => ({ t: (key: string) => key }));
vi.mock("./AppText", () => ({ AppText: "AppText" }));
vi.mock("./CopyTextButton", () => ({ CopyTextButton: "CopyTextButton" }));

import { SymbolView } from "./AppSymbol";
import { MessageTextSelectionButton } from "../features/threads/MessageTextSelection";

beforeEach(() => {
  platform.OS = "android";
});

describe("跨平台图标的可见性边界", () => {
  it("Android 真实选区入口解析到已安装 SDK 的选择图标，而不是空点击区", () => {
    const action = vi.fn();
    const button = MessageTextSelectionButton({ text: "完整正文", onSelect: action });
    if (
      !isValidElement<{
        accessibilityLabel: string;
        children: React.ReactNode;
        onPress: () => void;
      }>(button)
    )
      throw new Error("选区按钮缺失");
    expect(button.props.accessibilityLabel).toBe("messageTextSelection.action");
    const symbol = button.props.children;
    if (!isValidElement<SymbolViewProps>(symbol)) throw new Error("选区符号节点缺失");
    expect(symbol.type).toBe(SymbolView);
    const icon = SymbolView(symbol.props);
    if (!isValidElement(icon)) throw new Error("选区图标为空，不能只提供点击区");
    expect(icon.type).toBe(IconSelectAll);
    expect(icon.props).toMatchObject({ size: 14 });
    button.props.onPress();
    expect(action).toHaveBeenCalledWith("完整正文");
  });

  it("已有 Material 名称优先于 SF 名称，并保留尺寸、颜色和辅助标签", () => {
    const icon = SymbolView({
      name: { android: "check", ios: "eye" },
      size: 22,
      tintColor: "#123456",
      accessibilityLabel: "操作已完成",
      testID: "finished-icon",
    });
    if (!isValidElement(icon)) throw new Error("已有图标缺失");
    expect(icon.type).toBe(IconCheck);
    expect(icon.props).toMatchObject({
      size: 22,
      color: "#123456",
      strokeWidth: 2,
      accessibilityLabel: "操作已完成",
      testID: "finished-icon",
    });
    const eye = SymbolView({ name: "eye" });
    if (!isValidElement(eye)) throw new Error("SF 兼容图标缺失");
    expect(eye.type).toBe(IconEye);
  });

  it("SDK 合法但包装器尚未映射的名称保留调用者回退或空值", () => {
    expect(SymbolView({ name: { android: "wifi" }, fallback: "回退内容" })).toBe("回退内容");
    expect(SymbolView({ name: { android: "wifi" } })).toBeNull();
  });

  it("iOS 继续交给原生符号组件，并保留所有调用参数", () => {
    platform.OS = "ios";
    const props = {
      name: "eye",
      size: 18,
      tintColor: "#112233",
      accessibilityLabel: "查看",
    } as const;
    const icon = SymbolView(props);
    if (!isValidElement(icon)) throw new Error("原生 iOS 符号组件缺失");
    expect(icon.type).toBe("ExpoSymbolView");
    expect(icon.props).toEqual(props);
  });
});
