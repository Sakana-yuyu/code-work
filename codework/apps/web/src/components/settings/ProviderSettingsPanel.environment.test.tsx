import type { ReactElement } from "react";
import * as Cause from "effect/Cause";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UnifiedSettings,
} from "@codework/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const atoms = vi.hoisted(() => ({
  providers: null as ReadonlyArray<ServerProvider> | null,
  providersAtom: Symbol("providers"),
  refreshProviders: Symbol("refreshProviders"),
  updateProvider: Symbol("updateProvider"),
  updateSettings: Symbol("updateSettings"),
}));

const commands = vi.hoisted(() => ({
  refresh: vi.fn(),
  updateProvider: vi.fn(),
  updateSettings: vi.fn(),
}));

const settingsState = vi.hoisted(() => ({
  value: null as UnifiedSettings | null,
  readEnvironmentIds: [] as EnvironmentId[],
  updateEnvironmentIds: [] as EnvironmentId[],
  updateSettings: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => atoms.providers,
}));

vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    providersValueAtom: () => atoms.providersAtom,
    refreshProviders: atoms.refreshProviders,
    updateProvider: atoms.updateProvider,
    updateSettings: atoms.updateSettings,
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) =>
    atom === atoms.refreshProviders
      ? commands.refresh
      : atom === atoms.updateSettings
        ? commands.updateSettings
        : commands.updateProvider,
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (environmentId: EnvironmentId) => {
    settingsState.readEnvironmentIds.push(environmentId);
    return settingsState.value;
  },
  useUpdateEnvironmentSettings: (environmentId: EnvironmentId) => {
    settingsState.updateEnvironmentIds.push(environmentId);
    return settingsState.updateSettings;
  },
}));

vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => ({ data: null, error: null, isPending: false, refresh: vi.fn() }),
}));

vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({ data: null, hasError: false, isPending: true }),
}));

import { EnvironmentProviderSettings } from "./ProviderSettingsPanel";
import {
  formFromMulticaRuntimeInstance,
  multicaRuntimeDraftFingerprint,
} from "./MulticaRuntimeSettings.logic";
import { persistMulticaRuntimeDraft } from "./MulticaRuntimeSettings.controller";
import { t } from "~/i18n";

const environmentId = EnvironmentId.make("remote-device");
const codexId = ProviderInstanceId.make("codex");
const customId = ProviderInstanceId.make("codex_work");

function provider(): ServerProvider {
  return {
    instanceId: codexId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-24T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "pnpm add -g @openai/codex@latest",
      canUpdate: true,
      checkedAt: "2026-07-24T12:00:00.000Z",
      message: "Update available.",
    },
  };
}

