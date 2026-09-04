import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { useEnvironmentQueryMock } = vi.hoisted(() => ({
  useEnvironmentQueryMock: vi.fn<
    (atom: unknown) => {
      readonly data: ReadonlyArray<{ status: string }> | null;
      readonly error: null;
      readonly isPending: boolean;
      readonly refresh: () => void;
    }
  >(() => ({ data: null, error: null, isPending: false, refresh: () => {} })),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { readonly children: ReactNode; readonly to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("~/state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId: "env-1" }),
}));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: useEnvironmentQueryMock }));
vi.mock("~/state/server", () => ({
  serverEnvironment: {
    compositionAgentDrivers: (input: { environmentId: string }) => ({ ...input, kind: "query" }),
  },
}));
vi.mock("../commandPaletteBus", () => ({ openCommandPalette: vi.fn() }));

import { GettingStartedState } from "./GettingStartedState";

afterEach(() => {
  useEnvironmentQueryMock.mockReturnValue({
    data: null,
    error: null,
    isPending: false,
    refresh: () => {},
  });
});

describe("GettingStartedState", () => {
  it("walks a fresh workspace through getting-started steps with a provider shortcut", () => {
    const markup = renderToStaticMarkup(<GettingStartedState />);
    expect(markup).toContain("三步开始使用 Code Work");
    expect(markup).toContain("添加供应商：让 Agent 有可用的模型");
    expect(markup).toContain('href="/settings/providers"');
    expect(markup).toContain("添加项目：把这台机器上的代码目录加进来");
  });

  it("marks the provider step done once a driver reports available", () => {
    useEnvironmentQueryMock.mockReturnValue({
      data: [{ status: "available" }],
      error: null,
      isPending: false,
      refresh: () => {},
    });
    const markup = renderToStaticMarkup(<GettingStartedState />);
    expect(markup).toContain("供应商已就绪");
    expect(markup).not.toContain('href="/settings/providers"');
  });
});
