import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@codework/contracts";

import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  readProviderConfigBoolean,
  readProviderConfigString,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("ACP 认证留空应显式保存，不回退到 login", () => {
    const definition = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("acpAgent")]!;
    const field = deriveProviderSettingsFields(definition).find(
      (entry) => entry.key === "authMethodId",
    )!;
    expect(readProviderConfigString({}, field.key, field.defaultStringValue)).toBe("login");
    expect(
      readProviderConfigString({ authMethodId: "" }, field.key, field.defaultStringValue),
    ).toBe("");
    expect(nextProviderConfigWithFieldValue({ authMethodId: "login" }, field, "")).toEqual({
      authMethodId: "",
    });
  });
  it("ACP MCP 从合同派生开启默认值，并保留明确关闭值", () => {
    const definition = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("acpAgent")]!;
    const field = deriveProviderSettingsFields(definition).find(
      (entry) => entry.key === "supportsMcpServers",
    )!;
    expect(field.defaultBooleanValue).toBe(true);
    expect(readProviderConfigBoolean({}, field.key, field.defaultBooleanValue)).toBe(true);
    const disabled = nextProviderConfigWithFieldValue({ command: "agent --acp" }, field, false);
    expect(disabled).toEqual({ command: "agent --acp", supportsMcpServers: false });
    expect(nextProviderConfigWithFieldValue(disabled, field, true)).toEqual({
      command: "agent --acp",
    });
  });
  it("连接区域接管网关开关时只隐藏重复字段，添加供应商表单仍可配置", () => {
    for (const driver of ["codex", "claudeAgent", "grok", "opencode"]) {
      const definition = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make(driver)]!;
      const fields = deriveProviderSettingsFields(definition);
      expect(fields.map((field) => field.key)).toContain("routeThroughByok");
      expect(deriveProviderSettingsFields(definition, ["routeThroughByok"])).toEqual(
        fields.filter((field) => field.key !== "routeThroughByok"),
      );
    }
  });

  it("derives visible provider config fields from the client definition schema", () => {
    const codex = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("codex")];

    expect(codex).toBeDefined();
    expect(deriveProviderSettingsFields(codex!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "shadowHomePath",
      "launchArgs",
      "routeThroughByok",
    ]);
  });

  it("sources labels and descriptions from schema annotations", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    const serverPassword = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverPassword",
    );

    expect(serverPassword).toMatchObject({
      label: "Server password",
      description: "Stored in plain text on disk.",
      control: "password",
    });
  });

  it("shows the auto-compaction threshold for Claude providers", () => {
    const claude = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("claudeAgent")];
    expect(claude).toBeDefined();

    expect(deriveProviderSettingsFields(claude!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "autoCompactWindow",
      "fallbackModel",
      "maxTurns",
      "launchArgs",
      "routeThroughByok",
    ]);
  });

  it("preserves unknown config keys while omitting empty configurable fields", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    const serverUrl = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverUrl",
    );
    expect(serverUrl).toBeDefined();

    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, serverUrl: "http://127.0.0.1:4096" },
      serverUrl!,
      "",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("reads non-string config values as blank strings", () => {
    expect(readProviderConfigString({ binaryPath: 123 }, "binaryPath")).toBe("");
  });

  it("omits false boolean fields when clearWhenEmpty is omit", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: true },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: false,
      },
      false,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("omits true boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: false },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      true,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("stores false boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("preserves false boolean fields when clearWhenEmpty is persist", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "persist",
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("reads non-boolean config values as false booleans", () => {
    expect(readProviderConfigBoolean({ experimental: "true" }, "experimental")).toBe(false);
  });

  it("reads missing boolean config values from the supplied default", () => {
    expect(readProviderConfigBoolean({}, "experimental", true)).toBe(true);
  });
});
