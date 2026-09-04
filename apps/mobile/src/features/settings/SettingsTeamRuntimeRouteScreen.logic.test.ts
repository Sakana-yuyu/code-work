import { ProviderDriverKind, type ProviderInstanceConfig } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildMobileTeamRuntimeDeletePatch,
  buildMobileTeamRuntimeSavePatch,
} from "./SettingsTeamRuntimeRouteScreen.logic";
import {
  emptyMulticaRuntimeDraft,
  validateMulticaRuntimeDraft,
} from "@codework/shared/multicaRuntimeSettings";

const validSave = () => {
  const result = validateMulticaRuntimeDraft({
    ...emptyMulticaRuntimeDraft("team_main"),
    runtimeId: "runtime-main",
    daemonId: "daemon-main",
    daemonRuntimeId: "daemon-runtime-main",
    headers: [],
    environment: [],
  });
  if (!result.ok) throw new Error("fixture must be valid");
  return result.value;
};

const baseSettings = {
  providerInstances: {
    codex_main: {
      driver: ProviderDriverKind.make("codex"),
      config: { homePath: "C:/codex" },
    },
    team_old: {
      driver: ProviderDriverKind.make("multica"),
      settingsRevision: "revision-old",
      config: {
        runtimeId: "runtime-old",
        daemonId: "daemon-old",
        daemonRuntimeId: "daemon-runtime-old",
        baseUrl: "http://127.0.0.1:9000",
        headers: [],
        assigneeRoutes: [],
      },
    },
  } satisfies Record<string, ProviderInstanceConfig>,
};

describe("移动端团队运行时设置逻辑", () => {
  it("新建和改名只发送团队条目，并分别保护新旧实例", () => {
    const create = buildMobileTeamRuntimeSavePatch(baseSettings, null, null, validSave());
    expect(Object.keys(create.providerInstances ?? {})).toEqual(["team_main"]);
    expect(create.multicaProviderInstancePreconditions).toEqual([
      { instanceId: "team_main", expectedRevision: null },
    ]);

    const rename = buildMobileTeamRuntimeSavePatch(
      baseSettings,
      "team_old",
      "revision-old",
      validSave(),
    );
    expect(Object.keys(rename.providerInstances ?? {})).toEqual(["team_main"]);
    expect(rename.multicaProviderInstancePreconditions).toEqual([
      { instanceId: "team_old", expectedRevision: "revision-old" },
      { instanceId: "team_main", expectedRevision: null },
    ]);
  });

  it("删除只带目标的版本前置条件，不会覆盖其它实例", () => {
    const patch = buildMobileTeamRuntimeDeletePatch(
      "team_old",
      baseSettings.providerInstances.team_old!,
    );
    expect(patch.providerInstances).toEqual({});
    expect(patch.multicaProviderInstancePreconditions).toEqual([
      { instanceId: "team_old", expectedRevision: "revision-old" },
    ]);
  });
});
