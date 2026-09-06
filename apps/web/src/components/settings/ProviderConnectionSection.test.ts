import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@codework/contracts";
import { providerConnectionMode, withProviderConnection } from "./ProviderConnectionSection";

const instance: ProviderInstanceConfig = {
  driver: ProviderDriverKind.make("codex"),
  config: { customModels: ["my-model"], homePath: "custom-home" },
  environment: [
    { name: "CODEWORK_CODEX_API_KEY", value: "", sensitive: true, valueRedacted: true },
    { name: "MY_PROJECT_SETTING", value: "keep", sensitive: false },
  ],
};

describe("供应商连接设置", () => {
  it("限定共享线路且能清除选择恢复兼容行为，保留账号隔离目录", () => {
    const source = ProviderInstanceId.make("cpa-work");
    const routed = withProviderConnection(instance, "gateway", "", "", false, source);
    expect(routed.config).toMatchObject({
      routeThroughByok: true,
      byokSourceInstanceId: source,
      homePath: "custom-home",
    });
    const cleared = withProviderConnection(routed, "gateway", "", "");
    expect(cleared.config).not.toHaveProperty("byokSourceInstanceId");
    expect(cleared.config).toMatchObject({ routeThroughByok: true, homePath: "custom-home" });
    expect(withProviderConnection(routed, "native", "", "", false, source).config).toMatchObject({
      routeThroughByok: false,
      byokSourceInstanceId: source,
    });
  });
  it("旧网关开关映射为共享渠道，可从统一入口关闭且保留其他配置", () => {
    for (const driver of ["codex", "claudeAgent", "grok", "opencode"]) {
      const legacy = {
        driver: ProviderDriverKind.make(driver),
        config: { routeThroughByok: true, binaryPath: "custom-cli" },
      };
      expect(providerConnectionMode(legacy)).toBe("gateway");
      const native = withProviderConnection(legacy, "native", "", "");
      expect(providerConnectionMode(native)).toBe("native");
      expect(native.config).toEqual({ routeThroughByok: false, binaryPath: "custom-cli" });
    }
  });

  it("Kimi 可以识别 API 连接，但不会把 Kimi 或 Antigravity 误报为共享线路", () => {
    const kimi = {
      driver: ProviderDriverKind.make("kimi"),
      config: { routeThroughByok: true },
      environment: [{ name: "KIMI_API_KEY", value: "saved", sensitive: true }],
    } as ProviderInstanceConfig;
    expect(providerConnectionMode(kimi)).toBe("api");
    expect(withProviderConnection(kimi, "gateway", "", "").config).toMatchObject({
      routeThroughByok: false,
    });
    expect(withProviderConnection(kimi, "gateway", "", "").environment).toEqual([]);

    const antigravity = {
      driver: ProviderDriverKind.make("antigravity"),
      config: { routeThroughByok: true },
      environment: [{ name: "AGY_API_KEY", value: "saved", sensitive: true }],
    } as ProviderInstanceConfig;
    expect(providerConnectionMode(antigravity)).toBe("native");
    expect(withProviderConnection(antigravity, "gateway", "", "").config).toMatchObject({
      routeThroughByok: false,
    });
  });

  it("Kimi API 连接保留兼容的 URL 和密钥字段", () => {
    const kimi = {
      driver: ProviderDriverKind.make("kimi"),
      config: {},
      environment: [],
    } as ProviderInstanceConfig;
    expect(
      withProviderConnection(kimi, "api", "https://api.kimi.com/coding", "new-kimi-key")
        .environment,
    ).toEqual([
      { name: "KIMI_BASE_URL", value: "https://api.kimi.com/coding", sensitive: false },
      { name: "KIMI_API_KEY", value: "new-kimi-key", sensitive: true },
    ]);
  });

  it("官方登录模式会清除 Kimi API 覆盖，避免登录后仍走 API Key", () => {
    const kimi = {
      driver: ProviderDriverKind.make("kimi"),
      config: {},
      environment: [{ name: "KIMI_API_KEY", value: "saved", sensitive: true }],
    } as ProviderInstanceConfig;
    expect(withProviderConnection(kimi, "native", "", "").environment).toEqual([]);
  });

  it("Kimi 和 Antigravity 不显示共享线路状态", () => {
    for (const driver of ["kimi", "antigravity"]) {
      const instance = {
        driver: ProviderDriverKind.make(driver),
        config: { routeThroughByok: true },
        environment: [],
      } as ProviderInstanceConfig;
      expect(providerConnectionMode(instance)).toBe("native");
      expect(withProviderConnection(instance, "gateway", "", "").config).toMatchObject({
        routeThroughByok: false,
      });
    }
  });

  it("保留已脱敏密钥和其他设置，显式切换时移除冲突覆盖", () => {
    const saved = withProviderConnection(instance, "api", " https://example.test/v1/ ", "");
    expect(providerConnectionMode(saved)).toBe("api");
    expect(saved.config).toMatchObject({
      customModels: ["my-model"],
      homePath: "custom-home",
      routeThroughByok: false,
    });
    expect(saved.environment).toContainEqual(instance.environment![0]);
    expect(saved.environment).toContainEqual({
      name: "CODEWORK_CODEX_BASE_URL",
      value: "https://example.test/v1",
      sensitive: false,
    });
    const gateway = withProviderConnection(saved, "gateway", "", "");
    expect(providerConnectionMode(gateway)).toBe("gateway");
    expect(gateway.environment).toEqual([instance.environment![1]]);
    expect(providerConnectionMode(withProviderConnection(gateway, "native", "", ""))).toBe(
      "native",
    );
  });

  it("替换密钥时强制标记敏感，拒绝缺少密钥或不安全的 URL", () => {
    const next = withProviderConnection(
      instance,
      "api",
      "https://example.test/v1",
      " fixture-key ",
    );
    expect(next.environment).toContainEqual({
      name: "CODEWORK_CODEX_API_KEY",
      value: "fixture-key",
      sensitive: true,
    });
    for (const url of [
      "file:///tmp/key",
      "https://user:pass@example.test",
      "https://example.test?key=secret",
      "https://example.test/#secret",
      "not-url",
    ]) {
      expect(() => withProviderConnection(instance, "api", url, "fixture-key")).toThrow();
    }
    expect(() =>
      withProviderConnection({ ...instance, environment: [] }, "api", "https://example.test", ""),
    ).toThrow();
  });

  it("Claude 的 Key 连接移除旧 Bearer/OAuth 覆盖，其他 CLI 不动自定义变量", () => {
    const claude = withProviderConnection(
      {
        ...instance,
        driver: ProviderDriverKind.make("claudeAgent"),
        environment: [{ name: "ANTHROPIC_AUTH_TOKEN", value: "old", sensitive: true }],
      },
      "api",
      "https://example.test",
      "new",
    );
    expect(claude.environment).toContainEqual({
      name: "ANTHROPIC_AUTH_TOKEN",
      value: "",
      sensitive: true,
    });
    expect(claude.environment).toContainEqual({
      name: "ANTHROPIC_API_KEY",
      value: "new",
      sensitive: true,
    });
    const bearer = withProviderConnection(claude, "api", "https://example.test", "token", true);
    expect(bearer.environment).toContainEqual({
      name: "ANTHROPIC_AUTH_TOKEN",
      value: "token",
      sensitive: true,
    });
    expect(bearer.environment).toContainEqual({
      name: "ANTHROPIC_API_KEY",
      value: "",
      sensitive: true,
    });
    expect(providerConnectionMode(bearer)).toBe("api");
    const grok = { ...instance, driver: ProviderDriverKind.make("grok") };
    expect(withProviderConnection(grok, "gateway", "", "").environment).toEqual(grok.environment);
  });
});