function renderPanel(options?: {
  readonly readOnly?: boolean;
}): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return EnvironmentProviderSettings({
    environmentId,
    environmentLabel: "Remote device",
    ...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  }) as ReactElement<Record<string, unknown>>;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("EnvironmentProviderSettings routing", () => {
  beforeEach(() => {
    hooks.reset();
    atoms.providers = null;
    settingsState.value = DEFAULT_UNIFIED_SETTINGS;
    settingsState.readEnvironmentIds = [];
    settingsState.updateEnvironmentIds = [];
    settingsState.updateSettings.mockReset();
    commands.refresh.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.updateProvider.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.updateSettings.mockReset().mockResolvedValue({ _tag: "Success" });
  });

  it("coalesces a nullable provider snapshot before rendering array-backed UI", () => {
    expect(() => renderPanel()).not.toThrow();
    expect(settingsState.readEnvironmentIds).toEqual([environmentId]);
    expect(settingsState.updateEnvironmentIds).toEqual([environmentId]);
  });

  it("routes refresh and provider update commands to the selected environment", async () => {
    atoms.providers = [provider()];
    const panel = renderPanel();
    const refreshButton = visitElements(
      panel,
      (element) => element.props["aria-label"] === t("refreshProviderStatus"),
    );
    expect(refreshButton).not.toBeNull();
    (refreshButton?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.refresh).toHaveBeenCalledWith({ environmentId, input: {} });

    const providerCard = visitElements(
      panel,
      (element) =>
        element.props.instanceId === codexId && typeof element.props.onRunUpdate === "function",
    );
    expect(providerCard).not.toBeNull();
    (providerCard?.props.onRunUpdate as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.updateProvider).toHaveBeenCalledWith({
      environmentId,
      input: { provider: ProviderDriverKind.make("codex"), instanceId: codexId },
    });
  });

  it("keeps provider selection available while write controls are read only", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
    };
    atoms.providers = [provider()];
    let panel = renderPanel({ readOnly: true });

    const inertWrapper = visitElements(panel, (element) => element.props.inert === true);
    expect(inertWrapper).not.toBeNull();

    const customRow = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "list",
    );
    expect(customRow?.props.readOnly).toBe(true);
    expect(customRow?.props.onSelect).toBeTypeOf("function");
    (customRow?.props.onSelect as (() => void) | undefined)?.();

    panel = renderPanel({ readOnly: true });
    const customEditor = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "editor",
    );
    expect(customEditor).not.toBeNull();

    const notice = visitElements(
      panel,
      (element) => element.props.title === t("limitedPermissions"),
    );
    expect(notice).not.toBeNull();

    const providersSection = visitElements(
      panel,
      (element) => element.props.id === "providers" && "headerAction" in element.props,
    );
    expect(providersSection?.props.headerAction).toBeNull();
    expect(
      visitElements(panel, (element) => element.props["aria-label"] === t("refreshProviderStatus")),
    ).toBeNull();
  });

  it("keeps the editable layout interactive when not read only", () => {
    atoms.providers = [provider()];
    const panel = renderPanel();
    expect(visitElements(panel, (element) => element.props.inert === true)).toBeNull();
    expect(
      visitElements(panel, (element) => element.props.title === "Limited permissions"),
    ).toBeNull();
    const providersSection = visitElements(
      panel,
      (element) => element.props.id === "providers" && "headerAction" in element.props,
    );
    expect(providersSection?.props.headerAction).not.toBeNull();
  });

  it("不在通用 Provider 卡片中重复渲染 Multica Runtime", () => {
    const multicaId = ProviderInstanceId.make("multica_local");
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [multicaId]: {
          driver: ProviderDriverKind.make("multica"),
          config: {
            runtimeId: "multica:daemon-1:runtime-1",
            daemonId: "daemon-1",
            daemonRuntimeId: "runtime-1",
            baseUrl: "http://127.0.0.1:9000",
            headers: [],
            assigneeRoutes: [],
          },
        },
      },
    };
    const panel = renderPanel();

    expect(
      visitElements(
        panel,
        (element) => element.props.instanceId === multicaId && element.props.mode === "list",
      ),
    ).toBeNull();
  });

  it("将 Multica 保存的客户端版本随 settings RPC 一并发送", async () => {
    const multicaId = ProviderInstanceId.make("multica_local");
    const multicaInstance = {
      driver: ProviderDriverKind.make("multica"),
      enabled: true,
      settingsRevision: "revision-v1",
      environment: [{ name: "MULTICA_TOKEN", value: "", sensitive: true, valueRedacted: true }],
      config: {
        runtimeId: "multica:daemon-1:runtime-1",
        daemonId: "daemon-1",
        daemonRuntimeId: "runtime-1",
        baseUrl: "http://127.0.0.1:9000",
        headers: [{ headerName: "Private-Token", environmentVariable: "MULTICA_TOKEN" }],
        assigneeRoutes: [],
      },
    };
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: { [multicaId]: multicaInstance },
    };
    const panel = renderPanel();
    const runtimePanel = visitElements(panel, (element) => {
      const props = element.props as {
        readonly state?: { readonly status?: string };
        readonly onSave?: unknown;
        readonly onDelete?: unknown;
      };
      return (
        props.state?.status === "ready" &&
        typeof props.onSave === "function" &&
        typeof props.onDelete === "function"
      );
    });
    expect(runtimePanel).not.toBeNull();
    const expectedFingerprint = multicaRuntimeDraftFingerprint(
      formFromMulticaRuntimeInstance(multicaId, multicaInstance)!,
    );
    const saveRuntime = runtimePanel?.props.onSave;
    expect(saveRuntime).toBeTypeOf("function");

    await (saveRuntime as (request: Record<string, unknown>) => Promise<void>)({
      originalInstanceId: "multica_local",
      expectedFingerprint,
      expectedRevision: "revision-v1",
      instanceId: multicaId,
      config: multicaInstance.config,
      environment: multicaInstance.environment,
    });

    const {
      settingsRevision: _serverOwnedRevision,
      enabled: _enabled,
      ...savedInstance
    } = multicaInstance;

    expect(commands.updateSettings).toHaveBeenCalledWith({
      environmentId,
      input: {
        patch: {
          providerInstances: { [multicaId]: { ...savedInstance, enabled: undefined } },
          multicaProviderInstancePreconditions: [
            { instanceId: multicaId, expectedRevision: "revision-v1" },
          ],
        },
      },
    });
  });

  it("将 Multica 重命名和删除编码为局部 CAS mutation", async () => {
    const sourceId = ProviderInstanceId.make("multica_source");
    const targetId = ProviderInstanceId.make("multica_target");
    const sourceInstance = {
      driver: ProviderDriverKind.make("multica"),
      enabled: true,
      settingsRevision: "revision-v1",
      config: {
        runtimeId: "multica:daemon-1:runtime-1",
        daemonId: "daemon-1",
        daemonRuntimeId: "runtime-1",
        baseUrl: "http://127.0.0.1:9000",
        headers: [],
        assigneeRoutes: [],
      },
    };
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: { [sourceId]: sourceInstance },
    };
    const panel = renderPanel();
    const runtimePanel = visitElements(
      panel,
      (element) =>
        (element.props as { readonly state?: { readonly status?: string } }).state?.status ===
          "ready" &&
        typeof element.props.onSave === "function" &&
        typeof element.props.onDelete === "function",
    );
    const sourceDraft = formFromMulticaRuntimeInstance(sourceId, sourceInstance);
    expect(sourceDraft).not.toBeNull();
    if (runtimePanel === null) throw new Error("missing Multica runtime panel");

    await (runtimePanel.props.onSave as (request: Record<string, unknown>) => Promise<void>)({
      originalInstanceId: sourceId,
      expectedFingerprint: multicaRuntimeDraftFingerprint(sourceDraft!),
      expectedRevision: "revision-v1",
      instanceId: targetId,
      config: sourceInstance.config,
      environment: [],
    });

    expect(commands.updateSettings).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        patch: {
          providerInstances: {
            [targetId]: {
              driver: ProviderDriverKind.make("multica"),
              enabled: undefined,
              config: sourceInstance.config,
              environment: [],
            },
          },
          multicaProviderInstancePreconditions: [
            { instanceId: sourceId, expectedRevision: "revision-v1" },
            { instanceId: targetId, expectedRevision: null },
          ],
        },
      },
    });

    await (runtimePanel.props.onDelete as (request: Record<string, unknown>) => Promise<void>)({
      instanceId: sourceId,
      expectedRevision: "revision-v1",
    });
    expect(commands.updateSettings).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        patch: {
          providerInstances: {},
          multicaProviderInstancePreconditions: [
            { instanceId: sourceId, expectedRevision: "revision-v1" },
          ],
        },
      },
    });
  });

  it("设置刷新后仍使用编辑会话捕获的 Multica revision", async () => {
    const multicaId = ProviderInstanceId.make("multica_stale_session");
    const versionOne = {
      driver: ProviderDriverKind.make("multica"),
      enabled: true,
      settingsRevision: "revision-v1",
      environment: [{ name: "MULTICA_TOKEN", value: "", sensitive: true, valueRedacted: true }],
      config: {
        runtimeId: "multica:daemon-1:runtime-1",
        daemonId: "daemon-1",
        daemonRuntimeId: "runtime-1",
        baseUrl: "http://127.0.0.1:9000",
        headers: [{ headerName: "Authorization", environmentVariable: "MULTICA_TOKEN" }],
        assigneeRoutes: [],
      },
    };
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: { [multicaId]: versionOne },
    };
    const versionTwo = { ...versionOne, settingsRevision: "revision-v2" };
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: { [multicaId]: versionTwo },
    };
    const panel = renderPanel();
    const runtimePanel = visitElements(
      panel,
      (element) =>
        (element.props as { readonly state?: { readonly status?: string } }).state?.status ===
          "ready" &&
        typeof element.props.onSave === "function" &&
        typeof element.props.onDelete === "function",
    );
    const draft = formFromMulticaRuntimeInstance(multicaId, versionTwo);
    expect(draft).not.toBeNull();
    if (runtimePanel === null) throw new Error("missing Multica runtime panel");

    await (runtimePanel.props.onSave as (request: Record<string, unknown>) => Promise<void>)({
      originalInstanceId: multicaId,
      expectedFingerprint: multicaRuntimeDraftFingerprint(draft!),
      expectedRevision: "revision-v1",
      instanceId: multicaId,
      config: versionTwo.config,
      environment: versionTwo.environment,
    });

    expect(commands.updateSettings).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        patch: {
          providerInstances: {
            [multicaId]: {
              driver: ProviderDriverKind.make("multica"),
              enabled: undefined,
              config: versionTwo.config,
              environment: versionTwo.environment,
            },
          },
          multicaProviderInstancePreconditions: [
            { instanceId: multicaId, expectedRevision: "revision-v1" },
          ],
        },
      },
    });

    await (runtimePanel.props.onDelete as (request: Record<string, unknown>) => Promise<void>)({
      instanceId: multicaId,
      expectedRevision: "revision-v1",
    });
    expect(commands.updateSettings).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        patch: {
          providerInstances: {},
          multicaProviderInstancePreconditions: [
            { instanceId: multicaId, expectedRevision: "revision-v1" },
          ],
        },
      },
    });
  });

  it("将 settings RPC 的类型化失败映射为 Multica 保存冲突", async () => {
    const multicaId = ProviderInstanceId.make("multica_local");
    const multicaInstance = {
      driver: ProviderDriverKind.make("multica"),
      enabled: true,
      settingsRevision: "revision-v1",
      environment: [{ name: "MULTICA_TOKEN", value: "", sensitive: true, valueRedacted: true }],
      config: {
        runtimeId: "multica:daemon-1:runtime-1",
        daemonId: "daemon-1",
        daemonRuntimeId: "runtime-1",
        baseUrl: "http://127.0.0.1:9000",
        headers: [{ headerName: "Private-Token", environmentVariable: "MULTICA_TOKEN" }],
        assigneeRoutes: [],
      },
    };
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: { [multicaId]: multicaInstance },
    };
    commands.updateSettings.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail({
        _tag: "ServerSettingsConflictError",
        providerInstanceId: multicaId,
        message: "不应显示",
      }),
    });
    const panel = renderPanel();
    const runtimePanel = visitElements(
      panel,
      (element) =>
        (element.props as { readonly state?: { readonly status?: string } }).state?.status ===
          "ready" && typeof element.props.onSave === "function",
    );
    const draft = formFromMulticaRuntimeInstance(multicaId, multicaInstance);
    expect(runtimePanel).not.toBeNull();
    expect(draft).not.toBeNull();

    const attempt = await persistMulticaRuntimeDraft(
      draft!,
      String(multicaId),
      (request) =>
        (
          runtimePanel?.props.onSave as
            | ((input: Record<string, unknown>) => Promise<void>)
            | undefined
        )?.({
          ...request,
          expectedFingerprint: multicaRuntimeDraftFingerprint(draft!),
        }) ?? Promise.reject(new Error("missing Multica save callback")),
    );

    expect(attempt).toBe("conflict");
    expect(commands.updateSettings).toHaveBeenCalledTimes(1);
  });

  it("本地快照过期时在调用 settings RPC 前返回保存冲突", async () => {
    const multicaId = ProviderInstanceId.make("multica_local");
    const versionOne = {
      driver: ProviderDriverKind.make("multica"),
      enabled: true,
      settingsRevision: "revision-v1",
      environment: [{ name: "MULTICA_TOKEN", value: "", sensitive: true, valueRedacted: true }],
      config: {
        runtimeId: "multica:daemon-1:runtime-1",
        daemonId: "daemon-1",
        daemonRuntimeId: "runtime-1",
        baseUrl: "http://127.0.0.1:9000",
        headers: [{ headerName: "Private-Token", environmentVariable: "MULTICA_TOKEN" }],
        assigneeRoutes: [],
      },
    };
    const versionTwo = {
      ...versionOne,
      settingsRevision: "revision-v2",
      config: { ...versionOne.config, baseUrl: "http://127.0.0.1:9100" },
    };
    const staleDraft = formFromMulticaRuntimeInstance(multicaId, versionOne);
    const staleFingerprint = multicaRuntimeDraftFingerprint(staleDraft!);
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: { [multicaId]: versionTwo },
    };
    const panel = renderPanel();
    const runtimePanel = visitElements(
      panel,
      (element) =>
        (element.props as { readonly state?: { readonly status?: string } }).state?.status ===
          "ready" && typeof element.props.onSave === "function",
    );
    expect(runtimePanel).not.toBeNull();

    const attempt = await persistMulticaRuntimeDraft(
      staleDraft!,
      String(multicaId),
      (request) =>
        (
          runtimePanel?.props.onSave as
            | ((input: Record<string, unknown>) => Promise<void>)
            | undefined
        )?.({ ...request, expectedFingerprint: staleFingerprint }) ??
        Promise.reject(new Error("missing Multica save callback")),
    );

    expect(attempt).toBe("conflict");
    expect(commands.updateSettings).not.toHaveBeenCalled();
  });

  it("deletes and resets provider configuration without erasing shared preferences", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
        },
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
      providerModelPreferences: {
        [customId]: { hiddenModels: ["hidden"], modelOrder: ["model"] },
      },
      favorites: [{ provider: customId, model: "favorite" }],
    };
    let panel = renderPanel();
    const customRow = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "list",
    );
    (customRow?.props.onSelect as (() => void) | undefined)?.();
    panel = renderPanel();
    const customCard = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "editor",
    );
    expect(customCard).not.toBeNull();
    (customCard?.props.onDelete as (() => void) | undefined)?.();

    expect(settingsState.updateSettings).toHaveBeenLastCalledWith({
      providerInstances: {
        [codexId]: settingsState.value.providerInstances?.[codexId],
      },
    });

    settingsState.updateSettings.mockClear();
    const defaultRow = visitElements(
      panel,
      (element) => element.props.instanceId === codexId && element.props.mode === "list",
    );
    (defaultRow?.props.onSelect as (() => void) | undefined)?.();
    panel = renderPanel();
    const defaultCard = visitElements(
      panel,
      (element) => element.props.instanceId === codexId && element.props.mode === "editor",
    );
    const resetAction = defaultCard?.props.headerAction;
    const resetButton = visitElements(
      resetAction,
      (element) => typeof element.props.onClick === "function",
    );
    expect(resetButton).not.toBeNull();
    (resetButton?.props.onClick as (() => void) | undefined)?.();

    const resetPatch = settingsState.updateSettings.mock.lastCall?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(Object.keys(resetPatch ?? {}).sort()).toEqual(["providerInstances", "providers"]);
    expect(resetPatch).not.toHaveProperty("favorites");
    expect(resetPatch).not.toHaveProperty("providerModelPreferences");
  });
});
