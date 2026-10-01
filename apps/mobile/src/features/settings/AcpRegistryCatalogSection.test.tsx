import { EnvironmentId, type AcpRegistryCatalogEntry } from "@codework/contracts";
import type { ComponentProps, ReactNode } from "react";
// @ts-expect-error Mobile 未安装 DOM 类型，此测试只做静态标记检查。
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../../../web/src/test/reactHookHarness";
import { visitElements } from "../../../../web/src/test/reactElementTree";

const mock = vi.hoisted(() => ({
  install: vi.fn(),
  effects: [] as Array<() => void | (() => void)>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  ...(await import("../../../../web/src/test/reactHookHarness").then(
    (module) => module.reactHookHarness,
  )),
  useEffect: (effect: () => void | (() => void)) => {
    hooks.useEffect(effect);
    mock.effects.push(effect);
  },
}));
vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("react-native", () => ({
  View: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  Pressable: ({
    children,
    accessibilityLabel,
  }: {
    children: ReactNode;
    accessibilityLabel?: string;
  }) => <button aria-label={accessibilityLabel}>{children}</button>,
  Linking: { openURL: vi.fn() },
}));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AppTextInput: () => <input />,
}));
vi.mock("../../i18n", () => ({ t: (key: string) => key }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { entries: [binary], error: null }, error: null }),
}));
vi.mock("../../state/server", () => ({
  byokEnvironment: { acpRegistryCatalog: () => "catalog", installAcpRegistryBinary: "install" },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mock.install }));

import { AcpRegistryCatalogSection } from "./AcpRegistryCatalogSection";

const binary: AcpRegistryCatalogEntry = {
  id: "amp-acp",
  name: "Amp",
  description: "",
  version: "0.9.0",
  command: null,
  availability: "manual",
  binaryDistribution: {
    platform: "windows-x86_64",
    archiveUrl: "https://example.test/amp.zip",
    sha256: "a".repeat(64),
    cmd: "amp.exe",
    args: [],
  },
};
type Props = ComponentProps<typeof AcpRegistryCatalogSection>;
let props: Props;
let cleanup: (() => void) | void;
const render = () => {
  hooks.beginRender();
  mock.effects = [];
  return AcpRegistryCatalogSection(props);
};
// 共用已有 Hook harness；手动提交生命周期，设备渲染另行验收。
const commit = () => {
  cleanup?.();
  for (const effect of mock.effects) cleanup = effect();
};
const row = () => {
  const element = visitElements(
    render(),
    (element) => typeof element.props.onDownload === "function",
  );
  expect(element).not.toBeNull();
  return element!;
};

beforeEach(() => {
  hooks.reset();
  cleanup = undefined;
  mock.install.mockReset();
  props = {
    environmentId: EnvironmentId.make("origin"),
    selectedEntry: null,
    disabled: false,
    onSelect: vi.fn(),
  };
  render();
  commit();
});

it("已下载命令由父级选中项传递，按钮与详情不再读取原目录 null", () => {
  const command = '"C:\\managed\\amp.exe"';
  props = { ...props, selectedEntry: { ...binary, command, availability: "installable" } };
  const html = renderToStaticMarkup(render());
  expect(html).toContain("providersMobile.acpCatalogSelected");
  expect(html).toContain("C:\\managed\\amp.exe");
  expect(html).not.toContain("providersMobile.acpCatalogDownloadAgent");
});

it("安装行允许窄屏换行，避免安装按钮把目录行撑出视口", () => {
  const html = renderToStaticMarkup(render());
  expect(html).toContain("flex-wrap");
  expect(html).toContain("providersMobile.acpCatalogDownloadAgent");

  for (const width of [360, 1280] as const) {
    const constrained = renderToStaticMarkup(
      <div style={{ maxWidth: width, width }} data-viewport={width}>
        {render()}
      </div>,
    );
    expect(constrained).toContain(`data-viewport="${width}"`);
    expect(constrained).toContain("flex-wrap");
    expect(constrained).toContain("providersMobile.acpCatalogDownloadAgent");
  }
});

it("同一下载渲染前连点只发送一次，成功命令完整回填", async () => {
  const pending = Promise.withResolvers<unknown>();
  mock.install.mockReturnValue(pending.promise);
  const onDownload = row().props.onDownload as () => void;
  onDownload();
  onDownload();
  expect(mock.install).toHaveBeenCalledTimes(1);
  pending.resolve({ _tag: "Success", value: { command: "installed --acp" } });
  await pending.promise;
  expect(props.onSelect).toHaveBeenCalledWith({
    ...binary,
    command: "installed --acp",
    availability: "installable",
  });
});

it.each(["environment", "selection", "disabled", "unmount"])(
  "%s 改变后迟到成功不能回填",
  async (change) => {
    const pending = Promise.withResolvers<unknown>();
    mock.install.mockReturnValue(pending.promise);
    (row().props.onDownload as () => void)();
    if (change === "unmount") cleanup?.();
    else {
      props = {
        ...props,
        ...(change === "environment" ? { environmentId: EnvironmentId.make("other") } : {}),
        ...(change === "selection" ? { selectedEntry: { ...binary, id: "other" } } : {}),
        ...(change === "disabled" ? { disabled: true } : {}),
      };
      render();
      commit();
    }
    pending.resolve({ _tag: "Success", value: { command: "late-install" } });
    await pending.promise;
    expect(props.onSelect).not.toHaveBeenCalled();
  },
);
