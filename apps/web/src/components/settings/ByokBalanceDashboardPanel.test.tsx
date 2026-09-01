import type {
  ByokBalanceDashboardAdapter,
  ByokBalanceDashboardResult,
  ByokBalanceResult,
} from "@codework/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  environment: null as { readonly environmentId: string } | null,
  dashboardAtom: Symbol("dashboard"),
  dashboardQuery: {
    data: null as ByokBalanceDashboardResult | null,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
}));

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironment: () => mocks.environment,
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    if (atom === mocks.dashboardAtom) return mocks.dashboardQuery;
    return {
      data: null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    };
  },
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: {
    byokBalanceDashboard: () => mocks.dashboardAtom,
  },
}));

import { t } from "~/i18n";

import { ByokBalanceDashboardPanel, byokBalanceSummary } from "./ByokBalanceDashboardPanel";

const balanceBase: ByokBalanceResult = {
  instanceId: "byok-main",
  adapterId: "adapter-ok",
  supported: true,
  source: "newapi",
  currency: "USD",
  unlimited: false,
  windows: [],
  message: "查询成功",
  transient: false,
};

const okAdapter: ByokBalanceDashboardAdapter = {
  adapterId: "adapter-ok",
  displayName: "GPT 主力",
  health: "ok",
  balance: { ...balanceBase, remaining: 12.5, total: 100, used: 87.5, planName: "default" },
};

const emptyAdapter: ByokBalanceDashboardAdapter = {
  adapterId: "adapter-empty",
  health: "empty",
  balance: { ...balanceBase, adapterId: "adapter-empty", remaining: 0 },
};

const errorAdapter: ByokBalanceDashboardAdapter = {
  adapterId: "adapter-error",
  health: "error",
  balance: {
    ...balanceBase,
    adapterId: "adapter-error",
    supported: false,
    error: { code: "upstream_http", message: "上游返回 500" },
  },
};

const dashboard = (): ByokBalanceDashboardResult => ({
  generatedAtUnixMs: 1_000,
  totals: {
    instanceCount: 2,
    adapterCount: 3,
    okCount: 1,
    emptyCount: 1,
    unsupportedCount: 0,
    errorCount: 1,
  },
  instances: [
    {
      instanceId: "byok-main",
      displayName: "BYOK 主账号",
      enabled: true,
      health: "degraded",
      adapters: [okAdapter, emptyAdapter, errorAdapter],
    },
    {
      instanceId: "byok-idle",
      enabled: false,
      health: "empty",
      adapters: [],
    },
  ],
});

describe("ByokBalanceDashboardPanel", () => {
  beforeEach(() => {
    mocks.environment = { environmentId: "env-1" };
    mocks.dashboardQuery.data = null;
    mocks.dashboardQuery.error = null;
    mocks.dashboardQuery.isPending = false;
    mocks.dashboardQuery.refresh = vi.fn();
  });

  it("渲染实例卡片：名称/启用态/实例健康徽标/适配器行与总计", () => {
    mocks.dashboardQuery.data = dashboard();
    const html = renderToStaticMarkup(<ByokBalanceDashboardPanel />);
    expect(html).toContain('data-balance-instance-id="byok-main"');
    expect(html).toContain('data-balance-instance-id="byok-idle"');
    expect(html).toContain("BYOK 主账号");
    expect(html).toContain('data-testid="byok-balance-instance-health-byok-main"');
    expect(html).toContain('data-balance-adapter-id="adapter-ok"');
    expect(html).toContain("GPT 主力");
    expect(html).toContain('data-testid="byok-balance-totals"');
    expect(html).toContain(t("byokBalance.health.degraded"));
  });

  it("查询失败行显示结构化错误消息，余额为空行显示耗尽标签——两者不混淆", () => {
    mocks.dashboardQuery.data = dashboard();
    const html = renderToStaticMarkup(<ByokBalanceDashboardPanel />);
    const errorRow = html.split('data-balance-adapter-id="adapter-error"')[1] ?? "";
    expect(errorRow).toContain("上游返回 500");
    expect(errorRow).toContain(t("byokBalance.health.error"));
    const emptyRow =
      (html.split('data-balance-adapter-id="adapter-empty"')[1] ?? "").split(
        'data-balance-adapter-id="adapter-error"',
      )[0] ?? "";
    expect(emptyRow).toContain(t("byokBalance.health.empty"));
    expect(emptyRow).not.toContain("上游返回 500");
  });

  it("byokBalanceSummary：错误行透出上游消息，unsupported/unlimited/数值行各有摘要", () => {
    expect(byokBalanceSummary(errorAdapter)).toBe("上游返回 500");
    expect(
      byokBalanceSummary({
        adapterId: "a",
        health: "unsupported",
        balance: { ...balanceBase, supported: false },
      }),
    ).toBe(t("byokBalance.health.unsupported"));
    expect(
      byokBalanceSummary({
        adapterId: "a",
        health: "ok",
        balance: { ...balanceBase, unlimited: true },
      }),
    ).toBe(t("byokBalance.unlimited"));
    const summary = byokBalanceSummary(okAdapter);
    expect(summary).toContain("12.50 USD");
    expect(summary).toContain("100.00");
    expect(summary).toContain("default");
  });

  it("无环境/加载中/错误/空数据四种状态均正常渲染且不输出 undefined", () => {
    mocks.environment = null;
    const noEnv = renderToStaticMarkup(<ByokBalanceDashboardPanel />);
    expect(noEnv).not.toContain("data-balance-instance-id");
    expect(noEnv).not.toContain("undefined");

    mocks.environment = { environmentId: "env-1" };
    mocks.dashboardQuery.isPending = true;
    const pending = renderToStaticMarkup(<ByokBalanceDashboardPanel />);
    expect(pending).not.toContain("data-balance-instance-id");
    expect(pending).not.toContain("undefined");

    mocks.dashboardQuery.isPending = false;
    mocks.dashboardQuery.error = "boom";
    const errored = renderToStaticMarkup(<ByokBalanceDashboardPanel />);
    expect(errored).not.toContain("data-balance-instance-id");
    expect(errored).not.toContain("undefined");

    mocks.dashboardQuery.error = null;
    mocks.dashboardQuery.data = {
      generatedAtUnixMs: 1_000,
      totals: {
        instanceCount: 0,
        adapterCount: 0,
        okCount: 0,
        emptyCount: 0,
        unsupportedCount: 0,
        errorCount: 0,
      },
      instances: [],
    };
    const empty = renderToStaticMarkup(<ByokBalanceDashboardPanel />);
    expect(empty).not.toContain("data-balance-instance-id");
    expect(empty).not.toContain("undefined");
  });

  it("看板为 null 且非 pending 时按空数据处理", () => {
    mocks.dashboardQuery.data = null;
    const html = renderToStaticMarkup(<ByokBalanceDashboardPanel />);
    expect(html).not.toContain("data-balance-instance-id");
    expect(html).not.toContain("undefined");
  });
});
