import {
  ProviderDriverKind,
  ProviderInstanceId,
  type CompositionMulticaRuntimeConfig,
  type UnifiedSettings,
} from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTeamRuntimeSettingsPatch,
  teamRuntimeInstancesFromSettings,
} from "./TeamRuntimeSettingsPanel.logic";

const teamConfig: CompositionMulticaRuntimeConfig = {
  schemaVersion: 1,
  enabled: true,
  runtimeId: "runtime-a",
  daemonId: "daemon-a",
  daemonRuntimeId: "daemon-runtime-a",
  baseUrl: "http://127.0.0.1:9000",
  headers: [],
  assigneeRoutes: [],
  capabilities: ["squad"],
  supportsResume: true,
  supportsMcp: false,
  supportsSquad: true,
  supportsLeader: true,
  supportsTaskGraph: false,
};

const baseSettings = {
  providerInstances: {
    [ProviderInstanceId.make("codex")]: {
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex",
      config: { keep: true },
    },
    [ProviderInstanceId.make("team-b")]: {
      driver: ProviderDriverKind.make("multica"),
      displayName: "Team B",
      accentColor: "green",
      enabled: false,
      config: teamConfig,
      environment: [{ name: "TEAM_TOKEN", value: "", sensitive: true, valueRedacted: true }],
    },
    [ProviderInstanceId.make("fork_driver")]: {
      driver: ProviderDriverKind.make("fork_driver"),
      config: { keep: "unknown" },
    },
  },
} as unknown as UnifiedSettings;

describe("team runtime settings projection", () => {
  it("only lists team runtime instances in stable id order", () => {
    expect(teamRuntimeInstancesFromSettings(baseSettings).map((entry) => entry.instanceId)).toEqual(
      ["team-b"],
    );
  });

  it("renames and saves one team runtime without touching other instances or redacted secrets", () => {
    const nextId = ProviderInstanceId.make("team-renamed");
    const patch = buildTeamRuntimeSettingsPatch(baseSettings, "team-b", {
      instanceId: nextId,
      config: { ...teamConfig, runtimeId: "runtime-renamed", enabled: true },
      environment: [{ name: "TEAM_TOKEN", value: "", sensitive: true, valueRedacted: true }],
    });

    expect(patch.providerInstances).not.toHaveProperty("team-b");
    expect(patch.providerInstances?.[nextId]).toEqual({
      driver: ProviderDriverKind.make("multica"),
      displayName: "Team B",
      accentColor: "green",
      enabled: true,
      config: { ...teamConfig, runtimeId: "runtime-renamed", enabled: true },
      environment: [{ name: "TEAM_TOKEN", value: "", sensitive: true, valueRedacted: true }],
    });
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex")]).toBe(
      baseSettings.providerInstances?.[ProviderInstanceId.make("codex")],
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("fork_driver")]).toBe(
      baseSettings.providerInstances?.[ProviderInstanceId.make("fork_driver")],
    );
  });
});
