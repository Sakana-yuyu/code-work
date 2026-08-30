import type { EnvironmentProject } from "@codework/client-runtime/state/shell";
import type {
  CompositionSquad,
  CompositionSquadExecution,
  CompositionSquadExecutionListResult,
  CompositionSquadListResult,
  CompositionTaskListResult,
} from "@codework/contracts";
import { EnvironmentId, ProjectId } from "@codework/contracts";
import type { ReactNode } from "react";
// @ts-expect-error Mobile 已依赖 react-dom，但当前包未安装 DOM 类型；此测试仅做服务端静态渲染。
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  vi.stubGlobal("__DEV__", false);
  return {
    executionsAtom: Symbol("executions"),
    tasksAtom: Symbol("tasks"),
    squadsAtom: Symbol("squads"),
    compositionSquadExecutions: vi.fn(),
    listCompositionTasks: vi.fn(),
    compositionSquads: vi.fn(),
    executionsQuery: {
      data: null as CompositionSquadExecutionListResult | null,
      error: null as string | null,
      isPending: false,
      refresh: vi.fn(),
    },
    tasksQuery: {
      data: null as CompositionTaskListResult | null,
      error: null as string | null,
      isPending: false,
      refresh: vi.fn(),
    },
    squadsQuery: {
      data: null as CompositionSquadListResult | null,
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
  Pressable: ({ children }: { readonly children: ReactNode }) => <button>{children}</button>,
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
    if (atom === mocks.executionsAtom) return mocks.executionsQuery;
    if (atom === mocks.tasksAtom) return mocks.tasksQuery;
    if (atom === mocks.squadsAtom) return mocks.squadsQuery;
    if (atom === null) {
      return { data: null, error: null, isPending: false, refresh: vi.fn() };
    }
    throw new Error("unexpected query atom");
  },
}));

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    compositionSquadExecutions: (...args: unknown[]) => {
      mocks.compositionSquadExecutions(...args);
      return mocks.executionsAtom;
    },
    listCompositionTasks: (...args: unknown[]) => {
      mocks.listCompositionTasks(...args);
      return mocks.tasksAtom;
    },
    compositionSquads: (...args: unknown[]) => {
      mocks.compositionSquads(...args);
      return mocks.squadsAtom;
    },
    listCompositionTaskEvents: vi.fn(() => null),
  },
}));

import { SettingsSquadExecutionHistoryRouteScreen } from "./SettingsSquadExecutionHistoryRouteScreen";

const execution: CompositionSquadExecution = {
  executionId: "execution-mobile-1",
  squadId: "squad-build",
  squadRevision: 4,
  projectId: "project-1",
  goalDigest: "goal-digest",
  planDigest: "plan-digest",
  goalTaskId: "task-plan",
  workspaceRootDigest: "workspace-digest",
  status: "running",
  revision: 2,
  nodes: [
    {
      nodeId: "implement",
      agentId: "agent-worker",
      taskId: "task-worker",
      runId: "run-worker",
      promptDigest: "prompt-digest",
      dependsOnNodeIds: [],
    },
  ],
  leaderTaskId: "task-finalize",
  leaderRunId: "run-finalize",
  pendingApprovals: [],
  createdAtUnixMs: 1_788_000_000_000,
  updatedAtUnixMs: 1_788_000_000_100,
  startedAtUnixMs: 1_788_000_000_010,
};

const squad = {
  squadId: "squad-build",
  name: "Build Squad",
} as CompositionSquad;

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
    mocks.compositionSquadExecutions.mockReset();
    mocks.listCompositionTasks.mockReset();
    mocks.compositionSquads.mockReset();
    for (const query of [mocks.executionsQuery, mocks.tasksQuery, mocks.squadsQuery]) {
      query.data = null;
      query.error = null;
      query.isPending = false;
      query.refresh.mockReset();
    }
    mocks.projects = [];
    mocks.refreshControlOnRefresh = null;
  });

  it("查询完整 execution、Task 快照和 Squad，并显示真实节点身份", () => {
    setProject();
    mocks.executionsQuery.data = { executions: [execution] };
    mocks.tasksQuery.data = {
      tasks: [
        {
          task: {
            taskId: "task-worker",
            projectId: "project-1",
            assigneeKind: "agent",
            assigneeId: "agent-worker",
            mode: "parallel",
            status: "running",
            promptDigest: "prompt-digest",
            dependsOnTaskIds: [],
            createdAtUnixMs: 100,
            updatedAtUnixMs: 200,
          },
          latestRun: {
            runId: "run-worker",
            taskId: "task-worker",
            agentId: "agent-worker",
            runtimeId: "runtime-1",
            status: "running",
            attempt: 1,
            capabilityGrantIds: [],
          },
        },
      ],
    };
    mocks.squadsQuery.data = { squads: [squad] };

    const html = renderToStaticMarkup(<SettingsSquadExecutionHistoryRouteScreen />);

    expect(mocks.compositionSquadExecutions).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { limit: 20 },
    });
    expect(mocks.listCompositionTasks).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: {},
    });
    expect(mocks.compositionSquads).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { includeArchived: true },
    });
    expect(html).toContain("execution-mobile-1");
    expect(html).toContain("Build Squad");
    expect(html).toContain("Code Work");
    expect(html).toContain("implement");
    expect(html).toContain("task-worker");
    expect(html).toContain("run-worker");
  });

  it("首次加载时显示加载状态", () => {
    mocks.executionsQuery.isPending = true;
    const html = renderToStaticMarkup(<SettingsSquadExecutionHistoryRouteScreen />);
    expect(html).toContain("squadExecutionHistory.pending");
  });

  it("查询成功但没有 execution 时显示空态", () => {
    mocks.executionsQuery.data = { executions: [] };
    mocks.tasksQuery.data = { tasks: [] };
    mocks.squadsQuery.data = { squads: [] };
    const html = renderToStaticMarkup(<SettingsSquadExecutionHistoryRouteScreen />);
    expect(html).toContain("squadExecutionHistory.empty");
  });

  it("下拉刷新完整 Run Board 的三个数据源", () => {
    mocks.executionsQuery.data = { executions: [] };
    mocks.tasksQuery.data = { tasks: [] };
    mocks.squadsQuery.data = { squads: [] };
    renderToStaticMarkup(<SettingsSquadExecutionHistoryRouteScreen />);

    mocks.refreshControlOnRefresh?.();

    expect(mocks.executionsQuery.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.tasksQuery.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.squadsQuery.refresh).toHaveBeenCalledTimes(1);
  });
});
