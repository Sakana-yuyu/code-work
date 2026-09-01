import type {
  CompositionAgentDriverProfile,
  CompositionTaskListResult,
  CompositionTaskEventsResult,
} from "@codework/contracts";
import { EnvironmentId } from "@codework/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { t } from "~/i18n";

const mocks = vi.hoisted(() => ({
  environment: null as { readonly environmentId: string } | null,
  driverAtom: Symbol("drivers"),
  taskAtom: Symbol("tasks"),
  eventsAtom: Symbol("events"),
  driverQuery: {
    data: null as ReadonlyArray<CompositionAgentDriverProfile> | null,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
  taskQuery: {
    data: null as CompositionTaskListResult | null,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
  eventsQuery: {
    data: null as CompositionTaskEventsResult | null,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
  commands: {
    execute: vi.fn(),
    cancel: vi.fn(),
    resume: vi.fn(),
    review: vi.fn(),
    retry: vi.fn(),
  },
  executeCommand: Symbol("execute-command"),
  cancelCommand: Symbol("cancel-command"),
  resumeCommand: Symbol("resume-command"),
  reviewCommand: Symbol("review-command"),
  retryCommand: Symbol("retry-command"),
}));

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironment: () => mocks.environment,
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    if (atom === mocks.driverAtom) return mocks.driverQuery;
    if (atom === mocks.taskAtom) return mocks.taskQuery;
    if (atom === mocks.eventsAtom) return mocks.eventsQuery;
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
    compositionAgentDrivers: () => mocks.driverAtom,
    listCompositionTasks: () => mocks.taskAtom,
    listCompositionTaskEvents: () => mocks.eventsAtom,
    executeCompositionTaskGraph: mocks.executeCommand,
    cancelCompositionTask: mocks.cancelCommand,
    resumeCompositionTask: mocks.resumeCommand,
    reviewCompositionTask: mocks.reviewCommand,
    retryCompositionTask: mocks.retryCommand,
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    if (command === mocks.executeCommand) return mocks.commands.execute;
    if (command === mocks.cancelCommand) return mocks.commands.cancel;
    if (command === mocks.resumeCommand) return mocks.commands.resume;
    if (command === mocks.reviewCommand) return mocks.commands.review;
    return mocks.commands.retry;
  },
}));

import { TaskGraphPanel } from "./TaskGraphPanel";

const profile = (
  overrides: Partial<CompositionAgentDriverProfile> = {},
): CompositionAgentDriverProfile => ({
  schemaVersion: 1,
  agentId: "driver-byok",
  runtimeId: "runtime-byok",
  driverKind: "provider",
  providerKind: "byok",
  displayName: "BYOK Driver",
  status: "available",
  capabilities: ["model"],
  supportsToolBroker: false,
  supportsCapabilityHandshake: false,
  supportsWorkspace: false,
  supportsTerminal: false,
  supportsGit: false,
  supportsMcp: false,
  supportsBrowser: false,
  supportsIde: false,
  supportsProviderApi: true,
  supportsResume: false,
  supportsSquad: false,
  supportsLeader: false,
  supportsTaskGraph: false,
  ...overrides,
});

const task = (
  status: "failed" | "waiting_approval" | "waiting_input" | "in_review" | "completed",
) => ({
  taskId: `task-${status}`,
  projectId: "project-test",
  assigneeKind: "agent" as const,
  assigneeId: "driver-byok",
  mode: "review" as const,
  status,
  promptDigest: "sha256:test",
  dependsOnTaskIds: [],
  createdAtUnixMs: 1,
  updatedAtUnixMs: 2,
});

const snapshot = (
  status: "failed" | "waiting_approval" | "waiting_input" | "in_review" | "completed",
) => ({
  task: task(status),
  latestRun: {
    runId: `run-${status}`,
    taskId: `task-${status}`,
    agentId: "driver-byok",
    runtimeId: "runtime-byok",
    status,
    attempt: 1,
    capabilityGrantIds: [],
  },
});

function renderPanel(): string {
  return renderToStaticMarkup(<TaskGraphPanel />);
}

describe("TaskGraphPanel", () => {
  beforeEach(() => {
    mocks.environment = null;
    mocks.driverQuery.data = null;
    mocks.taskQuery.data = null;
    mocks.eventsQuery.data = null;
    mocks.driverQuery.error = null;
    mocks.taskQuery.error = null;
    mocks.eventsQuery.error = null;
    mocks.commands.execute.mockReset();
    mocks.commands.cancel.mockReset();
    mocks.commands.resume.mockReset();
    mocks.commands.review.mockReset();
    mocks.commands.retry.mockReset();
  });

  it("does not crash without a connected environment", () => {
    const html = renderPanel();

    expect(html).toContain(t("taskGraph.title"));
    expect(html).toContain(t("taskGraph.notReadyTitle"));
  });

  it("shows the authorization downgrade when the Driver has no verified handshake", () => {
    mocks.environment = { environmentId: EnvironmentId.make("env-test") };
    mocks.driverQuery.data = [profile({ supportsTaskGraph: true })];
    mocks.taskQuery.data = { tasks: [] };

    const html = renderPanel();

    expect(html).toContain(t("taskGraph.unverifiedToolBroker"));
    expect(html).not.toContain(t("taskGraph.verifiedToolBroker"));
  });

  it("exposes review actions for an in-review task", () => {
    mocks.environment = { environmentId: EnvironmentId.make("env-test") };
    mocks.driverQuery.data = [profile()];
    mocks.taskQuery.data = { tasks: [snapshot("in_review")] };
    mocks.eventsQuery.data = { taskId: "task-in_review", runId: "run-in_review", events: [] };

    const html = renderPanel();

    expect(html).toContain('data-testid="task-graph-approve"');
    expect(html).toContain('data-testid="task-graph-reject"');
    expect(html).not.toContain('data-testid="task-graph-resume"');
    expect(html).toMatch(/Cancel task|取消任务/);
  });

  it.each(["waiting_approval", "waiting_input"] as const)(
    "exposes resume for a %s task and not review actions",
    (status) => {
      mocks.environment = { environmentId: EnvironmentId.make("env-test") };
      mocks.driverQuery.data = [profile()];
      mocks.taskQuery.data = { tasks: [snapshot(status)] };
      mocks.eventsQuery.data = {
        taskId: `task-${status}`,
        runId: `run-${status}`,
        events: [],
      };

      const html = renderPanel();

      expect(html).toContain('data-testid="task-graph-resume"');
      expect(html).not.toContain('data-testid="task-graph-approve"');
      expect(html).not.toContain('data-testid="task-graph-reject"');
    },
  );

  it("disables cancellation for a terminal task", () => {
    mocks.environment = { environmentId: EnvironmentId.make("env-test") };
    mocks.driverQuery.data = [profile()];
    mocks.taskQuery.data = { tasks: [snapshot("completed")] };
    mocks.eventsQuery.data = { taskId: "task-completed", runId: "run-completed", events: [] };

    const html = renderPanel();

    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?取消任务<\/button>/);
  });

  it("does not enable retry until a capability id is supplied", () => {
    mocks.environment = { environmentId: EnvironmentId.make("env-test") };
    mocks.driverQuery.data = [profile()];
    mocks.taskQuery.data = { tasks: [snapshot("failed")] };
    mocks.eventsQuery.data = { taskId: "task-failed", runId: "run-failed", events: [] };

    const html = renderPanel();

    expect(html).toContain(t("taskGraph.retryTask"));
    expect(html).toContain(`placeholder="${t("taskGraph.retryCapabilityIdsPlaceholder")}"`);
  });
});
