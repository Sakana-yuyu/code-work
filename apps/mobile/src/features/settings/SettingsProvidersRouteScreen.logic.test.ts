import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildMobileProviderRows,
  materializeProviderInstances,
  providerFields,
  updateProviderConfig,
} from "./SettingsProvidersRouteScreen.logic";

describe("移动端 Provider 设置逻辑", () => {
  it("把旧版 providers 配置 materialize 成实例且不把 enabled 塞进 opaque config", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          enabled: true,
          binaryPath: "codex-work",
        },
      },
      providerInstances: {},
    };

    const codex = buildMobileProviderRows(settings).find((row) => row.driver === "codex");

    expect(codex?.instance).toMatchObject({
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: { binaryPath: "codex-work" },
    });
    expect(codex?.instance.config).not.toHaveProperty("enabled");
  });

  it("materialize 时保留未编辑的旧版 Provider，避免一次保存误删其它驱动", () => {
    const settings = { ...DEFAULT_SERVER_SETTINGS, providerInstances: {} };
    const instances = materializeProviderInstances(settings);

    expect(instances[ProviderInstanceId.make("codex")]).toBeDefined();
    expect(instances[ProviderInstanceId.make("claudeAgent")]).toBeDefined();
    expect(Object.keys(instances)).toContain("opencode");
  });

  it("空文本会删除可选字段，开关只在启用时写入配置", () => {
    const [binaryPath] = providerFields("codex");
    const routeThroughByok = providerFields("grok").find(
      (field) => field.key === "routeThroughByok",
    );

    expect(binaryPath).toBeDefined();
    expect(updateProviderConfig({ binaryPath: "codex" }, binaryPath!, "  ")).toBeUndefined();
    expect(updateProviderConfig({}, routeThroughByok!, true)).toEqual({ routeThroughByok: true });
    expect(
      updateProviderConfig({ routeThroughByok: true }, routeThroughByok!, false),
    ).toBeUndefined();
  });
});
