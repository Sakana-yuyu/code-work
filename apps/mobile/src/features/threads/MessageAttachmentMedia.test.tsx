import { EnvironmentId } from "@codework/contracts";
import type { ReactNode } from "react";
// @ts-expect-error Mobile 未安装 DOM 类型，这里只核对静态标记和交互状态。
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../../../web/src/test/reactHookHarness";
import { visitElements } from "../../../../web/src/test/reactElementTree";

const mock = vi.hoisted(() => ({ uri: "https://example.test/asset?token=signed", open: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  ...(await import("../../../../web/src/test/reactHookHarness")).reactHookHarness,
}));
vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Image: () => <img alt="attachment" />,
  ActivityIndicator: () => <span>loading</span>,
}));
vi.mock("react-native-gesture-handler", () => ({
  TouchableOpacity: ({
    children,
    accessibilityLabel,
  }: {
    children: ReactNode;
    accessibilityLabel?: string;
  }) => <button aria-label={accessibilityLabel}>{children}</button>,
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../i18n", () => ({ t: (key: string) => key }));
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: mock.open }));
vi.mock("../../state/assets", () => ({ useAssetUrl: () => mock.uri }));

import { MessageAttachmentMedia } from "./MessageAttachmentMedia";

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  mock.uri = "https://example.test/asset?token=signed";
});

it.each(["audio", "file"] as const)(
  "%s 打开失败可见并可重试，旧链接结果不清除新错误",
  async (type) => {
    const render = () => {
      hooks.beginRender();
      return MessageAttachmentMedia({
        environmentId: EnvironmentId.make("environment-1"),
        attachment: {
          type,
          id: "attachment-1",
          name: "report.wav",
          mimeType: "audio/wav",
          sizeBytes: 44,
        },
        className: "size-24",
        onPressImage: vi.fn(),
      });
    };
    const press = () => {
      const button = visitElements(
        render(),
        (element) => typeof element.props.onPress === "function",
      );
      const action = button?.props.onPress;
      if (typeof action !== "function") throw new Error("缺少附件打开入口");
      return action();
    };
    mock.open.mockResolvedValueOnce(false);
    await press();
    expect(mock.open).toHaveBeenLastCalledWith(mock.uri, "file-preview");
    expect(renderToStaticMarkup(render())).toContain("attachmentOpenFailed");
    mock.open.mockResolvedValueOnce(true);
    await press();
    expect(renderToStaticMarkup(render())).not.toContain("attachmentOpenFailed");

    for (const oldOpened of [true, false]) {
      mock.uri = `https://example.test/old-asset?attempt=${oldOpened}`;
      let resolveOld: (opened: boolean) => void = () => {};
      mock.open.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveOld = resolve;
          }),
      );
      const old = press();
      mock.uri = `https://example.test/new-asset?attempt=${oldOpened}`;
      mock.open.mockResolvedValueOnce(false);
      await press();
      resolveOld(oldOpened);
      await old;
      expect(renderToStaticMarkup(render())).toContain("attachmentOpenFailed");
    }
  },
);
