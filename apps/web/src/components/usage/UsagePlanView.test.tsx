import type { UsageProviderKind } from "@codework/contracts";
import type { DailyTotals, ProviderTotals } from "@codework/shared/usageMerge";
import type { ByokBalanceQueryTarget } from "../../state/byokBalance";
import type { MergedByokPlans } from "@codework/shared/byokBalanceMerge";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

// Identity catalog so assertions are independent of the test machine's locale.
vi.mock("../../i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../i18n")>()),
  t: (key: string, params?: Record<string, unknown>) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
}));
vi.mock("../ui/badge", () => ({ Badge: "span" }));
vi.mock("./usageProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./usageProviders")>();
  return {
    ...actual,
    PROVIDER_PRESENTATION: {
      codex: { color: "white", label: "Codex", mark: "span" },
      claude: { color: "orange", label: "Claude Code", mark: "span" },
    },
  };
});

import { UsagePlanView } from "./UsagePlanView";

const providerTotals = (
  provider: UsageProviderKind,
  totalTokens: number,
  sessions: number,
): ProviderTotals => ({
  provider,
  costUsd: 0,
  totalTokens,
  records: 1,
  sessions,
  costShare: 0,
  tokenShare: 0,
});

function day(day: string, codex: number, claude: number): DailyTotals {
  return {
    day,
    costUsd: 0,
    totalTokens: codex + claude,
    byProvider: new Map([
      ["codex", { costUsd: 0, totalTokens: codex }],
      ["claude", { costUsd: 0, totalTokens: claude }],
    ]),
    byModel: new Map(),
  };
}

const DAYS = ["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"];

function byokPlans(adapters: MergedByokPlans["adapters"]): MergedByokPlans {
  return {
    adapters,
    okCount: adapters.filter((adapter) => adapter.health === "ok").length,
    emptyCount: 0,
    unsupportedCount: 0,
    errorCount: adapters.filter((adapter) => adapter.health === "error").length,
  };
}

function renderPlan(overrides: Partial<Parameters<typeof UsagePlanView>[0]> = {}) {
  return renderToStaticMarkup(
    <UsagePlanView
      providers={[providerTotals("codex", 900, 3), providerTotals("claude", 100, 1)]}
      daily={[
        day("2026-08-30", 100, 100),
        day("2026-08-31", 200, 0),
        day("2026-09-01", 300, 0),
        day("2026-09-02", 300, 0),
      ]}
      days={DAYS}
      untilDay="2026-09-02"
      byokEnvironments={[]}
      byok={byokPlans([])}
      byokPending={false}
      {...overrides}
    />,
  );
}

