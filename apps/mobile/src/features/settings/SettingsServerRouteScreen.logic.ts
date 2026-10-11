import type {
  BackgroundActivityProfile,
  ResponseStreamingMode,
  ServerConfig,
  ServerSettings,
  ServerSettingsPatch,
} from "@codework/contracts";
import * as Duration from "effect/Duration";

import {
  getBackgroundActivityBaseProfile,
  type ResolvedBackgroundActivitySettings,
} from "@codework/shared/backgroundActivitySettings";

export type DurationSetting =
  | "automaticGitFetchInterval"
  | "providerHealthRefreshInterval"
  | "hostPowerMonitorActiveInterval"
  | "hostPowerMonitorIdleInterval"
  | "idleClientTtl";

export type BackgroundActivityBooleanSetting =
  | "pauseWhenHostLocked"
  | "pauseWhenHostLowPower"
  | "pauseWhenClientLowPower"
  | "pauseWhenOnBattery";

export const BACKGROUND_ACTIVITY_PROFILES: ReadonlyArray<BackgroundActivityProfile> = [
  "balanced",
  "performance",
  "battery-saver",
];

/** 旧环境未声明能力时不发送新字段，避免客户端与服务端产生不同的设置状态。 */
export function responseStreamingModePatch(
  mode: ResponseStreamingMode,
  config: Pick<ServerConfig, "features"> | null,
): ServerSettingsPatch | undefined {
  return config?.features?.responseStreamingModes === true
    ? { responseStreamingMode: mode }
    : undefined;
}

export function secondsFromDuration(duration: Duration.Duration): number {
  return Math.max(0, Math.round(Duration.toMillis(duration) / 1_000));
}

export function backgroundActivityPresetPatch(
  profile: BackgroundActivityProfile,
): ServerSettingsPatch {
  return {
    backgroundActivity: {
      schemaVersion: 1,
      profile,
      overrides: {},
    },
  };
}

export function backgroundActivityCustomPatch(
  settings: ServerSettings,
  resolved: ResolvedBackgroundActivitySettings,
): ServerSettingsPatch {
  return {
    backgroundActivity: {
      schemaVersion: 1,
      profile: "custom",
      baseProfile: getBackgroundActivityBaseProfile(settings.backgroundActivity),
      overrides: {
        automaticGitFetchInterval: resolved.automaticGitFetchInterval,
        providerHealthRefreshInterval: resolved.providerHealthRefreshInterval,
        hostPowerMonitorActiveInterval: resolved.hostPowerMonitorActiveInterval,
        hostPowerMonitorIdleInterval: resolved.hostPowerMonitorIdleInterval,
        idleClientTtl: resolved.idleClientTtl,
        pauseWhenHostLocked: resolved.pauseWhenHostLocked,
        pauseWhenHostLowPower: resolved.pauseWhenHostLowPower,
        pauseWhenClientLowPower: resolved.pauseWhenClientLowPower,
        pauseWhenOnBattery: resolved.pauseWhenOnBattery,
      },
    },
  };
}

export function backgroundActivityDurationPatch(
  settings: ServerSettings,
  resolved: ResolvedBackgroundActivitySettings,
  field: DurationSetting,
  seconds: number,
): ServerSettingsPatch {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  const current = settings.backgroundActivity;
  const overrides = current.profile === "custom" ? current.overrides : {};
  return {
    backgroundActivity: {
      schemaVersion: 1,
      profile: "custom",
      baseProfile: getBackgroundActivityBaseProfile(current) ?? resolved.profile,
      overrides: {
        ...overrides,
        [field]: Duration.seconds(safeSeconds),
      },
    },
  };
}

export function backgroundActivityBooleanPatch(
  settings: ServerSettings,
  resolved: ResolvedBackgroundActivitySettings,
  field: BackgroundActivityBooleanSetting,
  value: boolean,
): ServerSettingsPatch {
  const current = settings.backgroundActivity;
  const overrides = current.profile === "custom" ? current.overrides : {};
  return {
    backgroundActivity: {
      schemaVersion: 1,
      profile: "custom",
      baseProfile: getBackgroundActivityBaseProfile(current) ?? resolved.profile,
      overrides: {
        ...overrides,
        [field]: value,
      },
    },
  };
}

export function normalizeMobileDirectory(value: string): string {
  return value.trim();
}
