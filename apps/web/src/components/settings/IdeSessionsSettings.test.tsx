import {
  ProviderDriverKind,
  type CompositionIdeResolveResult,
  type ProviderInstanceConfig,
} from "@codework/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  environment: null as { readonly environmentId: string } | null,
  settings: {
    providerInstances: {} as Record<string, ProviderInstanceConfig>,
  },
  updateSettings: vi.fn(),
  query: {
    data: null as ReadonlyArray<CompositionIdeResolveResult> | null,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
  ideSessionsAtom: Symbol("ide-sessions"),
}));

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironment: () => mocks.environment,
}));

vi.mock("~/hooks/useSettings", () => ({
  usePrimarySettings: () => mocks.settings,
  useUpdatePrimarySettings: () => mocks.updateSettings,
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) =>
    atom === mocks.ideSessionsAtom
      ? mocks.query
      : { data: null, error: null, isPending: false, refresh: vi.fn() },
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: {
    compositionIdeSessions: () => mocks.ideSessionsAtom,
  },
}));

import { IdeSessionsSettings } from "./IdeSessionsSettings";

describe("IdeSessionsSettings", () => {
  beforeEach(() => {
    mocks.environment = null;
    mocks.settings.providerInstances = {};
    mocks.updateSettings.mockReset();
    mocks.query.data = null;
    mocks.query.error = null;
    mocks.query.isPending = false;
    mocks.query.refresh.mockReset();
  });

  it("即使没有连接环境也显示 IDE session 配置入口", () => {
    const html = renderToStaticMarkup(<IdeSessionsSettings />);

    expect(html).toContain("IDE 会话");
    expect(html).toContain("添加 IDE 会话");
  });

  it("显示服务端注册状态但不回显已保存敏感值", () => {
    mocks.environment = { environmentId: "env-test" };
    mocks.settings.providerInstances = {
      ide_local: {
        driver: ProviderDriverKind.make("ide"),
        enabled: true,
        environment: [{ name: "IDE_TOKEN", value: "", sensitive: true, valueRedacted: true }],
        config: {
          schemaVersion: 1,
          enabled: true,
          sessionId: "vscode-session-1",
          profile: "vscode_ide",
          url: "ws://127.0.0.1:4111/t3/ide",
          headers: [{ headerName: "Authorization", environmentVariable: "IDE_TOKEN" }],
        },
      },
    };
    mocks.query.data = [
      {
        sessionId: "vscode-session-1",
        profile: "vscode_ide",
        verifiedOperations: ["editor.read"],
        status: "ready",
      },
    ];

    const html = renderToStaticMarkup(<IdeSessionsSettings />);

    expect(html).toContain("vscode-session-1");
    expect(html).toContain("已就绪");
    expect(html).toContain("已配置敏感值");
    expect(html).not.toContain("fixture-token");
  });
});
