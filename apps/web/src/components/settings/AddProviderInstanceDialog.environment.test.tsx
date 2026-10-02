import {
  EnvironmentId,
  ProviderDriverKind,
  type AcpRegistryCatalogEntry,
} from "@codework/contracts";
import type { ComponentProps, ElementType } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import { AcpRegistryCatalogPicker } from "./AcpRegistryCatalogPicker";
import { AddProviderInstanceWizardSteps } from "./AddProviderInstanceWizardSteps";
import { ProviderSettingsForm } from "./ProviderSettingsForm";
import { Button } from "../ui/button";
import { t } from "~/i18n";

const settingsHooks = vi.hoisted(() => ({
  read: vi.fn(() => ({ providerInstances: {} })),
  update: vi.fn(() => vi.fn()),
  save: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useEffect: reactHookHarness.useEffect,
    useMemo: reactHookHarness.useMemo,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: settingsHooks.read,
  useUpdateEnvironmentSettings: settingsHooks.update,
}));

import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";

const remoteEnvironmentId = EnvironmentId.make("remote-device");

describe("AddProviderInstanceDialog environment routing", () => {
  beforeEach(() => {
    hooks.reset();
    settingsHooks.read.mockClear();
    settingsHooks.update.mockClear();
    settingsHooks.save.mockReset();
    settingsHooks.update.mockReturnValue(settingsHooks.save);
  });

  it("reads and writes settings through the supplied environment", () => {
    hooks.beginRender();
    AddProviderInstanceDialog({
      open: true,
      environmentId: remoteEnvironmentId,
      environmentLabel: "Remote device",
      onOpenChange: vi.fn(),
    });

    expect(settingsHooks.read).toHaveBeenCalledWith(remoteEnvironmentId);
    expect(settingsHooks.update).toHaveBeenCalledWith(remoteEnvironmentId, expect.any(Function));
  });

  it.each([
    {
      id: "github-copilot-cli",
      label: "githubCopilot",
      version: "1.0.89",
      command: "npx -y @github/copilot@1.0.89 --acp",
      auth: "copilot-login",
    },
    {
      id: "gemini",
      label: "gemini",
      version: "0.61.0",
      command: "npx -y @google/gemini-cli@0.61.0 --acp",
      auth: "oauth-personal",
    },
    {
      id: "cline",
      label: "acpShortcut.cline",
      version: "3.0.65",
      command: "npx -y cline@3.0.65 --acp",
      auth: "",
    },
    {
      id: "qwen",
      label: "acpShortcut.qwen",
      version: "0.24.7",
      command: "npx -y @qwen-code/qwen-code@0.24.7 --acp",
      auth: "openai",
    },
  ] as const)("$id 快捷入口预填目录搜索与登录方式", async (entry) => {
    const render = () => {
      hooks.beginRender();
      return AddProviderInstanceDialog({
        open: true,
        environmentId: remoteEnvironmentId,
        environmentLabel: "Remote",
        onOpenChange: vi.fn(),
      });
    };
    let tree = render();
    const shortcut = visitElements(
      tree,
      (element) =>
        element.type === Button &&
        Array.isArray(element.props.children) &&
        element.props.children.includes(t(entry.label)),
    );
    expect(shortcut).not.toBeNull();
    (shortcut!.props.onClick as () => void)();
    tree = render();
    const picker = visitElements(tree, (element) => element.type === AcpRegistryCatalogPicker)!;
    expect(picker.props).toMatchObject({
      environmentId: remoteEnvironmentId,
      initialQuery: entry.id,
      selectedCommand: "",
    });
    (picker.props.onSelect as ComponentProps<typeof AcpRegistryCatalogPicker>["onSelect"])({
      id: entry.id,
      name: t(entry.label),
      description: "",
      version: entry.version,
      command: entry.command,
      authMethodId: entry.auth,
      availability: "installable",
    });
    tree = render();
    const save = visitElements(
      tree,
      (element) => element.type === Button && element.props.children === t("addInstance"),
    )!;
    await (save.props.onClick as () => Promise<void>)();
    expect(Object.values(settingsHooks.save.mock.lastCall?.[0].providerInstances)[0]).toMatchObject(
      {
        driver: "acpAgent",
        displayName: t(entry.label),
        config: {
          command: entry.command,
          authMethodId: entry.auth,
          supportsMcpServers: true,
        },
      },
    );
  });

  it("下载回填使用最新配置，保留下载期间的其它字段编辑", async () => {
    const render = () => {
      hooks.beginRender();
      return AddProviderInstanceDialog({
        open: true,
        initialDriver: ProviderDriverKind.make("acpAgent"),
        environmentId: remoteEnvironmentId,
        environmentLabel: "Remote",
        onOpenChange: vi.fn(),
      });
    };
    let tree = render();
    const steps = visitElements(
      tree,
      (element) => element.type === AddProviderInstanceWizardSteps,
    )!;
    (
      steps.props.onNavigation as ComponentProps<
        typeof AddProviderInstanceWizardSteps
      >["onNavigation"]
    )({
      kind: "navigate",
      step: 2,
    });
    tree = render();
    const picker = visitElements(tree, (element) => element.type === AcpRegistryCatalogPicker)!;
    const select = picker.props.onSelect as ComponentProps<
      typeof AcpRegistryCatalogPicker
    >["onSelect"];
    const form = visitElements(tree, (element) => element.type === ProviderSettingsForm)!;
    (form.props.onChange as ComponentProps<typeof ProviderSettingsForm>["onChange"])({
      routeThroughByok: true,
    });
    tree = render();
    select({
      id: "amp-acp",
      name: "Amp",
      description: "",
      version: "0.9.0",
      command: '"C:/isolated/amp-acp.exe"',
      availability: "installable",
    });
    tree = render();
    const save = visitElements(
      tree,
      (element) => element.type === Button && element.props.children === t("addInstance"),
    )!;
    await (save.props.onClick as () => Promise<void>)();
    expect(Object.values(settingsHooks.save.mock.lastCall?.[0].providerInstances)[0]).toMatchObject(
      {
        config: { command: '"C:/isolated/amp-acp.exe"', routeThroughByok: true },
      },
    );
  });

  it("目录环境随远程实例保存，换条目和修改命令不遗留旧参数", async () => {
    let tree: ReturnType<typeof AddProviderInstanceDialog> | null = null;
    const render = () => {
      hooks.beginRender();
      tree = AddProviderInstanceDialog({
        open: true,
        initialDriver: ProviderDriverKind.make("acpAgent"),
        environmentId: remoteEnvironmentId,
        environmentLabel: "Remote",
        onOpenChange: vi.fn(),
      });
    };
    const props = <T extends ElementType>(type: T): ComponentProps<T> => {
      const element = visitElements(tree, (element) => element.type === type);
      expect(element).not.toBeNull();
      return element!.props as ComponentProps<T>;
    };
    const entry: AcpRegistryCatalogEntry = {
      id: "auggie",
      name: "Auggie",
      description: "",
      version: "0.36.0",
      command: "npx -y @augmentcode/auggie@0.36.0 --acp",
      availability: "installable",
      supportsMcpServers: false,
      environment: [{ name: "AUGMENT_DISABLE_AUTO_UPDATE", value: "1", sensitive: false }],
    };
    const save = async () => {
      const button = visitElements(
        tree,
        (element) => element.type === Button && element.props.children === t("addInstance"),
      );
      expect(button).not.toBeNull();
      await (button!.props.onClick as () => Promise<void>)();
      const payload = settingsHooks.save.mock.lastCall?.[0];
      return Object.values(payload.providerInstances)[0];
    };
    render();
    props(AddProviderInstanceWizardSteps).onNavigation({ kind: "navigate", step: 2 });
    render();
    props(AcpRegistryCatalogPicker).onSelect(entry);
    render();
    expect(visitElements(tree, (element) => element.type === "code")?.props.children).toContain(
      "AUGMENT_DISABLE_AUTO_UPDATE",
    );
    expect(await save()).toMatchObject({
      config: { command: entry.command, supportsMcpServers: false },
      environment: entry.environment,
    });
    render();
    const { supportsMcpServers: _compatibilityDefault, ...plainEntry } = entry;
    props(AcpRegistryCatalogPicker).onSelect({ ...plainEntry, id: "plain", environment: [] });
    render();
    expect(await save()).toMatchObject({ environment: [], config: { supportsMcpServers: true } });
    props(AcpRegistryCatalogPicker).onSelect({
      ...plainEntry,
      id: "qwen-code",
      authMethodId: "openai",
    });
    render();
    expect(await save()).toMatchObject({ config: { authMethodId: "openai" } });
    props(AcpRegistryCatalogPicker).onSelect({
      ...plainEntry,
      id: "cline",
      command: "npx -y cline@3.0.65 --acp",
      authMethodId: "",
    });
    render();
    expect(await save()).toMatchObject({ config: { authMethodId: "" } });
    props(AcpRegistryCatalogPicker).onSelect({ ...plainEntry, id: "plain" });
    render();
    expect(await save()).toMatchObject({ config: { authMethodId: "login" } });
    render();
    props(AcpRegistryCatalogPicker).onSelect(entry);
    render();
    props(ProviderSettingsForm).onChange({ command: "manual-agent --acp" });
    render();
    expect(await save()).not.toHaveProperty("environment");
    render();
    props(ProviderSettingsForm).onChange({ command: entry.command });
    render();
    expect(props(AcpRegistryCatalogPicker).selectedEntryId).toBeUndefined();
    expect(await save()).not.toHaveProperty("environment");
    expect(settingsHooks.update).toHaveBeenLastCalledWith(
      remoteEnvironmentId,
      expect.any(Function),
    );
  });
});