describe("UsagePlanView", () => {
  it("renders subscription cards with streaks computed per provider", () => {
    const markup = renderPlan();

    expect(markup).toContain("Codex");
    expect(markup).toContain("Claude Code");
    // Codex burned tokens on all four days: an unbroken streak of 4 over a
    // 900-token total. Claude's only active day is the first one, so with no
    // activity yesterday or today its current streak reads as 0.
    expect(markup).toContain(">900<");
    expect(markup).toContain("usage.dayCount {&quot;count&quot;:4}");
  });

  it("groups byok adapters under their instance with window progress", () => {
    const markup = renderPlan({
      byok: byokPlans([
        {
          instanceId: "glm-main",
          instanceLabel: "GLM Coding Plan",
          adapterId: "coding",
          adapterLabel: "glm-coding",
          environmentId: "env-test" as ByokBalanceQueryTarget["environmentId"],
          baseURL: "https://relay.test/v1",
          health: "ok",
          balance: {
            instanceId: "glm-main",
            adapterId: "coding",
            supported: true,
            source: "test",
            currency: "USD",
            unlimited: false,
            planName: "GLM Max",
            windows: [
              {
                id: "5h",
                label: "5 hour window",
                unit: "USD",
                used: 2,
                limit: 10,
                usedFraction: 0.2,
                status: "ok",
              },
            ],
            message: "",
            transient: false,
          },
        },
      ]),
    });

    expect(markup).toContain("GLM Coding Plan");
    expect(markup).toContain("glm-coding");
    expect(markup).toContain("GLM Max");
    expect(markup).toContain("2.00 / 10.00 USD");
    expect(markup).toContain("20%");
  });

  it("says so plainly when an environment cannot report balances", () => {
    const markup = renderPlan({
      byokEnvironments: [{ label: "Laptop", error: "boom" }],
    });

    expect(markup).toContain("Laptop usage.couldNotReportBalances");
  });

  it("collapses adapters sharing a relay endpoint into one queryable balance row", () => {
    const onQueryBalance = vi.fn(async () => undefined);
    const markup = renderPlan({
      byok: byokPlans([
        {
          instanceId: "byok-main",
          instanceLabel: "Cursor BYOK",
          adapterId: "flash",
          adapterLabel: "deepseek-v4-flash",
          environmentId: "env-test" as ByokBalanceQueryTarget["environmentId"],
          baseURL: "https://api.deepseek.test/v1",
          health: "ok",
          balance: {
            instanceId: "byok-main",
            adapterId: "flash",
            supported: true,
            source: "deepseek",
            currency: "CNY",
            unlimited: false,
            remaining: 18.25,
            windows: [],
            message: "",
            transient: false,
          },
        },
        {
          instanceId: "byok-main",
          instanceLabel: "Cursor BYOK",
          adapterId: "pro",
          adapterLabel: "deepseek-v4-pro",
          environmentId: "env-test" as ByokBalanceQueryTarget["environmentId"],
          baseURL: "https://api.deepseek.test/v1",
          health: "ok",
          balance: {
            instanceId: "byok-main",
            adapterId: "pro",
            supported: true,
            source: "deepseek",
            currency: "CNY",
            unlimited: false,
            remaining: 18.25,
            windows: [],
            message: "",
            transient: false,
          },
        },
      ]),
      onQueryBalance,
    });

    // One relay row (first adapter label + sibling count), one query button.
    expect(markup).toContain("deepseek-v4-flash");
    expect(markup).toContain("+1");
    expect(markup.match(/byokFeatures.balanceQuery/g)).toHaveLength(1);
  });

  it("将 OpenRouter 单 Key 限额与账户余额分开标注", () => {
    const entry = {
      instanceId: "openrouter-main",
      instanceLabel: "OpenRouter",
      adapterId: "key",
      adapterLabel: "OpenRouter Key",
      environmentId: "env-test" as ByokBalanceQueryTarget["environmentId"],
      baseURL: "https://openrouter.ai/api/v1",
      health: "ok" as const,
      balance: {
        instanceId: "openrouter-main",
        adapterId: "key",
        supported: true,
        source: "openrouter_key_limit",
        currency: "USD",
        unlimited: false,
        total: 100,
        remaining: 0,
        windows: [],
        message: "",
        transient: false,
      },
    };
    const markup = renderPlan({ byok: byokPlans([entry]) });
    expect(markup).toContain("byokBalance.keyLimitRemaining");
    expect(markup).toContain("0.00 USD");
    expect(markup).not.toContain("byokBalance.remaining");

    const noLimitMarkup = renderPlan({
      byok: byokPlans([
        { ...entry, balance: { ...entry.balance, total: undefined, remaining: undefined } },
      ]),
    });
    expect(noLimitMarkup).toContain("byokBalance.keyNoLimit");
  });

  it("零余额仍可重新查询，未接入接口只显示明确状态", () => {
    const entry = {
      instanceId: "moonshot-main",
      instanceLabel: "Moonshot",
      adapterId: "kimi",
      adapterLabel: "Kimi API",
      environmentId: "env-test" as ByokBalanceQueryTarget["environmentId"],
      baseURL: "https://api.moonshot.cn/v1",
      health: "empty" as const,
      balance: {
        instanceId: "moonshot-main",
        adapterId: "kimi",
        supported: true,
        source: "moonshot",
        currency: "CNY",
        unlimited: false,
        remaining: 0,
        windows: [],
        message: "查询成功",
        transient: false,
      },
    };
    const emptyMarkup = renderPlan({
      byok: byokPlans([entry]),
      onQueryBalance: vi.fn(async () => undefined),
    });
    expect(emptyMarkup).toContain("byokBalance.health.empty");
    expect(emptyMarkup).toContain("0.00 CNY");
    expect(emptyMarkup).toContain("data-plan-balance-query");

    const unsupportedMarkup = renderPlan({
      byok: byokPlans([
        {
          ...entry,
          health: "unsupported",
          balance: {
            ...entry.balance,
            supported: false,
            remaining: undefined,
            message: "This BYOK adapter does not support balance queries.",
          },
        },
      ]),
    });
    expect(unsupportedMarkup).toContain("byokBalance.health.unsupported");
    expect(unsupportedMarkup).not.toContain("This BYOK adapter does not support");

    const errorMarkup = renderPlan({
      byok: byokPlans([
        {
          ...entry,
          health: "error",
          balance: {
            ...entry.balance,
            supported: false,
            remaining: undefined,
            message: "The balance endpoint returned an HTTP error.",
            error: {
              code: "upstream_http",
              message: "The balance endpoint returned an HTTP error.",
            },
          },
        },
      ]),
    });
    expect(errorMarkup).toContain("byokBalance.health.error");
    expect(errorMarkup).toContain("The balance endpoint returned an HTTP error.");
    expect(errorMarkup).not.toContain("0.00 CNY");
  });
});
