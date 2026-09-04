import { ProviderDriverKind, type ServerProvider } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderSummary } from "./providerStatus";
import { t } from "~/i18n";

function makeProvider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: "cursor" as ServerProvider["instanceId"],
    driver: ProviderDriverKind.make("cursor"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", type: "team" },
    checkedAt: "2026-09-03T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("getProviderSummary", () => {
  it("健康检查告警时不会把已认证服务误报为就绪", () => {
    const summary = getProviderSummary(
      makeProvider({
        status: "warning",
        message: "Model discovery timed out.",
      }),
    );

    expect(summary.headline).toBe(t("providerStatusNeedsAttention"));
    expect(summary.detail).toBe("Model discovery timed out.");
  });

  it("启动失败时不会把已认证服务误报为可用", () => {
    const summary = getProviderSummary(
      makeProvider({
        status: "error",
        message: "Provider startup failed.",
      }),
    );

    expect(summary.headline).toBe(t("providerStatusUnavailable"));
    expect(summary.detail).toBe("Provider startup failed.");
  });

  it("未认证且服务没有附带说明时会给出下一步", () => {
    const summary = getProviderSummary(
      makeProvider({
        status: "ready",
        auth: { status: "unauthenticated" },
      }),
    );

    expect(summary.headline).toBe(t("providerStatusNotAuthenticated"));
    expect(summary.detail).toBe(t("providerStatusNotAuthenticatedDetail"));
  });

  it("保留登录命令，同时把固定格式的英文诊断翻译成下一步", () => {
    const summary = getProviderSummary(
      makeProvider({
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Codex CLI is not authenticated. Run `codex login` and try again.",
      }),
    );

    expect(summary.detail).toBe(t("providerStatusLoginCommand", { command: "codex login" }));
  });

  it("把尚未配置模型通道的服务端说明翻译成新人可执行的提示", () => {
    const summary = getProviderSummary(
      makeProvider({
        status: "warning",
        auth: { status: "unknown" },
        message: "No model adapters are configured yet. Add one in Settings.",
      }),
    );

    expect(summary.detail).toBe(t("providerStatusNoAdapters"));
  });

  it("把 BYOK 通道数量的英文说明翻译成本地化文案", () => {
    const summary = getProviderSummary(
      makeProvider({
        status: "ready",
        message: "6 model adapters configured.",
      }),
    );

    expect(summary.detail).toBe(t("providerAdaptersConfigured", { count: 6 }));
  });

  it("把 BYOK 密钥检查失败的组合消息本地化并保留各模型错误明细", () => {
    const failures = "kimi-k3: Error: Model catalog response contains no usable models";
    const summary = getProviderSummary(
      makeProvider({
        status: "warning",
        auth: { status: "unknown" },
        message: `6 model adapters configured. Key check failed for: ${failures}`,
      }),
    );

    expect(summary.detail).toBe(t("providerAdaptersKeyCheckFailed", { count: 6, failures }));
  });
});
