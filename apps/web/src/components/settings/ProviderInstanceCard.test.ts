import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";
import type { ServerProvider, ServerProviderModel } from "@codework/contracts";

import {
  deriveProviderModelsForDisplay,
  isProviderSettingsUpdateSuccessful,
  normalizeProviderEnvironmentDraftRows,
  resolveProviderInstallAffordance,
} from "./ProviderInstanceCard";

describe("provider settings save result", () => {
  it("只有完成的 RPC 才算保存成功", () => {
    expect(isProviderSettingsUpdateSuccessful(null)).toBe(true);
    expect(isProviderSettingsUpdateSuccessful(AsyncResult.success(undefined))).toBe(true);
    expect(
      isProviderSettingsUpdateSuccessful(AsyncResult.failure(Cause.fail("device is offline"))),
    ).toBe(false);
  });
});

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });
});

describe("normalizeProviderEnvironmentDraftRows", () => {
  it("保存已填写的变量时忽略新增的空白行", () => {
    expect(
      normalizeProviderEnvironmentDraftRows([
        {
          name: " API_BASE_URL ",
          value: "https://api.example.test/v1",
          sensitive: false,
        },
        {
          name: "",
          value: "",
          sensitive: true,
        },
      ]),
    ).toEqual([
      {
        name: "API_BASE_URL",
        value: "https://api.example.test/v1",
        sensitive: false,
      },
    ]);
  });

  it("拒绝保存名称不合法的已填写行", () => {
    expect(
      normalizeProviderEnvironmentDraftRows([
        {
          name: "api-key",
          value: "placeholder",
          sensitive: true,
        },
      ]),
    ).toBeNull();
  });
});

describe("resolveProviderInstallAffordance", () => {
  const notInstalledProvider: ServerProvider = {
    instanceId: "codex" as ServerProvider["instanceId"],
    driver: "codex" as ServerProvider["driver"],
    enabled: true,
    installed: false,
    version: null,
    status: "error",
    auth: { status: "unknown" },
    checkedAt: "2026-09-02T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    canInstall: true,
  };

  it("shows the install button for a missing CLI on a package-managed provider", () => {
    const affordance = resolveProviderInstallAffordance({
      liveProvider: notInstalledProvider,
      readOnly: false,
      hasHandler: true,
    });
    expect(affordance.visible).toBe(true);
    expect(affordance.errorMessage).toBeNull();
  });

  it("hides the button when installed, when the server lacks the channel, in readOnly, or without a handler", () => {
    const readOnly = resolveProviderInstallAffordance({
      liveProvider: notInstalledProvider,
      readOnly: true,
      hasHandler: true,
    });
    expect(readOnly.visible).toBe(false);

    const noChannel = resolveProviderInstallAffordance({
      liveProvider: { ...notInstalledProvider, canInstall: false },
      readOnly: false,
      hasHandler: true,
    });
    expect(noChannel.visible).toBe(false);

    const installed = resolveProviderInstallAffordance({
      liveProvider: { ...notInstalledProvider, installed: true, canInstall: false },
      readOnly: false,
      hasHandler: true,
    });
    expect(installed.visible).toBe(false);

    const noHandler = resolveProviderInstallAffordance({
      liveProvider: notInstalledProvider,
      readOnly: false,
      hasHandler: false,
    });
    expect(noHandler.visible).toBe(false);

    const noSnapshot = resolveProviderInstallAffordance({
      liveProvider: undefined,
      readOnly: false,
      hasHandler: true,
    });
    expect(noSnapshot.visible).toBe(false);
  });

  it("surfaces the latest install failure message until the next attempt", () => {
    const failed = resolveProviderInstallAffordance({
      liveProvider: {
        ...notInstalledProvider,
        installState: {
          status: "failed",
          startedAt: "2026-09-02T00:00:00.000Z",
          finishedAt: "2026-09-02T00:01:00.000Z",
          message: "Install command exited with code 1.",
          output: null,
        },
      },
      readOnly: false,
      hasHandler: true,
    });
    expect(failed.visible).toBe(true);
    expect(failed.errorMessage).toBe("Install command exited with code 1.");

    const running = resolveProviderInstallAffordance({
      liveProvider: {
        ...notInstalledProvider,
        installState: {
          status: "running",
          startedAt: "2026-09-02T00:00:00.000Z",
          finishedAt: null,
          message: "Installing @openai/codex@latest.",
          output: null,
        },
      },
      readOnly: false,
      hasHandler: true,
    });
    expect(running.errorMessage).toBeNull();
  });
});
