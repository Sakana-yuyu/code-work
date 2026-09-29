import { describe, expect, it } from "vite-plus/test";

import type { PifamilyModelRoute } from "../pifamily/byokProviderConfig.ts";
import { zcodeModeFor, zcodeToolItemType } from "../Layers/ZCodeAdapter.ts";
import {
  buildZCodeProviderConfig,
  scrubZCodeEnvironment,
  zcodeByokSelection,
  zcodeProviderConfigPath,
  zcodeProviderIdForRoute,
} from "./zcodeByokConfig.ts";

const route = (
  overrides: Partial<PifamilyModelRoute> & { adapterId: string },
): PifamilyModelRoute => ({
  protocol: "openai",
  displayName: overrides.adapterId,
  modelId: overrides.adapterId,
  contextWindowTokens: 128_000,
  ...overrides,
});

const base = {
  openaiBaseUrl: "http://127.0.0.1:3773/byok-gw/openai/v1",
  anthropicBaseUrl: "http://127.0.0.1:3773/byok-gw/anthropic",
  gatewayToken: "gw-token",
};

describe("buildZCodeProviderConfig", () => {
  it("按协议与号池来源拆成三类 Provider，并只发布有模型的分组", () => {
    const routes = [
      route({ adapterId: "a-openai" }),
      route({ adapterId: "a-claude", protocol: "anthropic", contextWindowTokens: 200_000 }),
      route({ adapterId: "local:cpa:codex:gpt-5", localProvider: "codex" }),
    ];
    const config = buildZCodeProviderConfig({
      ...base,
      routes,
      defaultModelSelection: routes[0] === undefined ? undefined : zcodeByokSelection(routes[0]),
    });

    expect(config.schemaVersion).toBe(1);
    const rules = config.config.providerConfigRules.providerRules;
    expect(rules.map((rule) => [rule.providerId, rule.config.api.type])).toEqual([
      ["codework-anthropic", "anthropic-messages"],
      ["codework-openai", "openai-chat-completions"],
      ["codework-responses", "openai-responses"],
    ]);
    expect(rules.find((rule) => rule.providerId === "codework-responses")?.config).toMatchObject({
      group: "standard-personal",
      access: { type: "api-key", apiKey: "gw-token" },
      api: { baseUrl: base.openaiBaseUrl },
      personalModelIds: ["local:cpa:codex:gpt-5"],
    });
    expect(config.config.providerOrder).toEqual([
      "codework-anthropic",
      "codework-openai",
      "codework-responses",
    ]);
    expect(config.config.modelConfigRules.providerModelRules).toContainEqual({
      providerId: "codework-anthropic",
      modelId: "a-claude",
      config: { enabled: true, properties: { contextWindow: 200_000 } },
    });
    expect(config.config.defaultModelSelection).toEqual({
      providerId: "codework-openai",
      modelId: "a-openai",
      options: { reasoningLevel: "enabled" },
    });
  });

  it("没有路由时不写 Provider，也不写默认模型", () => {
    const config = buildZCodeProviderConfig({
      ...base,
      routes: [],
      defaultModelSelection: undefined,
    });
    expect(config.config.providerConfigRules.providerRules).toEqual([]);
    expect("defaultModelSelection" in config.config).toBe(false);
  });

  it("号池的 Codex 路由走 Responses，Claude/Grok 保持原协议", () => {
    expect(zcodeProviderIdForRoute(route({ adapterId: "x", localProvider: "codex" }))).toBe(
      "codework-responses",
    );
    expect(zcodeProviderIdForRoute(route({ adapterId: "x", localProvider: "xai" }))).toBe(
      "codework-openai",
    );
    expect(
      zcodeProviderIdForRoute(
        route({ adapterId: "x", protocol: "anthropic", localProvider: "claude" }),
      ),
    ).toBe("codework-anthropic");
  });
});

describe("zcode 受管环境", () => {
  it("剥掉第三方密钥与指回变量，保留其余环境", () => {
    expect(
      scrubZCodeEnvironment({
        PATH: "/bin",
        ANTHROPIC_API_KEY: "sk",
        ANTHROPIC_BASE_URL: "https://x",
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/elsewhere",
        KEEP: "1",
        MISSING: undefined,
      }),
    ).toEqual({ PATH: "/bin", KEEP: "1" });
  });

  it("个人 Provider 配置固定在数据根的 .zcode/v2 下", () => {
    expect(zcodeProviderConfigPath("/data").replace(/\\/g, "/")).toBe(
      "/data/.zcode/v2/provider_config.json",
    );
  });
});

describe("ZCode 适配器映射", () => {
  it("运行时模式映射到 --mode，计划模式优先", () => {
    expect(zcodeModeFor({ runtimeMode: "full-access" })).toBe("yolo");
    expect(zcodeModeFor({ runtimeMode: "auto-accept-edits" })).toBe("edit");
    expect(zcodeModeFor({ runtimeMode: "approval-required" })).toBe("build");
    expect(zcodeModeFor({ runtimeMode: "full-access", interactionMode: "plan" })).toBe("plan");
  });

  it("按工具名归类条目类型", () => {
    expect(zcodeToolItemType("Bash")).toBe("command_execution");
    expect(zcodeToolItemType("Edit")).toBe("file_change");
    expect(zcodeToolItemType("Write")).toBe("file_change");
    expect(zcodeToolItemType("Read")).toBe("dynamic_tool_call");
  });
});
