import { EnvironmentId, type AcpRegistryCatalogEntry } from "@codework/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import type { ComponentProps } from "react";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const mock = vi.hoisted(() => ({
  install: vi.fn(),
  effects: [] as Array<() => void | (() => void)>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  ...(await import("../../test/reactHookHarness").then((module) => module.reactHookHarness)),
  useEffect: (effect: () => void | (() => void)) => {
    hooks.useEffect(effect);
    mock.effects.push(effect);
  },
}));
vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("~/i18n", () => ({ t: (key: string) => key }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => AsyncResult.success({ entries: [binary], error: null }),
}));
vi.mock("../../state/server", () => ({
  byokEnvironment: { acpRegistryCatalog: () => "catalog", installAcpRegistryBinary: "install" },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mock.install }));

import { AcpRegistryCatalogPicker } from "./AcpRegistryCatalogPicker";

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
type Props = ComponentProps<typeof AcpRegistryCatalogPicker>;
let props: Props;
let cleanup: (() => void) | void;
const render = () => {
  hooks.beginRender();
  mock.effects = [];
  return AcpRegistryCatalogPicker(props);
};
// 手动运行生命周期 effect；Hook harness 没有 React commit 阶段。
const commit = () => {
  cleanup?.();
  for (const effect of mock.effects) cleanup = effect();
};
const click = () => {
  const button = visitElements(
    render(),
    (element) => element.props["aria-label"] === "acpRegistryDownloadInstallAgent",
  );
  expect(button).not.toBeNull();
  (button!.props.onClick as () => void)();
};
const deferredInstall = () => {
  let resolve!: (outcome: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  mock.install.mockReturnValue(promise);
  return { promise, resolve };
};

beforeEach(() => {
  hooks.reset();
  cleanup = undefined;
  mock.install.mockReset();
  props = { environmentId: EnvironmentId.make("origin"), selectedCommand: "", onSelect: vi.fn() };
  render();
  commit();
});

it("正常完成只回填发起环境的真实命令，渲染前连点只下载一次", async () => {
  const pending = deferredInstall();
  const button = visitElements(
    render(),
    (element) => element.props["aria-label"] === "acpRegistryDownloadInstallAgent",
  )!;
  const onClick = button.props.onClick as () => void;
  onClick();
  onClick();
  expect(mock.install).toHaveBeenCalledTimes(1);
  expect(mock.install).toHaveBeenCalledWith({
    environmentId: props.environmentId,
    input: { entryId: binary.id },
  });
  pending.resolve({ _tag: "Success", value: { command: '"C:\\managed\\amp.exe"' } });
  await pending.promise;
  expect(props.onSelect).toHaveBeenCalledOnce();
  expect(props.onSelect).toHaveBeenCalledWith({
    ...binary,
    command: '"C:\\managed\\amp.exe"',
    availability: "installable",
  });
});

it.each(["environment", "command", "entry", "unmount"])(
  "%s 变更后不接收迟到安装结果",
  async (change) => {
    const pending = deferredInstall();
    const originalSelect = props.onSelect;
    click();
    if (change === "unmount") cleanup?.();
    else {
      props = {
        ...props,
        ...(change === "environment"
          ? { environmentId: EnvironmentId.make("other"), onSelect: vi.fn() }
          : {}),
        ...(change === "command" ? { selectedCommand: "manual --acp" } : {}),
        ...(change === "entry" ? { selectedEntryId: "other" } : {}),
      };
      render();
      commit();
      expect(
        visitElements(
          render(),
          (element) => element.props["aria-label"] === "acpRegistryDownloadInstallAgent",
        )?.props.disabled,
      ).toBe(true);
    }
    pending.resolve({ _tag: "Success", value: { command: "late-install" } });
    await pending.promise;
    expect(originalSelect).not.toHaveBeenCalled();
    expect(props.onSelect).not.toHaveBeenCalled();
  },
);

it("旧环境的失败不污染当前表单，当前失败显示且允许重试", async () => {
  const pending = deferredInstall();
  click();
  props = { ...props, environmentId: EnvironmentId.make("other") };
  render();
  commit();
  pending.resolve({ _tag: "Failure", cause: Cause.fail(new Error("old-download")) });
  await pending.promise;
  expect(visitElements(render(), (element) => element.props.role === "alert")).toBeNull();
  mock.install.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.fail(new Error("current-download")),
  });
  click();
  await mock.install.mock.results.at(-1)!.value;
  expect(visitElements(render(), (element) => element.props.role === "alert")).not.toBeNull();
  expect(
    visitElements(
      render(),
      (element) => element.props["aria-label"] === "acpRegistryDownloadInstallAgent",
    )?.props.disabled,
  ).toBe(false);
});
