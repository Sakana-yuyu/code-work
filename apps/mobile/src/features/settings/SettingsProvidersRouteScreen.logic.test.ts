import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type AcpRegistryCatalogEntry,
} from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  MOBILE_ACP_QUICK_ENTRIES,
  buildMobileProviderRows,
  filterAcpCatalogEntries,
  makeMobileAcpCatalogInstance,
  suggestAcpCatalogInstanceId,
  materializeProviderInstances,
  providerFields,
  readProviderConfigBoolean,
  readProviderConfigString,
  providerSupportsSharedRoute,
  updateProviderConfig,
} from "./SettingsProvidersRouteScreen.logic";

const catalogEntry = (overrides: Partial<AcpRegistryCatalogEntry>): AcpRegistryCatalogEntry => ({
  id: "cline",
  name: "Cline",
  description: "Autonomous coding agent",
  version: "3.0.65",
  command: "npx -y cline@3.0.65 --acp",
  availability: "installable",
  ...overrides,
});

describe("移动端 ACP 目录", () => {
  it("按名称、说明和 ID 搜索，空查询返回全部", () => {
    const entries = [
      catalogEntry({}),
      catalogEntry({ id: "factory-droid", name: "Factory Droid", description: "Droid" }),
    ];
    expect(filterAcpCatalogEntries(entries, "  ")).toBe(entries);
    expect(filterAcpCatalogEntries(entries, "FACTORY").map((entry) => entry.id)).toEqual([
      "factory-droid",
    ]);
    expect(filterAcpCatalogEntries(entries, "autonomous").map((entry) => entry.id)).toEqual([
      "cline",
    ]);
  });

  it("目录条目保存为与网页一致的 acpAgent 实例", () => {
    expect(makeMobileAcpCatalogInstance(catalogEntry({ authMethodId: "" }), "")).toEqual({
      driver: "acpAgent",
      enabled: true,
      displayName: "Cline",
      config: { command: "npx -y cline@3.0.65 --acp", authMethodId: "" },
    });
    const environment = [{ name: "DROID_DISABLE_AUTO_UPDATE", value: "1", sensitive: false }];
    expect(
      makeMobileAcpCatalogInstance(
        catalogEntry({ id: "factory-droid", supportsMcpServers: false, environment }),
        " My Droid ",
      ),
    ).toEqual({
      driver: "acpAgent",
      enabled: true,
      displayName: "My Droid",
      config: {
        command: "npx -y cline@3.0.65 --acp",
        authMethodId: "login",
        supportsMcpServers: false,
      },
      environment,
    });
  });

  it("手工安装或平台不支持的条目没有可保存命令", () => {
    expect(
      makeMobileAcpCatalogInstance(
        catalogEntry({ command: null, availability: "unsupported-platform" }),
        "",
      ),
    ).toBeUndefined();
  });

  it("建议的实例 ID 合法且避开已有实例", () => {
    const pattern = /^[A-Za-z][A-Za-z0-9_-]*$/;
    expect(suggestAcpCatalogInstanceId("github-copilot-cli", new Set())).toBe(
      "acp-github-copilot-cli",
    );
    const taken = new Set(["acp-qwen-code", "acp-qwen-code-2"]);
    expect(suggestAcpCatalogInstanceId("qwen-code", taken)).toBe("acp-qwen-code-3");
    const odd = suggestAcpCatalogInstanceId("@scope/agent.v2", new Set());
    expect(odd).toBe("acp-scope-agent-v2");
    expect(pattern.test(odd)).toBe(true);
    expect(suggestAcpCatalogInstanceId("***", new Set())).toBe("acp-agent");
  });

  it("快捷入口与网页 Copilot/Gemini 按钮对齐", () => {
    expect(MOBILE_ACP_QUICK_ENTRIES.map((entry) => entry.id)).toEqual([
      "github-copilot-cli",
      "gemini",
    ]);
    expect(MOBILE_ACP_QUICK_ENTRIES[0]?.authMethodId).toBe("copilot-login");
    expect(MOBILE_ACP_QUICK_ENTRIES[1]?.authMethodId).toBe("oauth-personal");
  });
});

describe("移动端 Provider 设置逻辑", () => {
  it("ACP 空认证字段持久化，不恢复 login 默认值", () => {
    const field = providerFields("acpAgent").find((entry) => entry.key === "authMethodId")!;
    expect(readProviderConfigString({}, field.key, field.defaultStringValue)).toBe("login");
    expect(
      readProviderConfigString({ authMethodId: "" }, field.key, field.defaultStringValue),
    ).toBe("");
    expect(updateProviderConfig({ authMethodId: "login" }, field, "")).toEqual({
      authMethodId: "",
    });
  });
  it("ACP MCP 默认开启，明确关闭不会被当作空值删除", () => {
    const field = providerFields("acpAgent").find((entry) => entry.key === "supportsMcpServers")!;
    expect(field.defaultBooleanValue).toBe(true);
    expect(readProviderConfigBoolean({}, field.key, field.defaultBooleanValue)).toBe(true);
    const disabled = updateProviderConfig({ command: "agent --acp" }, field, false);
    expect(disabled).toEqual({ command: "agent --acp", supportsMcpServers: false });
    expect(readProviderConfigBoolean(disabled, field.key, field.defaultBooleanValue)).toBe(false);
    expect(updateProviderConfig(disabled, field, true)).toEqual({ command: "agent --acp" });
  });
  it("展示并保存 Claude 备用模型和执行轮次，清空可恢复默认", () => {
    for (const key of ["fallbackModel", "maxTurns"]) {
      const field = providerFields("claudeAgent").find((entry) => entry.key === key);
      expect(field).toBeDefined();
      const value = key === "fallbackModel" ? "sonnet" : "20";
      expect(updateProviderConfig({}, field!, value)).toEqual({ [key]: value });
      expect(updateProviderConfig({ [key]: value }, field!, "")).toBeUndefined();
    }
  });

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

  it("只为服务端已适配的 CLI 显示共享线路", () => {
    expect(providerSupportsSharedRoute("codex")).toBe(true);
    expect(providerSupportsSharedRoute("claudeAgent")).toBe(true);
    expect(providerSupportsSharedRoute("grok")).toBe(true);
    expect(providerSupportsSharedRoute("opencode")).toBe(true);
    expect(providerSupportsSharedRoute("kimi")).toBe(true);
    expect(providerSupportsSharedRoute("antigravity")).toBe(false);
  });
});
