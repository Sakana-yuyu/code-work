import type { CompositionAgentDriverProfile } from "@codework/contracts";
import { EnvironmentId } from "@codework/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  environment: null as { readonly environmentId: EnvironmentId } | null,
  driverAtom: Symbol("drivers"),
  query: {
    data: null as ReadonlyArray<CompositionAgentDriverProfile> | null,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { readonly children: ReactNode; readonly to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironment: () => mocks.environment,
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) =>
    atom === mocks.driverAtom
      ? mocks.query
      : { data: null, error: null, isPending: false, refresh: vi.fn() },
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: {
    compositionAgentDrivers: () => mocks.driverAtom,
  },
}));

import { t } from "~/i18n";

import { AgentDriversSettings, displayDriverName } from "./AgentDriversSettings";

const profile = (
  overrides: Partial<CompositionAgentDriverProfile> = {},
): CompositionAgentDriverProfile => ({
  schemaVersion: 1,
  agentId: "provider:byok",
  runtimeId: "provider:byok",
  driverKind: "provider",
  providerKind: "byok",
  displayName: "provider:byok",
  status: "available",
  capabilities: ["model", "byok.agent_loop"],
  supportsToolBroker: true,
  supportsCapabilityHandshake: false,
  supportsWorkspace: true,
  supportsTerminal: true,
  supportsGit: true,
  supportsMcp: false,
  supportsBrowser: false,
  supportsIde: true,
  supportsProviderApi: true,
  supportsResume: true,
  supportsSquad: false,
  supportsLeader: false,
  supportsTaskGraph: false,
  ...overrides,
});

const renderPanel = () => renderToStaticMarkup(<AgentDriversSettings />);

describe("AgentDriversSettings", () => {
  beforeEach(() => {
    mocks.environment = { environmentId: EnvironmentId.make("env-test") };
    mocks.query.data = null;
    mocks.query.error = null;
    mocks.query.isPending = false;
    mocks.query.refresh.mockReset();
  });

  it("为已就绪的 BYOK 展示下一步和可读名称", () => {
    mocks.query.data = [profile()];

    const html = renderPanel();

    expect(html).toContain(t("runtimeGuide.byokReadyTitle"));
    expect(html).toContain('href="/settings/delegation"');
    expect(html).toContain(t("runtimeGuide.driverByok"));
    expect(html).toContain(t("runtimeGuide.technicalDetails"));
    expect(html).toContain("<details");
  });

  it("没有可用驱动时引导用户前往 Provider", () => {
    mocks.query.data = [profile({ status: "unavailable" })];

    const html = renderPanel();

    expect(html).toContain(t("runtimeGuide.setupTitle"));
    expect(html).toContain('href="/settings/providers"');
    expect(html).toContain(t("runtimeGuide.statusUnavailableDescription"));
  });

  it("保留自定义驱动名称，不把用户名称替换成系统别名", () => {
    expect(displayDriverName(profile({ displayName: "Sakana 主力模型" }))).toBe("Sakana 主力模型");
  });
});
