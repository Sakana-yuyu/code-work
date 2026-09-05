import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ProviderInstanceConfig } from "@codework/contracts";
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
