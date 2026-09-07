import type { MergedAccountQuotaProvider } from "@codework/shared/accountQuotaMerge";
import type { EnvironmentId } from "@codework/contracts";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useAccountQuota: vi.fn(),
}));

vi.mock("../../i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../i18n")>()),
  t: (key: string, params?: Record<string, unknown>) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    render,
    children,
  }: {
    readonly render: ReactElement;
    readonly children?: ReactNode;
  }) => cloneElement(render, {}, children),
  TooltipPopup: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));
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
vi.mock("../../state/accountQuota", () => ({ useAccountQuota: testState.useAccountQuota }));

import { UsageSubscriptionPanel } from "./UsageSubscriptionPanel";

function provider(overrides: Partial<MergedAccountQuotaProvider> = {}): MergedAccountQuotaProvider {
  return {
    environmentId: "env-1" as EnvironmentId,
    environmentLabel: "Local",
    provider: "codex",
    windows: [
      { id: "primary", label: "5 hours", usedFraction: 0.42, status: "ok" },
      {
        id: "secondary",
        label: "7 days",
        usedFraction: 0.9,
        status: "warning",
        resetsAt: "2026-09-08T00:00:00.000Z",
      },
    ],
    updatedAtUnixMs: 1_767_225_600_000,
    ...overrides,
  };
}

describe("UsageSubscriptionPanel", () => {
  it("renders nothing while pending or when no provider reported windows", () => {
    testState.useAccountQuota.mockReturnValue({
      providers: [],
      hasData: false,
      isPending: true,
      environmentsCount: 1,
      refresh: () => {},
    });
    expect(renderToStaticMarkup(<UsageSubscriptionPanel />)).toBe("");

    testState.useAccountQuota.mockReturnValue({
      providers: [],
      hasData: false,
      isPending: false,
      environmentsCount: 1,
      refresh: () => {},
    });
    expect(renderToStaticMarkup(<UsageSubscriptionPanel />)).toBe("");
  });

  it("renders one card per provider with window bars and reset times", () => {
    testState.useAccountQuota.mockReturnValue({
      providers: [
        provider(),
        provider({ provider: "claudeAgent", planName: "max", updatedAtUnixMs: 1 }),
      ],
      hasData: true,
      isPending: false,
      environmentsCount: 1,
      refresh: () => {},
    });

    const markup = renderToStaticMarkup(<UsageSubscriptionPanel />);
    expect(markup).toContain("usageAccountQuota.title");
    expect(markup).toContain("Codex");
    expect(markup).toContain("Claude Code");
    expect(markup).toContain("usageAccountQuota.window.fiveHours");
    expect(markup).toContain("usageAccountQuota.window.sevenDays");
    expect(markup).toContain("42%");
    expect(markup).toContain("90%");
    expect(markup).toContain("bg-amber-500");
    expect(markup).toContain("text-amber-500");
    expect(markup).toContain("usageAccountQuota.resetsAt");
    expect(markup).toContain("usageAccountQuota.updatedAt");
    expect(markup).toContain("Max");
  });
});
