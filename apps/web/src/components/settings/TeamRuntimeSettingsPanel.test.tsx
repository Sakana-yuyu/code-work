import { ProviderDriverKind, ProviderInstanceId } from "@codework/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  environment: null as { readonly environmentId: string } | null,
  settings: { providerInstances: {} } as never,
  updateSettings: vi.fn(),
}));

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironment: () => mocks.environment,
}));

vi.mock("~/hooks/useSettings", () => ({
  usePrimarySettings: () => mocks.settings,
  useUpdatePrimarySettings: () => mocks.updateSettings,
}));

import { TeamRuntimeSettingsPanel } from "./TeamRuntimeSettingsPanel";
import { t } from "~/i18n";

describe("TeamRuntimeSettingsPanel", () => {
  it("无连接环境时只显示不可用状态，不渲染可写实例网格", () => {
    mocks.environment = null;
    mocks.settings = { providerInstances: {} } as never;

    const html = renderToStaticMarkup(<TeamRuntimeSettingsPanel />);

    expect(html).toContain(t("teamRuntime.title"));
    expect(html).toContain(t("teamRuntime.noEnvironment"));
    expect(html).not.toContain("<aside");
  });

  it("没有团队运行时实例时显示空状态并保留新增入口", () => {
    mocks.environment = { environmentId: "environment-1" };
    mocks.settings = { providerInstances: {} } as never;

    const html = renderToStaticMarkup(<TeamRuntimeSettingsPanel />);

    expect(html).toContain(t("teamRuntime.empty"));
    expect(html).toContain(t("teamRuntime.new"));
    expect(html).toContain(t("teamRuntime.instances"));
  });

  it("有团队运行时实例时渲染实例列表、启用状态与配置占位", () => {
    mocks.environment = { environmentId: "environment-1" };
    mocks.settings = {
      providerInstances: {
        [ProviderInstanceId.make("team_reviewer")]: {
          driver: ProviderDriverKind.make("multica"),
          displayName: "运维小队",
          enabled: false,
          environment: [
            { name: "MULTICA_TOKEN", value: "", sensitive: true, valueRedacted: true },
          ],
          config: {
            runtimeId: "multica:daemon-1:runtime-1",
            daemonId: "daemon-1",
            daemonRuntimeId: "runtime-1",
            baseUrl: "http://127.0.0.1:9000",
            headers: [{ headerName: "Authorization", environmentVariable: "MULTICA_TOKEN" }],
            assigneeRoutes: [],
          },
        },
      },
    } as never;

    const html = renderToStaticMarkup(<TeamRuntimeSettingsPanel />);

    expect(html).toContain("运维小队");
    expect(html).toContain(t("disabled"));
    expect(html).toContain(t("teamRuntime.selectOrCreate"));
  });
});
