import type {
  CompositionSquadExecution,
  CompositionSquadExecutionListResult,
  CompositionSquadExecutionResult,
  CompositionSquadListResult,
  CompositionSquadRevisionListResult,
  CompositionTaskEventsResult,
  CompositionTaskListResult,
  CompositionTaskStatus,
} from "@codework/contracts";
import { EnvironmentId, ProjectId } from "@codework/contracts";
import type { EnvironmentProject } from "@codework/client-runtime/state/shell";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { t } from "~/i18n";

const mocks = vi.hoisted(() => ({
  environment: null as { readonly environmentId: string } | null,
  projects: [] as EnvironmentProject[],
  atoms: {
    squads: Symbol("squads"),
    revisions: Symbol("revisions"),
    executions: Symbol("executions"),
    tasks: Symbol("tasks"),
    events: Symbol("events"),
    run: Symbol("run"),
    cancel: Symbol("cancel"),
    resume: Symbol("resume"),
    review: Symbol("review"),
    retry: Symbol("retry"),
  },
  queries: {
    squads: {
      data: null as CompositionSquadListResult | null,
      error: null as string | null,
      isPending: false,
      refresh: vi.fn(),
    },
    revisions: {
      data: null as CompositionSquadRevisionListResult | null,
      error: null as string | null,
      isPending: false,
      refresh: vi.fn(),
    },
    executions: {
      data: null as CompositionSquadExecutionListResult | null,
      error: null as string | null,
      isPending: false,
      refresh: vi.fn(),
    },
    tasks: {
      data: null as CompositionTaskListResult | null,
      error: null as string | null,
      isPending: false,
      refresh: vi.fn(),
    },
    events: {
      data: null as CompositionTaskEventsResult | null,
      error: null as string | null,
      isPending: false,
      refresh: vi.fn(),
    },
  },
  compositionSquads: vi.fn(),
  compositionSquadRevisions: vi.fn(),
  compositionSquadExecutions: vi.fn(),
  listCompositionTasks: vi.fn(),
  listCompositionTaskEvents: vi.fn(),
  runCommand: vi.fn(),
  useAtomCommand: vi.fn(),
}));

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironment: () => mocks.environment,
}));

vi.mock("~/state/entities", () => ({
  useProjects: () => mocks.projects,
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    if (atom === mocks.atoms.squads) return mocks.queries.squads;
    if (atom === mocks.atoms.revisions) return mocks.queries.revisions;
    if (atom === mocks.atoms.executions) return mocks.queries.executions;
    if (atom === mocks.atoms.tasks) return mocks.queries.tasks;
    if (atom === mocks.atoms.events) return mocks.queries.events;
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
    compositionSquads: (...args: unknown[]) => {
      mocks.compositionSquads(...args);
      return mocks.atoms.squads;
    },
    compositionSquadRevisions: (...args: unknown[]) => {
      mocks.compositionSquadRevisions(...args);
      return mocks.atoms.revisions;
    },
    compositionSquadExecutions: (...args: unknown[]) => {
      mocks.compositionSquadExecutions(...args);
      return mocks.atoms.executions;
    },
    listCompositionTasks: (...args: unknown[]) => {
      mocks.listCompositionTasks(...args);
      return mocks.atoms.tasks;
    },
    listCompositionTaskEvents: (...args: unknown[]) => {
      mocks.listCompositionTaskEvents(...args);
      return mocks.atoms.events;
    },
    runCompositionSquad: mocks.atoms.run,
    cancelCompositionTask: mocks.atoms.cancel,
    resumeCompositionTask: mocks.atoms.resume,
    reviewCompositionTask: mocks.atoms.review,
    retryCompositionTask: mocks.atoms.retry,
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown, options: unknown) => {
    mocks.useAtomCommand(command, options);
    return mocks.runCommand;
  },
}));

import {
  CompositionSquadExecutionResultView,
  CompositionSquadRunPanel,
} from "./CompositionSquadRunPanel";

