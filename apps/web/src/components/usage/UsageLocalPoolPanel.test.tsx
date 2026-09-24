import type { EnvironmentId } from "@codework/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({ useLocalPoolUsage: vi.fn() }));

vi.mock("../../i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../i18n")>()),
  t: (key: string) => key,
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../../state/localPoolUsage", () => ({
  useLocalPoolUsage: testState.useLocalPoolUsage,
}));

import { UsageLocalPoolPanel } from "./UsageLocalPoolPanel";

function setUsage(canceled: number) {
  testState.useLocalPoolUsage.mockReturnValue({
    environments: [
      {
        environmentId: "env-1" as EnvironmentId,
        label: "Local",
        isPending: false,
        error: null,
        usage: [
          {
            id: "account-1",
            provider: "codex",
            requests: 2,
            failed: 0,
            canceled,
            inputTokens: 0,
            outputTokens: 0,
            lastUsedAt: null,
          },
        ],
      },
    ],
    refresh: vi.fn(),
  });
}

describe("UsageLocalPoolPanel", () => {
  it("shows canceled requests separately from provider failures", () => {
    setUsage(1);
    const markup = renderToStaticMarkup(<UsageLocalPoolPanel />);
    expect(markup).toContain("usage.poolUsage.canceled");
    expect(markup).not.toContain("usage.poolUsage.failed");
  });

  it("hides the canceled metric when no request was canceled", () => {
    setUsage(0);
    expect(renderToStaticMarkup(<UsageLocalPoolPanel />)).not.toContain("usage.poolUsage.canceled");
  });
});
