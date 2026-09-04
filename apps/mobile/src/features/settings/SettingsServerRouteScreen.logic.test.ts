import { DEFAULT_SERVER_SETTINGS } from "@codework/contracts";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";

import {
  backgroundActivityBooleanPatch,
  backgroundActivityCustomPatch,
  backgroundActivityDurationPatch,
  backgroundActivityPresetPatch,
  normalizeMobileDirectory,
  secondsFromDuration,
} from "./SettingsServerRouteScreen.logic";
import { resolveServerBackgroundActivitySettings } from "@codework/shared/backgroundActivitySettings";

describe("移动端服务端设置逻辑", () => {
  it("把后台活动预设写成服务端可解码的标准结构", () => {
    expect(backgroundActivityPresetPatch("battery-saver")).toEqual({
      backgroundActivity: {
        schemaVersion: 1,
        profile: "battery-saver",
        overrides: {},
      },
    });
  });

  it("修改自定义后台间隔时保留既有覆盖项", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      backgroundActivity: {
        schemaVersion: 1 as const,
        profile: "custom" as const,
        baseProfile: "balanced" as const,
        overrides: { pauseWhenOnBattery: true },
      },
    };
    const resolved = resolveServerBackgroundActivitySettings(settings);
    const patch = backgroundActivityDurationPatch(
      settings,
      resolved,
      "providerHealthRefreshInterval",
      90,
    );

    expect(patch.backgroundActivity?.overrides).toMatchObject({
      pauseWhenOnBattery: true,
      providerHealthRefreshInterval: Duration.seconds(90),
    });
  });

  it("布尔覆盖和目录输入都经过最小边界处理", () => {
    const settings = DEFAULT_SERVER_SETTINGS;
    const resolved = resolveServerBackgroundActivitySettings(settings);
    expect(
      backgroundActivityBooleanPatch(settings, resolved, "pauseWhenHostLocked", false)
        .backgroundActivity?.overrides,
    ).toMatchObject({ pauseWhenHostLocked: false });
    expect(secondsFromDuration(Duration.seconds(-5))).toBe(0);
    expect(normalizeMobileDirectory("  D:/workspaces  ")).toBe("D:/workspaces");
  });

  it("选择自定义策略时保留当前解析后的全部运行参数", () => {
    const settings = DEFAULT_SERVER_SETTINGS;
    const resolved = resolveServerBackgroundActivitySettings(settings);
    expect(backgroundActivityCustomPatch(settings, resolved).backgroundActivity).toMatchObject({
      profile: "custom",
      baseProfile: "balanced",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(30),
        pauseWhenOnBattery: false,
      },
    });
  });
});
