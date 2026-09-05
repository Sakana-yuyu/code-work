import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@codework/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@codework/contracts/settings";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  mergeEnvironmentSettings,
  resolveEnvironmentIdentificationMode,
  persistClientSettings,
  getClientSettings,
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  splitPatch,
} from "./useSettings";

const persistenceMocks = vi.hoisted(() => ({
  write: vi.fn(),
  addToast: vi.fn((_options: unknown) => "save-failure"),
  closeToast: vi.fn(),
}));
vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence: { setClientSettings: persistenceMocks.write } }),
}));
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: persistenceMocks.addToast, close: persistenceMocks.closeToast },
}));
afterEach(() => {
  __resetClientSettingsPersistenceForTests();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("服务端修改前置条件随配置提交，不写入客户端设置", () => {
  const preconditions = [
    { instanceId: ProviderInstanceId.make("multica_local"), expectedRevision: null },
  ];
  const { serverPatch, clientPatch } = splitPatch({
    providerInstances: {},
    multicaProviderInstancePreconditions: preconditions,
    glassOpacity: 70,
  });
  expect(serverPatch).toEqual({
    providerInstances: {},
    multicaProviderInstancePreconditions: preconditions,
  });
  expect(clientPatch).toEqual({ glassOpacity: 70 });
});

describe("客户端设置持久化", () => {
  it("写入失败保留已应用设置，重试写入最新快照", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    persistenceMocks.write
      .mockRejectedValueOnce(new Error("storage full"))
      .mockResolvedValue(undefined);
    const settings = { ...DEFAULT_CLIENT_SETTINGS, glassOpacity: 70 };
    expect(await persistClientSettings(settings)).toBe(false);
    expect(getClientSettings()).toBe(settings);
    const toast = persistenceMocks.addToast.mock.calls[0]![0] as unknown as {
      actionProps: { onClick: () => Promise<boolean> };
    };
    const latest = { ...settings, glassOpacity: 90 };
    __setClientSettingsForTests(latest);
    expect(await toast.actionProps.onClick()).toBe(true);
    expect(persistenceMocks.write).toHaveBeenLastCalledWith(latest);
    expect(persistenceMocks.closeToast).toHaveBeenCalledWith("save-failure");
  });

  it("连续保存按顺序落盘，慢旧请求不会覆盖新设置", async () => {
    let finishFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    persistenceMocks.write.mockReturnValueOnce(first).mockResolvedValue(undefined);
    const older = persistClientSettings({ ...DEFAULT_CLIENT_SETTINGS, glassOpacity: 60 });
    const newer = persistClientSettings({ ...DEFAULT_CLIENT_SETTINGS, glassOpacity: 80 });
    await Promise.resolve();
    expect(persistenceMocks.write).toHaveBeenCalledTimes(1);
    finishFirst();
    await Promise.all([older, newer]);
    expect(persistenceMocks.write).toHaveBeenLastCalledWith(
      expect.objectContaining({ glassOpacity: 80 }),
    );
  });
});

describe("resolveEnvironmentIdentificationMode", () => {
  it("keeps identification hidden until client settings hydrate", () => {
    expect(resolveEnvironmentIdentificationMode({ mode: "artwork", settingsHydrated: false })).toBe(
      "none",
    );
    expect(resolveEnvironmentIdentificationMode({ mode: "pill", settingsHydrated: true })).toBe(
      "pill",
    );
  });

  it("uses a pill instead of artwork with a palette theme", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "artwork",
        settingsHydrated: true,
        paletteThemeActive: true,
      }),
    ).toBe("pill");
  });

  it("respects none with a palette theme", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "none",
        settingsHydrated: true,
        paletteThemeActive: true,
      }),
    ).toBe("none");
  });

  it("keeps artwork when the palette theme opts into it", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "artwork",
        settingsHydrated: true,
        paletteThemeActive: true,
        paletteThemeAllowsArtwork: true,
      }),
    ).toBe("artwork");
  });
});

describe("mergeEnvironmentSettings", () => {
  it("combines the selected environment's server settings with client preferences", () => {
    const serverSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("codex_remote")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
    };
    const clientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      favorites: [
        {
          provider: ProviderInstanceId.make("codex_remote"),
          model: "gpt-5.4",
        },
      ],
    };

    const settings = mergeEnvironmentSettings(serverSettings, clientSettings);

    expect(settings.providerInstances).toBe(serverSettings.providerInstances);
    expect(settings.favorites).toBe(clientSettings.favorites);
  });
});
