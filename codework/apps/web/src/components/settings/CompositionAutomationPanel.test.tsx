import {
  EnvironmentId,
  type CompositionAutomation,
  type CompositionAutomationRun,
} from "@codework/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  environment: null as { readonly environmentId: EnvironmentId } | null,
  projects: [] as ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly workspaceRoot: string;
    readonly environmentId: EnvironmentId;
  }>,
  automationListAtom: Symbol("automation-list"),
  automationRunsAtom: Symbol("automation-runs"),
  listQuery: {
    data: null as { readonly automations: ReadonlyArray<CompositionAutomation> } | null,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
  runsQuery: {
    data: null as {
      readonly runs: ReadonlyArray<CompositionAutomationRun>;
      readonly nextCursor: string | null;
    } | null,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
}));

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironment: () => mocks.environment,
}));

vi.mock("~/state/entities", () => ({
  useProjects: () => mocks.projects,
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) =>
    atom === mocks.automationListAtom
      ? mocks.listQuery
      : atom === mocks.automationRunsAtom
        ? mocks.runsQuery
        : { data: null, error: null, isPending: false, refresh: vi.fn() },
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: {
    compositionAutomations: () => mocks.automationListAtom,
    compositionAutomationRuns: () => mocks.automationRunsAtom,
    createCompositionAutomation: Symbol("create-automation"),
    updateCompositionAutomation: Symbol("update-automation"),
    pauseCompositionAutomation: Symbol("pause-automation"),
    resumeCompositionAutomation: Symbol("resume-automation"),
    deleteCompositionAutomation: Symbol("delete-automation"),
    runCompositionAutomationOnce: Symbol("run-automation-once"),
    retryCompositionAutomationRun: Symbol("retry-automation-run"),
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

import { t } from "~/i18n";

import { CompositionAutomationPanel } from "./CompositionAutomationPanel";

const AUTOMATION: CompositionAutomation = {
  automationId: "automation-1",
  projectId: "project-1",
  name: "Daily review",
  prompt: "Review the workspace.",
  cadence: { type: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Shanghai" },
  target: {
    type: "agent",
    agentId: "provider:codex",
    capabilityIds: ["workspace.read"],
    executionContext: {
      mode: "isolated",
      workspaceRoot: "E:/MyProject/code-work/codework",
      archiveOnFinish: true,
    },
  },
  status: "active",
  revision: 2,
  maxRuns: null,
  runCount: 1,
  createdAtUnixMs: 1_000,
  updatedAtUnixMs: 2_000,
  nextRunAtUnixMs: 3_000,
  lastRunAtUnixMs: 2_000,
  pausedAtUnixMs: null,
  expiresAtUnixMs: null,
};

const FAILED_RUN: CompositionAutomationRun = {
  automationRunId: "automation-run-1",
  automationId: "automation-1",
  automationRevision: 2,
  scheduledForUnixMs: 2_000,
  idempotencyKey: "composition-automation:automation-1:2000",
  trigger: "scheduled",
  status: "failed",
  attempt: 1,
  requestedAtUnixMs: 2_000,
  startedAtUnixMs: 2_100,
  finishedAtUnixMs: 2_200,
  compositionTaskId: "task-1",
  compositionRunId: "run-1",
  outputSummary: null,
  errorCode: "provider_unavailable",
  errorDetail: "Provider unavailable",
};

const renderPanel = () => renderToStaticMarkup(<CompositionAutomationPanel />);

describe("CompositionAutomationPanel", () => {
  beforeEach(() => {
    mocks.environment = { environmentId: EnvironmentId.make("environment-1") };
    mocks.projects = [
      {
        id: "project-1",
        title: "Code Work",
        workspaceRoot: "E:/MyProject/code-work/codework",
        environmentId: EnvironmentId.make("environment-1"),
      },
    ];
    mocks.listQuery.data = { automations: [AUTOMATION] };
    mocks.listQuery.error = null;
    mocks.listQuery.isPending = false;
    mocks.listQuery.refresh.mockReset();
    mocks.runsQuery.data = { runs: [FAILED_RUN], nextCursor: null };
    mocks.runsQuery.error = null;
    mocks.runsQuery.isPending = false;
    mocks.runsQuery.refresh.mockReset();
  });

  it("没有环境时显示明确空状态", () => {
    mocks.environment = null;

    const html = renderPanel();

    expect(html).toContain(t("automationCenter.title"));
    expect(html).toContain(t("automationCenter.noEnvironment"));
  });

  it("展示 Automation 编辑、真实生命周期操作和失败运行重试", () => {
    const html = renderPanel();

    expect(html).toContain("Daily review");
    expect(html).toContain(t("automationCenter.action.pause"));
    expect(html).toContain(t("automationCenter.action.runOnce"));
    expect(html).toContain(t("automationCenter.action.delete"));
    expect(html).toContain(t("automationCenter.historyTitle"));
    expect(html).toContain("provider_unavailable");
    expect(html).toContain(t("automationCenter.action.retry"));
    expect(html).not.toContain("undefined");
  });
});
