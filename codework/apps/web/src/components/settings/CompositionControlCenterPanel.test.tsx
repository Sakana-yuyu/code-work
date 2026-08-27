import type { CompositionControlCenterResult } from "@codework/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  environment: null as { readonly environmentId: string } | null,
  projectionAtom: Symbol("projection"),
  projectionQuery: {
    data: null as CompositionControlCenterResult | null,
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
    if (atom === mocks.projectionAtom) return mocks.projectionQuery;
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
    controlCenterProjection: () => mocks.projectionAtom,
  },
}));

import { CompositionControlCenterPanel } from "./CompositionControlCenterPanel";

const projection = (overrides: {
  readonly tasks?: CompositionControlCenterResult["tasks"];
  readonly squads?: CompositionControlCenterResult["squads"];
}): CompositionControlCenterResult => ({
  generatedAtUnixMs: 1_000,
  tasks: overrides.tasks ?? [
    {
      taskId: "task-running",
      status: "running",
      agentId: "agent-1",
      updatedAtUnixMs: 2,
      dependsOnTaskIds: [],
      latestRun: { runId: "run-1", status: "running", attempt: 1 },
      goalLoop: {
        runId: "run-1",
        state: "running",
        completedRounds: 3,
        rejectedCompletions: 1,
        terminalStatuses: [],
        settledBySupervisor: false,
      },
      grants: {
        taskId: "task-running",
        totalEvents: 2,
        revokedEvents: 1,
        lastOutcome: "revoked",
        lastOccurredAtUnixMs: 20,
      },
    },
    {
      taskId: "task-queued",
      status: "queued",
      agentId: "agent-2",
      updatedAtUnixMs: 3,
      dependsOnTaskIds: ["task-running"],
    },
  ],
  squads: overrides.squads ?? [
    {
      squadId: "squad-1",
      name: "控制中心小队",
      leaderAgentId: "agent-1",
      memberAgentIds: ["agent-1", "agent-2"],
    },
  ],
});

describe("CompositionControlCenterPanel", () => {
  beforeEach(() => {
    mocks.environment = { environmentId: "env-1" };
    mocks.projectionQuery.data = null;
    mocks.projectionQuery.error = null;
    mocks.projectionQuery.isPending = false;
    mocks.projectionQuery.refresh = vi.fn();
  });

  it("渲染任务行：状态徽标、Goal Loop 徽标与轮次/拒绝/grant 摘要", () => {
    mocks.projectionQuery.data = projection({});
    const html = renderToStaticMarkup(<CompositionControlCenterPanel />);
    expect(html).toContain('data-task-id="task-running"');
    expect(html).toContain('data-task-id="task-queued"');
    expect(html).toContain(">running</");
    expect(html).toContain(">queued</");
    // 活跃任务带轮次与拒绝摘要；无 Run 任务不渲染 goalLoop/grants 区块。
    const runningRow = html.split('data-task-id="task-running"')[1] ?? "";
    expect(runningRow).toContain("3");
    expect(runningRow).toContain("1");
    expect(html).toContain('data-squad-id="squad-1"');
  });

  it("渲染 Squad 名册：名称、队长与成员数", () => {
    mocks.projectionQuery.data = projection({});
    const html = renderToStaticMarkup(<CompositionControlCenterPanel />);
    const squadRow = html.split('data-squad-id="squad-1"')[1] ?? "";
    expect(squadRow).toContain("agent-1");
    expect(squadRow).toContain("2");
  });

  it("无环境/加载中/错误/空数据四种状态均正常渲染且不输出 undefined", () => {
    mocks.environment = null;
    const noEnv = renderToStaticMarkup(<CompositionControlCenterPanel />);
    expect(noEnv).not.toContain("data-task-id");
    expect(noEnv).not.toContain("undefined");

    mocks.environment = { environmentId: "env-1" };
    mocks.projectionQuery.isPending = true;
    const pending = renderToStaticMarkup(<CompositionControlCenterPanel />);
    expect(pending).not.toContain("data-task-id");
    expect(pending).not.toContain("undefined");

    mocks.projectionQuery.isPending = false;
    mocks.projectionQuery.error = "boom";
    const errored = renderToStaticMarkup(<CompositionControlCenterPanel />);
    expect(errored).not.toContain("data-task-id");
    expect(errored).not.toContain("undefined");

    mocks.projectionQuery.error = null;
    mocks.projectionQuery.data = projection({ tasks: [], squads: [] });
    const empty = renderToStaticMarkup(<CompositionControlCenterPanel />);
    expect(empty).not.toContain("data-task-id");
    expect(empty).not.toContain("data-squad-id");
  });

  it("投影为 null 且非 pending 时按空数据处理", () => {
    mocks.projectionQuery.data = null;
    const html = renderToStaticMarkup(<CompositionControlCenterPanel />);
    expect(html).not.toContain("data-task-id");
    expect(html).not.toContain("undefined");
  });
});
