import { EnvironmentId, type WorkspaceScriptRun } from "@codework/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  environment: null as { readonly environmentId: EnvironmentId } | null,
  projects: [] as ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly workspaceRoot: string;
    readonly environmentId: EnvironmentId;
    readonly scripts: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly command: string;
      readonly icon: "play";
      readonly runOnWorktreeCreate: boolean;
    }>;
  }>,
  threads: [] as ReadonlyArray<{
    readonly id: string;
    readonly projectId: string;
    readonly title: string;
    readonly worktreePath: string | null;
    readonly archivedAt: string | null;
    readonly environmentId: EnvironmentId;
  }>,
  runsAtom: Symbol("workspace-script-runs"),
  runsQuery: {
    data: null as { readonly runs: ReadonlyArray<WorkspaceScriptRun> } | null,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
  startCommand: Symbol("start-workspace-script"),
  stopCommand: Symbol("stop-workspace-script"),
}));

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironment: () => mocks.environment,
}));

vi.mock("~/state/entities", () => ({
  useProjects: () => mocks.projects,
  useThreadShells: () => mocks.threads,
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) =>
    atom === mocks.runsAtom
      ? mocks.runsQuery
      : { data: null, error: null, isPending: false, refresh: vi.fn() },
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: {
    workspaceScriptRuns: () => mocks.runsAtom,
    startWorkspaceScript: mocks.startCommand,
    stopWorkspaceScript: mocks.stopCommand,
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

import { t } from "~/i18n";

import { WorkspaceScriptsPanel } from "./WorkspaceScriptsPanel";

const RUN: WorkspaceScriptRun = {
  workspaceScriptRunId: "workspace-script-run:operation-1",
  idempotencyKey: "workspace-script:project-1:thread-1:serve:operation-1",
  projectId: "project-1",
  threadId: "thread-1",
  scriptId: "serve",
  scriptName: "启动开发服务",
  terminalId: "workspace-script-operation-1",
  cwd: "E:/workspace/project-1",
  worktreePath: "E:/workspace/project-1/.worktrees/thread-1",
  status: "running",
  healthStatus: "healthy",
  healthCheckedAtUnixMs: 1_200,
  healthDetail: null,
  ports: [
    {
      port: 5_173,
      protocol: "http",
      source: "discovered",
      url: "http://127.0.0.1:5173",
    },
  ],
  revision: 2,
  requestedAtUnixMs: 1_000,
  startedAtUnixMs: 1_100,
  finishedAtUnixMs: null,
  exitCode: null,
  exitSignal: null,
  errorCode: null,
  errorDetail: null,
  compositionTaskId: null,
  compositionRunId: null,
  updatedAtUnixMs: 1_200,
};

const renderPanel = () => renderToStaticMarkup(<WorkspaceScriptsPanel />);

describe("WorkspaceScriptsPanel", () => {
  beforeEach(() => {
    const environmentId = EnvironmentId.make("environment-1");
    mocks.environment = { environmentId };
    mocks.projects = [
      {
        id: "project-1",
        title: "Code Work",
        workspaceRoot: "E:/workspace/project-1",
        environmentId,
        scripts: [
          {
            id: "serve",
            name: "启动开发服务",
            command: "pnpm dev",
            icon: "play",
            runOnWorktreeCreate: false,
          },
        ],
      },
    ];
    mocks.threads = [
      {
        id: "thread-1",
        projectId: "project-1",
        title: "Workspace Script UI",
        worktreePath: "E:/workspace/project-1/.worktrees/thread-1",
        archivedAt: null,
        environmentId,
      },
    ];
    mocks.runsQuery.data = { runs: [RUN] };
    mocks.runsQuery.error = null;
    mocks.runsQuery.isPending = false;
    mocks.runsQuery.refresh.mockReset();
  });

  it("没有连接环境时显示明确空状态", () => {
    mocks.environment = null;

    const html = renderPanel();

    expect(html).toContain(t("workspaceScripts.title"));
    expect(html).toContain(t("workspaceScripts.noEnvironment"));
  });

  it("展示声明脚本、真实运行状态、健康、端口和停止入口", () => {
    const html = renderPanel();

    expect(html).toContain("启动开发服务");
    expect(html).toContain("pnpm dev");
    expect(html).toContain(t("workspaceScripts.start"));
    expect(html).toContain(t("workspaceScripts.stop"));
    expect(html).toContain('data-testid="workspace-script-start-serve"');
    expect(html).toContain('data-testid="workspace-script-stop-workspace-script-run:operation-1"');
    expect(html).toContain(t("workspaceScripts.health.healthy"));
    expect(html).toContain("http://127.0.0.1:5173");
    expect(html).toContain("workspace-script-operation-1");
    expect(html).not.toContain("undefined");
  });
});
