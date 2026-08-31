import { ProviderDriverKind, type ProviderInstanceConfig } from "@codework/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: () => undefined,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

import {
  isMulticaRuntimeActionCurrent,
  useMulticaRuntimeSettingsController,
} from "./MulticaRuntimeSettings.controller";

const scopeKey = "environment-a";
const instanceId = "multica_local";

const savedInstance = (
  baseUrl: string,
  settingsRevision = "revision-v1",
): ProviderInstanceConfig => ({
  driver: ProviderDriverKind.make("multica"),
  enabled: true,
  settingsRevision,
  config: {
    runtimeId: "multica:daemon-1:runtime-1",
    daemonId: "daemon-1",
    daemonRuntimeId: "runtime-1",
    baseUrl,
    headers: [],
    assigneeRoutes: [],
  },
});

const onSave = vi.fn();
const onDelete = vi.fn();

const renderController = (instance: ProviderInstanceConfig) => {
  hooks.beginRender();
  return useMulticaRuntimeSettingsController({
    scopeKey,
    state: { status: "ready", instances: { [instanceId]: instance } },
    onSave,
    onDelete,
  });
};

describe("MulticaRuntimeSettings controller", () => {
  beforeEach(() => {
    hooks.reset();
    onSave.mockReset();
    onDelete.mockReset();
  });

  it("只让同一环境的当前删除请求更新界面", () => {
    const request = { requestId: 7, scopeKey: "environment-a" };

    expect(isMulticaRuntimeActionCurrent(request, 7, "environment-a")).toBe(true);
    expect(isMulticaRuntimeActionCurrent(request, 8, "environment-a")).toBe(false);
    expect(isMulticaRuntimeActionCurrent(request, 7, "environment-b")).toBe(false);
    expect(isMulticaRuntimeActionCurrent(request, null, "environment-a")).toBe(false);
  });

  it("在设置刷新后撤销过期的删除确认", () => {
    const versionOne = savedInstance("http://127.0.0.1:9000");
    let controller = renderController(versionOne);
    controller.requestDelete(instanceId, versionOne);

    controller = renderController(versionOne);
    expect(controller.pendingDeleteOpen).toBe(true);

    controller = renderController(savedInstance("http://127.0.0.1:9100"));
    expect(controller.pendingDeleteOpen).toBe(false);
    expect(controller.deleteInProgress).toBe(false);
  });

  it("在设置刷新后清除旧版本的删除冲突提示", async () => {
    const versionOne = savedInstance("http://127.0.0.1:9000");
    onDelete.mockRejectedValue({ _tag: "ServerSettingsConflictError" });
    let controller = renderController(versionOne);
    controller.requestDelete(instanceId, versionOne);

    controller = renderController(versionOne);
    await controller.confirmDelete();

    controller = renderController(versionOne);
    expect(controller.deleteFailedId).toBe(instanceId);
    expect(controller.deleteFailure).toBe("conflict");

    controller = renderController(savedInstance("http://127.0.0.1:9100"));
    expect(controller.deleteFailedId).toBeNull();
    expect(controller.deleteFailure).toBeNull();
  });

  it("编辑保存使用打开会话时捕获的 revision", async () => {
    const versionOne = savedInstance("http://127.0.0.1:9000", "revision-v1");
    onSave.mockResolvedValue(undefined);
    let controller = renderController(versionOne);
    controller.openEdit(instanceId, versionOne);

    controller = renderController(versionOne);
    await controller.saveEditor();

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: "revision-v1" }),
    );
  });

  it("删除确认使用打开确认时捕获的 revision", async () => {
    const versionOne = savedInstance("http://127.0.0.1:9000", "revision-v1");
    let controller = renderController(versionOne);
    controller.requestDelete(instanceId, versionOne);

    controller = renderController(versionOne);
    await controller.confirmDelete();

    expect(onDelete).toHaveBeenCalledWith({ instanceId, expectedRevision: "revision-v1" });
  });

  it("服务端 revision 更新但草稿指纹未变时，编辑会话进入冲突态", () => {
    const versionOne = savedInstance("http://127.0.0.1:9000", "revision-v1");
    let controller = renderController(versionOne);
    controller.openEdit(instanceId, versionOne);

    controller = renderController(versionOne);
    controller = renderController(savedInstance("http://127.0.0.1:9000", "revision-v2"));

    expect(controller.activeEditor).toMatchObject({ conflict: true, saveState: "conflict" });
  });
});