const activeSquad = {
  squadId: "squad-active",
  name: "Build Squad",
  leaderAgentId: "agent-lead",
  memberAgentIds: ["agent-lead", "agent-build"],
  revision: 3,
  collaborationMode: "parallel" as const,
  members: [
    {
      agentId: "agent-lead",
      role: "leader" as const,
      order: 0,
      required: true,
      capabilityIds: [],
      maxConcurrentTasks: 1,
    },
    {
      agentId: "agent-build",
      role: "worker" as const,
      order: 1,
      required: true,
      capabilityIds: [],
      maxConcurrentTasks: 1,
    },
  ],
  maxConcurrency: 2,
  failurePolicy: "fail_fast" as const,
  partialSuccessPolicy: "reject" as const,
};

const project = (environmentId: string, id: string, title: string): EnvironmentProject => ({
  environmentId: EnvironmentId.make(environmentId),
  id: ProjectId.make(id),
  title,
  workspaceRoot: `E:\\workspace\\${id}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
});

const task = (taskId: string, status: CompositionTaskStatus) => ({
  taskId,
  projectId: "project-1",
  assigneeKind: "agent" as const,
  assigneeId: "agent-build",
  mode: "parallel" as const,
  status,
  promptDigest: `sha256:${taskId}`,
  dependsOnTaskIds: [],
  createdAtUnixMs: 1,
  updatedAtUnixMs: 2,
});

const run = (runId: string, status: CompositionTaskStatus) => ({
  runId,
  taskId: runId.replace("run", "task"),
  agentId: "agent-build",
  runtimeId: "runtime-1",
  status,
  attempt: 2,
  capabilityGrantIds: [],
  ...(status === "completed"
    ? { resultSummary: "Implementation completed" }
    : { failureCode: "provider_timeout" }),
});

const executionResult: CompositionSquadExecutionResult = {
  executionId: "execution-1",
  squadId: "squad-active",
  squadRevision: 3,
  graph: {
    leader: {
      task: {
        ...task("task-leader", "completed"),
        assigneeKind: "squad",
        assigneeId: "squad-active",
        mode: "review",
      },
      run: {
        ...run("run-leader", "completed"),
        taskId: "task-leader",
        agentId: "agent-lead",
        attempt: 1,
      },
    },
    children: [
      {
        nodeId: "build",
        task: task("task-build", "completed"),
        run: { ...run("run-build", "completed"), taskId: "task-build" },
        attempts: 2,
        dispatches: [],
      },
    ],
    failures: [
      {
        nodeId: "review",
        kind: "failed",
        failureCode: "provider_timeout",
        detail: "Provider did not respond",
        task: task("task-review", "failed"),
        run: { ...run("run-review", "failed"), taskId: "task-review" },
      },
    ],
  },
};

const executionRecord = (
  overrides: Partial<CompositionSquadExecution> = {},
): CompositionSquadExecution => ({
  executionId: "execution-record",
  squadId: "squad-active",
  squadRevision: 3,
  projectId: "project-1",
  goalDigest: "sha256:goal",
  goalTaskId: "execution-record:squad:squad-active:r3:task:leader-plan",
  workspaceRootDigest: "sha256:workspace",
  status: "queued",
  revision: 1,
  leaderTaskId: "execution-record:squad:squad-active:r3:task:leader-finalize",
  leaderRunId: "execution-record:squad:squad-active:r3:run:leader-finalize",
  pendingApprovals: [],
  createdAtUnixMs: 100,
  updatedAtUnixMs: 100,
  ...overrides,
});

describe("CompositionSquadRunPanel", () => {
  beforeEach(() => {
    mocks.environment = null;
    mocks.projects = [];
    mocks.queries.squads.data = null;
    mocks.queries.squads.error = null;
    mocks.queries.squads.isPending = false;
    mocks.queries.revisions.data = null;
    mocks.queries.revisions.error = null;
    mocks.queries.revisions.isPending = false;
    mocks.queries.executions.data = null;
    mocks.queries.executions.error = null;
    mocks.queries.executions.isPending = false;
    mocks.queries.tasks.data = null;
    mocks.queries.tasks.error = null;
    mocks.queries.tasks.isPending = false;
    mocks.queries.events.data = null;
    mocks.queries.events.error = null;
    mocks.queries.events.isPending = false;
    mocks.compositionSquads.mockReset();
    mocks.compositionSquadRevisions.mockReset();
    mocks.compositionSquadExecutions.mockReset();
    mocks.listCompositionTasks.mockReset();
    mocks.listCompositionTaskEvents.mockReset();
    mocks.runCommand.mockReset();
    mocks.useAtomCommand.mockReset();
  });

  it("查询当前环境的 Squad，并查询所选 Squad 的 revision 历史", () => {
    mocks.environment = { environmentId: EnvironmentId.make("env-test") };
    mocks.projects = [
      project("env-test", "project-1", "Code Work"),
      project("env-other", "project-2", "Other environment"),
    ];
    mocks.queries.squads.data = { squads: [activeSquad] };
    mocks.queries.revisions.data = {
      revisions: [
        {
          squadId: "squad-active",
          revision: 3,
          configuration: activeSquad,
          createdAtUnixMs: 1_788_000_000_000,
        },
        {
          squadId: "squad-active",
          revision: 2,
          configuration: null,
          createdAtUnixMs: 1_787_000_000_000,
        },
      ],
    };

    const html = renderToStaticMarkup(<CompositionSquadRunPanel />);

    expect(mocks.compositionSquads).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { includeArchived: true },
    });
    expect(mocks.compositionSquadRevisions).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { squadId: "squad-active" },
    });
    expect(mocks.compositionSquadExecutions).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { projectId: "project-1", squadId: "squad-active", limit: 50 },
    });
    expect(mocks.useAtomCommand).toHaveBeenCalledWith(mocks.atoms.run, {
      reportFailure: false,
    });
    expect(html).toContain('data-squad-run-environment="env-test"');
    expect(html).toContain('data-squad-run-id="squad-active"');
    expect(html).toContain('data-squad-revision="3"');
    expect(html).toContain('data-squad-revision="2"');
    expect(html).toContain("Code Work");
    expect(html).not.toContain("Other environment");
    expect(html).toContain('data-testid="squad-run"');
  });

  it("归档 Squad 不提供新运行入口", () => {
    mocks.environment = { environmentId: EnvironmentId.make("env-test") };
    mocks.projects = [project("env-test", "project-1", "Code Work")];
    mocks.queries.squads.data = {
      squads: [{ ...activeSquad, archivedAtUnixMs: 1_788_000_000_000 }],
    };
    mocks.queries.revisions.data = { revisions: [] };

    const html = renderToStaticMarkup(<CompositionSquadRunPanel />);

    expect(html).toContain(t("squadRun.archivedReadonly"));
    expect(html).not.toContain('data-testid="squad-run"');
  });

  it("显示真实 execution、Leader、子节点尝试次数和结构化失败", () => {
    const html = renderToStaticMarkup(
      <CompositionSquadExecutionResultView result={executionResult} />,
    );

    expect(html).toContain("execution-1");
    expect(html).toContain('data-squad-result-node="leader"');
    expect(html).toContain('data-squad-result-node="build"');
    expect(html).toContain('data-squad-result-node="review"');
    expect(html).toContain(t("squadRun.attempts", { count: 2 }));
    expect(html).toContain("Implementation completed");
    expect(html).toContain("provider_timeout");
    expect(html).toContain("Provider did not respond");
  });

  it("显示没有 Task 的排队、规划和派发前失败 execution", () => {
    mocks.environment = { environmentId: EnvironmentId.make("env-test") };
    mocks.projects = [project("env-test", "project-1", "Code Work")];
    mocks.queries.squads.data = { squads: [activeSquad] };
    mocks.queries.revisions.data = { revisions: [] };
    mocks.queries.executions.data = {
      executions: [
        executionRecord(),
        executionRecord({
          executionId: "execution-planning",
          goalTaskId: "execution-planning:squad:squad-active:r3:task:leader-plan",
          leaderTaskId: "execution-planning:squad:squad-active:r3:task:leader-finalize",
          leaderRunId: "execution-planning:squad:squad-active:r3:run:leader-finalize",
          status: "planning",
          revision: 2,
          updatedAtUnixMs: 200,
          startedAtUnixMs: 150,
        }),
        executionRecord({
          executionId: "execution-failed-before-tasks",
          goalTaskId: "execution-failed-before-tasks:squad:squad-active:r3:task:leader-plan",
          leaderTaskId: "execution-failed-before-tasks:squad:squad-active:r3:task:leader-finalize",
          leaderRunId: "execution-failed-before-tasks:squad:squad-active:r3:run:leader-finalize",
          status: "failed",
          revision: 3,
          updatedAtUnixMs: 300,
          startedAtUnixMs: 250,
          finishedAtUnixMs: 300,
          failureCode: "planner_unavailable",
          failureDetail: "Leader planner unavailable.",
        }),
      ],
    };
    mocks.queries.tasks.data = { tasks: [] };

    const html = renderToStaticMarkup(<CompositionSquadRunPanel />);

    expect(mocks.compositionSquadExecutions).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { projectId: "project-1", squadId: "squad-active", limit: 50 },
    });
    expect(html).toContain('data-squad-history-execution="execution-record"');
    expect(html).toContain('data-squad-history-execution="execution-planning"');
    expect(html).toContain('data-squad-history-execution="execution-failed-before-tasks"');
    expect(html).toContain("planner_unavailable");
    expect(html).toContain("Leader planner unavailable.");
    expect(html).not.toContain('data-squad-node-action="logs"');
  });

  it("execution 历史查询失败时仍保留运行表单", () => {
    mocks.environment = { environmentId: EnvironmentId.make("env-test") };
    mocks.projects = [project("env-test", "project-1", "Code Work")];
    mocks.queries.squads.data = { squads: [activeSquad] };
    mocks.queries.revisions.data = { revisions: [] };
    mocks.queries.executions.error = "history offline";

    const html = renderToStaticMarkup(<CompositionSquadRunPanel />);

    expect(html).toContain('data-testid="squad-run"');
    expect(html).toContain(
      t("squadRun.historyFailed", {
        message: "history offline",
      }),
    );
    expect(html).not.toContain(t("squadRun.noExecutionHistory"));
  });

  it("Task enrich 查询失败时保留第一等 execution 历史", () => {
    mocks.environment = { environmentId: EnvironmentId.make("env-test") };
    mocks.projects = [project("env-test", "project-1", "Code Work")];
    mocks.queries.squads.data = { squads: [activeSquad] };
    mocks.queries.revisions.data = { revisions: [] };
    mocks.queries.executions.data = { executions: [executionRecord()] };
    mocks.queries.tasks.error = "task offline";

    const html = renderToStaticMarkup(<CompositionSquadRunPanel />);

    expect(html).toContain('data-squad-history-execution="execution-record"');
    expect(html).toContain(
      t("squadRun.historyEnrichmentFailed", {
        message: "task offline",
      }),
    );
  });

  it("从 Composition 台账显示刷新后仍可恢复的 Squad execution 历史", () => {
    mocks.environment = { environmentId: EnvironmentId.make("env-test") };
    mocks.projects = [project("env-test", "project-1", "Code Work")];
    mocks.queries.squads.data = { squads: [activeSquad] };
    mocks.queries.revisions.data = { revisions: [] };
    const buildTaskId = "execution-persisted:squad:squad-active:r3:task:build";
    const leaderTaskId = "execution-persisted:squad:squad-active:r3:task:leader-finalize";
    mocks.queries.tasks.data = {
      tasks: [
        {
          task: {
            ...task(buildTaskId, "completed"),
            assigneeId: "agent-build",
            updatedAtUnixMs: 20,
          },
          latestRun: {
            ...run("run-build", "completed"),
            taskId: buildTaskId,
            agentId: "agent-build",
            resultSummary: "持久化实现摘要",
          },
        },
        {
          task: {
            ...task(leaderTaskId, "failed"),
            assigneeKind: "squad",
            assigneeId: "squad-active",
            mode: "review",
            updatedAtUnixMs: 30,
          },
          latestRun: {
            ...run("run-leader", "failed"),
            taskId: leaderTaskId,
            agentId: "agent-lead",
            failureCode: "review_rejected",
          },
        },
      ],
    };

    const html = renderToStaticMarkup(<CompositionSquadRunPanel />);

    expect(mocks.listCompositionTasks).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { projectId: "project-1" },
    });
    expect(html).toContain('data-squad-history-execution="execution-persisted"');
    expect(html).toContain('data-squad-history-node="build"');
    expect(html).toContain('data-squad-history-node="leader-finalize"');
    expect(html).toContain("持久化实现摘要");
    expect(html).toContain("review_rejected");
    expect(html).toContain("agent-build");
    expect(html).toContain("agent-lead");
  });

  it("为持久化节点显示取消、继续、审核、重试和 Squad 成员重派操作", () => {
    mocks.environment = { environmentId: EnvironmentId.make("env-test") };
    mocks.projects = [project("env-test", "project-1", "Code Work")];
    mocks.queries.squads.data = {
      squads: [
        {
          ...activeSquad,
          memberAgentIds: [...activeSquad.memberAgentIds, "agent-review"],
          members: [
            ...activeSquad.members.map((member) =>
              member.agentId === "agent-build"
                ? { ...member, capabilityIds: ["fs.write"] }
                : member,
            ),
            {
              agentId: "agent-review",
              role: "reviewer" as const,
              order: 2,
              required: true,
              capabilityIds: ["fs.read"],
              maxConcurrentTasks: 1,
            },
          ],
        },
      ],
    };
    mocks.queries.revisions.data = { revisions: [] };
    const snapshot = (nodeId: string, status: CompositionTaskStatus, agentId: string) => {
      const taskId = `execution-actions:squad:squad-active:r3:task:${nodeId}`;
      return {
        task: {
          ...task(taskId, status),
          assigneeKind: nodeId === "leader-finalize" ? ("squad" as const) : ("agent" as const),
          assigneeId: nodeId === "leader-finalize" ? "squad-active" : agentId,
          mode: nodeId === "leader-finalize" ? ("review" as const) : ("parallel" as const),
        },
        latestRun: {
          ...run(`run-${nodeId}`, status),
          taskId,
          agentId,
          ...(status === "waiting_input" ? { runtimeTaskId: `runtime-task-${nodeId}` } : {}),
        },
      };
    };
    mocks.queries.tasks.data = {
      tasks: [
        snapshot("build", "waiting_input", "agent-build"),
        snapshot("review", "failed", "agent-build"),
        snapshot("leader-finalize", "in_review", "agent-lead"),
      ],
    };

    const html = renderToStaticMarkup(<CompositionSquadRunPanel />);

    expect(html).toContain('data-squad-node-action="cancel"');
    expect(html).toContain('data-squad-node-action="resume"');
    expect(html).toContain('data-squad-node-action="approve"');
    expect(html).toContain('data-squad-node-action="reject"');
    expect(html).toContain('data-squad-node-action="retry"');
    expect(html).toContain('data-squad-node-action="reassign"');
    expect(html).toContain(
      'data-squad-node-reassign-target="execution-actions:squad:squad-active:r3:task:review"',
    );
    expect(html).toContain("agent-review");
    expect(html).toContain(
      'data-squad-node-task="execution-actions:squad:squad-active:r3:task:build"',
    );
  });

  it("查询并显示最新 execution 的持久化节点事件日志", () => {
    mocks.environment = { environmentId: EnvironmentId.make("env-test") };
    mocks.projects = [project("env-test", "project-1", "Code Work")];
    mocks.queries.squads.data = { squads: [activeSquad] };
    mocks.queries.revisions.data = { revisions: [] };
    const leaderTaskId = "execution-events:squad:squad-active:r3:task:leader-finalize";
    const leaderRunId = "run-leader-events";
    mocks.queries.tasks.data = {
      tasks: [
        {
          task: {
            ...task(leaderTaskId, "waiting_approval"),
            assigneeKind: "squad",
            assigneeId: "squad-active",
            mode: "review",
            updatedAtUnixMs: 50,
          },
          latestRun: {
            ...run(leaderRunId, "waiting_approval"),
            taskId: leaderTaskId,
            agentId: "agent-lead",
            runtimeTaskId: "runtime-task-leader",
          },
        },
      ],
    };
    mocks.queries.events.data = {
      taskId: leaderTaskId,
      runId: leaderRunId,
      events: [
        {
          taskId: leaderTaskId,
          runId: leaderRunId,
          agentId: "agent-lead",
          runtimeId: "runtime-1",
          status: "waiting_approval",
          sequence: 0,
          eventType: "blocker",
          summary: "等待负责人确认最终结果",
          blockerCode: "approval_required",
        },
      ],
    };

    const html = renderToStaticMarkup(<CompositionSquadRunPanel />);

    expect(mocks.listCompositionTaskEvents).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { taskId: leaderTaskId, runId: leaderRunId },
    });
    expect(html).toContain('data-squad-node-action="logs"');
    expect(html).toContain(`data-squad-event-task="${leaderTaskId}"`);
    expect(html).toContain("等待负责人确认最终结果");
    expect(html).toContain("approval_required");
    expect(html).toContain("#0");
  });
});
