import type { EnvironmentProject } from "@codework/client-runtime/state/shell";
import type {
  CompositionSquadExecutionSummary,
  CompositionSquadExecutionSummaryListResult,
} from "@codework/contracts";
import { EnvironmentId, ProjectId } from "@codework/contracts";
import type { ReactNode } from "react";
// @ts-expect-error Mobile 已依赖 react-dom，但当前包未安装 DOM 类型；此测试仅做服务端静态渲染。
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  vi.stubGlobal("__DEV__", false);
  return {
    summariesAtom: Symbol("summaries"),
    compositionSquadExecutionSummaries: vi.fn(),
    summariesQuery: {
      data: null as CompositionSquadExecutionSummaryListResult | null,
      error: null as string | null,
      isPending: false,
      refresh: vi.fn(),
    },
    projects: [] as EnvironmentProject[],
    refreshControlOnRefresh: null as (() => void) | null,
  };
});

vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: vi.fn() }),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  RefreshControl: ({
    refreshing,
    onRefresh,
  }: {
    readonly refreshing: boolean;
    readonly onRefresh: () => void;
  }) => {
    mocks.refreshControlOnRefresh = onRefresh;
    return <span data-refreshing={refreshing ? "true" : "false"} />;
  },
  ScrollView: ({
    children,
    refreshControl,
  }: {
    readonly children: ReactNode;
    readonly refreshControl?: ReactNode;
  }) => (
    <section>
      {refreshControl}
      {children}
    </section>
  ),
  View: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));

vi.mock("../../components/AndroidScreenHeader", () => ({
  AndroidScreenHeader: () => null,
}));

vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { readonly children: ReactNode }) => <span>{children}</span>,
}));

vi.mock("../../native/StackHeader", () => ({
  NativeStackScreenOptions: () => null,
}));

vi.mock("../../i18n", () => ({
  t: (key: string, params?: Readonly<Record<string, string | number>>) => {
    if (params === undefined) return key;
    return Object.entries(params).reduce(
      (message, [name, value]) => message.replace(`{{${name}}}`, String(value)),
      key,
    );
  },
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: EnvironmentId.make("env-test") }] }),
}));

vi.mock("../../state/entities", () => ({
  useProjects: () => mocks.projects,
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    expect(atom).toBe(mocks.summariesAtom);
    return mocks.summariesQuery;
  },
}));

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    compositionSquadExecutionSummaries: (...args: unknown[]) => {
      mocks.compositionSquadExecutionSummaries(...args);
      return mocks.summariesAtom;
    },
  },
}));

import { SettingsSquadExecutionHistoryRouteScreen } from "./SettingsSquadExecutionHistoryRouteScreen";

const makeSummary = (
  overrides: Partial<CompositionSquadExecutionSummary> = {},
): CompositionSquadExecutionSummary => ({
  executionId: "execution-mobile-1",
  squadId: "squad-build",
  squadDisplayName: "Build Squad",
  squadRevision: 4,
  projectId: "project-1",
  status: "failed",
  nodeCount: 1,
  pendingApprovalCount: 0,
  resultSummary: "实现完成，复核失败。",
  failureCode: "review_rejected",
  createdAtUnixMs: 1_788_000_000_000,
  ...overrides,
});

const setProject = (): void => {
  mocks.projects = [
    {
      environmentId: EnvironmentId.make("env-test"),
      id: ProjectId.make("project-1"),
      title: "Code Work",
      workspaceRoot: "E:\\workspace\\code-work",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
    },
  ];
};

describe("SettingsSquadExecutionHistoryRouteScreen", () => {
  beforeEach(() => {
    mocks.compositionSquadExecutionSummaries.mockReset();
    mocks.summariesQuery.data = null;
    mocks.summariesQuery.error = null;
    mocks.summariesQuery.isPending = false;
    mocks.summariesQuery.refresh.mockReset();
    mocks.projects = [];
    mocks.refreshControlOnRefresh = null;
  });

  it("只查询安全摘要并显示最近 execution", () => {
    setProject();
    const summary = makeSummary();
    mocks.summariesQuery.data = { executions: [summary] };

    const html = renderToStaticMarkup(<SettingsSquadExecutionHistoryRouteScreen />);

    expect(mocks.compositionSquadExecutionSummaries).toHaveBeenCalledTimes(1);
    expect(mocks.compositionSquadExecutionSummaries).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { limit: 20 },
    });
    expect(Object.keys(summary).sort()).toEqual(
      [
        "createdAtUnixMs",
        "executionId",
        "failureCode",
        "nodeCount",
        "pendingApprovalCount",
        "projectId",
        "resultSummary",
        "squadDisplayName",
        "squadId",
        "squadRevision",
        "status",
      ].sort(),
    );
    expect(summary).not.toHaveProperty("goalDigest");
    expect(summary).not.toHaveProperty("planDigest");
    expect(summary).not.toHaveProperty("workspaceRootDigest");
    expect(summary).not.toHaveProperty("taskId");
    expect(summary).not.toHaveProperty("runId");
    expect(summary).not.toHaveProperty("nodes");
    expect(summary).not.toHaveProperty("pendingApprovals");
    expect(html).toContain("execution-mobile-1");
    expect(html).toContain("Build Squad");
    expect(html).toContain("Code Work");
    expect(html).toContain("review_rejected");
    expect(html).toContain("实现完成，复核失败。");
    expect(html).not.toContain("goalDigest");
    expect(html).not.toContain("taskId");
    expect(html).not.toContain("runId");
    expect(html).not.toContain("approvalRequestId");
    expect(html).not.toContain("requestedAtUnixMs");
  });

  it("首次加载时显示加载状态", () => {
    mocks.summariesQuery.isPending = true;

    const html = renderToStaticMarkup(<SettingsSquadExecutionHistoryRouteScreen />);

    expect(html).toContain("squadExecutionHistory.pending");
    expect(html).not.toContain("squadExecutionHistory.empty");
    expect(html).not.toContain("squadExecutionHistory.error");
  });

  it("无旧数据且查询失败时显示错误状态", () => {
    mocks.summariesQuery.error = "network unavailable";

    const html = renderToStaticMarkup(<SettingsSquadExecutionHistoryRouteScreen />);

    expect(html).toContain("squadExecutionHistory.error");
    expect(html).not.toContain("squadExecutionHistory.empty");
  });

  it("查询成功但没有 execution 时显示空态", () => {
    mocks.summariesQuery.data = { executions: [] };

    const html = renderToStaticMarkup(<SettingsSquadExecutionHistoryRouteScreen />);

    expect(html).toContain("squadExecutionHistory.empty");
    expect(html).not.toContain("squadExecutionHistory.error");
  });

  it("刷新失败时保留旧列表与错误提示，并只刷新摘要查询", () => {
    setProject();
    mocks.summariesQuery.data = { executions: [makeSummary()] };
    mocks.summariesQuery.error = "refresh failed";

    const html = renderToStaticMarkup(<SettingsSquadExecutionHistoryRouteScreen />);

    expect(html).toContain("squadExecutionHistory.error");
    expect(html).toContain("execution-mobile-1");
    expect(mocks.refreshControlOnRefresh).not.toBeNull();
    mocks.refreshControlOnRefresh?.();
    expect(mocks.summariesQuery.refresh).toHaveBeenCalledTimes(1);
  });
});
