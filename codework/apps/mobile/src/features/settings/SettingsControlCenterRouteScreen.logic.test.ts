import type {
  CompositionControlCenterGoalLoop,
  CompositionControlCenterTask,
  CompositionSquad,
} from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildByokResumeRedispatchInput,
  buildControlCenterSquadRunRequest,
  buildRedispatchInput,
  buildResumeInput,
  formatByokDelegationMeta,
  formatByokResumeMeta,
  formatGoalLoopMeta,
  formatGrantMeta,
  formatSquadMeta,
  goalLoopStateLabelKey,
  resolveControlCenterEventTarget,
  resolveControlCenterTaskActions,
  sortControlCenterSquads,
} from "./SettingsControlCenterRouteScreen.logic";
import { isByokResumeRedispatchable } from "@codework/contracts";

const makeGoalLoop = (
  state: CompositionControlCenterGoalLoop["state"],
): CompositionControlCenterGoalLoop => ({
  runId: "run-1",
  state,
  completedRounds: 3,
  rejectedCompletions: 0,
  terminalStatuses: [],
  settledBySupervisor: false,
});

const makeTask = (
  overrides: Partial<CompositionControlCenterTask>,
): CompositionControlCenterTask => ({
  taskId: "task-1",
  status: "running",
  agentId: "agent-1",
  updatedAtUnixMs: 0,
  dependsOnTaskIds: [],
  ...overrides,
});

const makeRun = (
  status: CompositionControlCenterTask["status"],
): NonNullable<CompositionControlCenterTask["latestRun"]> => ({
  runId: "run-1",
  status,
  attempt: 1,
});

describe("resolveControlCenterTaskActions", () => {
  it("offers redispatch and abandon on interrupted goal loop rows with a latest run", () => {
    const actions = resolveControlCenterTaskActions(
      makeTask({
        status: "failed",
        latestRun: makeRun("failed"),
        goalLoop: makeGoalLoop("interrupted"),
      }),
    );
    expect(actions.redispatchable).toBe(true);
    expect(actions.abandonable).toBe(true);
    expect(actions.cancellable).toBe(false);
    expect(actions.reviewable).toBe(false);
    expect(actions.byokResumable).toBe(false);
  });

  it("offers redispatch but not abandon on supervisor_settled rows", () => {
    const actions = resolveControlCenterTaskActions(
      makeTask({
        status: "failed",
        latestRun: makeRun("failed"),
        goalLoop: makeGoalLoop("supervisor_settled"),
      }),
    );
    expect(actions.redispatchable).toBe(true);
    expect(actions.abandonable).toBe(false);
    expect(actions.byokResumable).toBe(false);
  });

  it("offers cancel only while the latest run is active", () => {
    for (const status of [
      "queued",
      "dispatched",
      "resuming",
      "running",
      "waiting_approval",
      "waiting_input",
      "in_review",
    ] as const) {
      expect(
        resolveControlCenterTaskActions(makeTask({ latestRun: makeRun(status) })).cancellable,
      ).toBe(true);
    }
    for (const status of ["completed", "failed", "cancelled", "timed_out", "blocked"] as const) {
      expect(
        resolveControlCenterTaskActions(makeTask({ latestRun: makeRun(status) })).cancellable,
      ).toBe(false);
    }
  });

  it("offers approve/reject only on in_review tasks with a latest run", () => {
    expect(
      resolveControlCenterTaskActions(
        makeTask({ status: "in_review", latestRun: makeRun("in_review") }),
      ).reviewable,
    ).toBe(true);
    expect(resolveControlCenterTaskActions(makeTask({ status: "in_review" })).reviewable).toBe(
      false,
    );
    expect(
      resolveControlCenterTaskActions(
        makeTask({ status: "running", latestRun: makeRun("running") }),
      ).reviewable,
    ).toBe(false);
  });

  it("offers continue only for approval or input blockers with a latest run", () => {
    for (const status of ["waiting_approval", "waiting_input"] as const) {
      const latestRun = {
        ...makeRun(status),
        runtimeTaskId: `runtime-task-${status}`,
      } as NonNullable<CompositionControlCenterTask["latestRun"]> & {
        readonly runtimeTaskId: string;
      };
      expect(resolveControlCenterTaskActions(makeTask({ status, latestRun })).resumable).toBe(true);
    }
    expect(
      resolveControlCenterTaskActions(
        makeTask({ status: "running", latestRun: makeRun("running") }),
      ).resumable,
    ).toBe(false);
    expect(resolveControlCenterTaskActions(makeTask({ status: "waiting_input" })).resumable).toBe(
      false,
    );
    expect(
      resolveControlCenterTaskActions(
        makeTask({ status: "waiting_input", latestRun: makeRun("waiting_input") }),
      ).resumable,
    ).toBe(false);
  });

  it("renders no actions for rows without a latest run", () => {
    const actions = resolveControlCenterTaskActions(
      makeTask({ status: "in_review", goalLoop: makeGoalLoop("interrupted") }),
    );
    expect(actions).toEqual({
      redispatchable: false,
      cancellable: false,
      resumable: false,
      reviewable: false,
      abandonable: false,
      byokResumable: false,
    });
  });

  it("does not offer redispatch on converged or running goal loops", () => {
    for (const state of ["not_started", "running", "converged"] as const) {
      expect(
        resolveControlCenterTaskActions(
          makeTask({ latestRun: makeRun("running"), goalLoop: makeGoalLoop(state) }),
        ).redispatchable,
      ).toBe(false);
    }
  });

  it("offers recover & redispatch when the shared predicate says so", () => {
    expect(
      resolveControlCenterTaskActions(
        makeTask({
          latestRun: { ...makeRun("failed"), failureCode: "byok_resume_interrupted" },
        }),
      ).byokResumable,
    ).toBe(true);
    expect(
      resolveControlCenterTaskActions(
        makeTask({
          latestRun: makeRun("failed"),
          byokResume: {
            runId: "run-1",
            checkpointCount: 2,
            recoveredUtf8Bytes: 42,
            recoverable: true,
            redispatchSettled: false,
          },
        }),
      ).byokResumable,
    ).toBe(true);
    expect(
      resolveControlCenterTaskActions(
        makeTask({
          latestRun: { ...makeRun("failed"), failureCode: "byok_resume_interrupted" },
          byokResume: {
            runId: "run-1",
            checkpointCount: 2,
            recoveredUtf8Bytes: 42,
            recoverable: true,
            redispatchSettled: true,
          },
        }),
      ).byokResumable,
    ).toBe(false);
  });

  it("allows cancel but hides Goal Loop redispatch/abandon/review on active BYOK delegation rows", () => {
    const actions = resolveControlCenterTaskActions(
      makeTask({
        latestRun: makeRun("running"),
        goalLoop: makeGoalLoop("interrupted"),
        byokDelegation: {
          runId: "run-1",
          delegationId: "delegation-9",
          status: "running",
          attempt: 1,
        },
      }),
    );
    expect(actions).toEqual({
      redispatchable: false,
      cancellable: true,
      resumable: false,
      reviewable: false,
      abandonable: false,
      byokResumable: false,
    });
  });

  it("hides cancel after a BYOK delegation row reaches a terminal status", () => {
    const actions = resolveControlCenterTaskActions(
      makeTask({
        latestRun: makeRun("cancelled"),
        byokDelegation: {
          runId: "run-1",
          delegationId: "delegation-9",
          status: "cancelled",
          attempt: 1,
        },
      }),
    );
    expect(actions).toEqual({
      redispatchable: false,
      cancellable: false,
      resumable: false,
      reviewable: false,
      abandonable: false,
      byokResumable: false,
    });
  });
});

describe("resolveControlCenterEventTarget", () => {
  const withRun = makeTask({ taskId: "task-events", latestRun: makeRun("running") });

  it("returns only the selected task latest run identity", () => {
    expect(resolveControlCenterEventTarget([withRun], "task-events")).toEqual({
      taskId: "task-events",
      runId: "run-1",
    });
  });

  it("returns null when the task is not selected or has no latest run", () => {
    expect(resolveControlCenterEventTarget([withRun], null)).toBe(null);
    expect(resolveControlCenterEventTarget([withRun], "task-missing")).toBe(null);
    expect(
      resolveControlCenterEventTarget([makeTask({ taskId: "task-events" })], "task-events"),
    ).toBe(null);
  });
});

describe("sortControlCenterSquads", () => {
  const squad = (overrides: Partial<CompositionSquad>): CompositionSquad => ({
    squadId: "squad-a",
    name: "Alpha",
    leaderAgentId: "agent-lead",
    memberAgentIds: ["agent-lead"],
    ...overrides,
  });

  it("excludes archived squads and sorts newest first with a stable name fallback", () => {
    expect(
      sortControlCenterSquads([
        squad({ squadId: "squad-b", name: "Beta", updatedAtUnixMs: 10 }),
        squad({ squadId: "squad-c", name: "Charlie", updatedAtUnixMs: 20 }),
        squad({ squadId: "squad-a", name: "Alpha", updatedAtUnixMs: 10 }),
        squad({ squadId: "squad-archived", archivedAtUnixMs: 30 }),
      ]).map((item) => item.squadId),
    ).toEqual(["squad-c", "squad-a", "squad-b"]);
  });
});

describe("buildControlCenterSquadRunRequest", () => {
  const executableSquad: CompositionSquad = {
    squadId: "squad-run",
    name: "Run Squad",
    leaderAgentId: "agent-lead",
    memberAgentIds: ["agent-lead", "agent-worker"],
    revision: 3,
    collaborationMode: "parallel",
    members: [
      {
        agentId: "agent-lead",
        role: "leader",
        order: 0,
        required: true,
        capabilityIds: [],
        maxConcurrentTasks: 1,
      },
      {
        agentId: "agent-worker",
        role: "worker",
        order: 1,
        required: true,
        capabilityIds: [],
        maxConcurrentTasks: 1,
      },
    ],
    maxConcurrency: 2,
    failurePolicy: "fail_fast",
    partialSuccessPolicy: "require_review",
  };

  it("builds a revision-pinned request from the selected project and trimmed goal", () => {
    expect(
      buildControlCenterSquadRunRequest({
        executionId: "mobile-execution-1",
        squad: executableSquad,
        project: { id: "project-1", workspaceRoot: "E:/MyProject/code-work" },
        goal: "  完成移动端协同验证  ",
      }),
    ).toEqual({
      request: {
        executionId: "mobile-execution-1",
        squadId: "squad-run",
        squadRevision: 3,
        projectId: "project-1",
        goal: "完成移动端协同验证",
        workspaceRoot: "E:/MyProject/code-work",
      },
      issue: null,
    });
  });

  it("rejects missing inputs, incomplete squads, archived squads, and dependency graph runs", () => {
    const base = {
      executionId: "mobile-execution-1",
      squad: executableSquad,
      project: { id: "project-1", workspaceRoot: "E:/MyProject/code-work" },
      goal: "目标",
    };
    expect(buildControlCenterSquadRunRequest({ ...base, squad: null }).issue).toBe("squad_missing");
    expect(buildControlCenterSquadRunRequest({ ...base, project: null }).issue).toBe(
      "project_missing",
    );
    expect(buildControlCenterSquadRunRequest({ ...base, goal: "  " }).issue).toBe("goal_required");
    expect(
      buildControlCenterSquadRunRequest({
        ...base,
        squad: { ...executableSquad, archivedAtUnixMs: 1 },
      }).issue,
    ).toBe("squad_archived");
    expect(
      buildControlCenterSquadRunRequest({
        ...base,
        squad: {
          squadId: "legacy",
          name: "Legacy",
          leaderAgentId: "agent-lead",
          memberAgentIds: ["agent-lead"],
        },
      }).issue,
    ).toBe("squad_configuration_incomplete");
    expect(
      buildControlCenterSquadRunRequest({
        ...base,
        squad: { ...executableSquad, collaborationMode: "dependency_graph" },
      }).issue,
    ).toBe("dependency_plan_required");
  });
});

describe("goalLoopStateLabelKey", () => {
  it("maps the five known states to i18n keys", () => {
    expect(goalLoopStateLabelKey("not_started")).toBe("controlCenter.state.notStarted");
    expect(goalLoopStateLabelKey("running")).toBe("controlCenter.state.running");
    expect(goalLoopStateLabelKey("converged")).toBe("controlCenter.state.converged");
    expect(goalLoopStateLabelKey("supervisor_settled")).toBe(
      "controlCenter.state.supervisorSettled",
    );
    expect(goalLoopStateLabelKey("interrupted")).toBe("controlCenter.state.interrupted");
  });

  it("returns null for unknown states so callers fall back to the raw value", () => {
    expect(goalLoopStateLabelKey("mystery_state")).toBe(null);
  });
});

describe("buildRedispatchInput", () => {
  it("splits capability ids on commas and drops blank entries", () => {
    expect(
      buildRedispatchInput({
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        newRunId: "t3-redispatch-abc",
        capabilityIdsText: " shell.exec , fs.write ,, ",
      }),
    ).toEqual({
      taskId: "task-1",
      runId: "run-1",
      agentId: "agent-1",
      newRunId: "t3-redispatch-abc",
      capabilityIds: ["shell.exec", "fs.write"],
    });
  });

  it("builds an empty capability grant list from empty text (mobile default)", () => {
    expect(
      buildRedispatchInput({
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        newRunId: "t3-redispatch-abc",
        capabilityIdsText: "",
      }).capabilityIds,
    ).toEqual([]);
  });
});

describe("buildResumeInput", () => {
  it("keeps the persisted task and run identity with the human action reason", () => {
    expect(
      buildResumeInput({
        taskId: "task-approval",
        runId: "run-approval",
        reason: "从人工待办继续任务",
      }),
    ).toEqual({
      taskId: "task-approval",
      runId: "run-approval",
      reason: "从人工待办继续任务",
    });
  });
});

describe("formatGoalLoopMeta", () => {
  const labels = { rounds: "Rounds", rejected: "Rejected" };

  it("shows only rounds when nothing was rejected", () => {
    expect(formatGoalLoopMeta(labels, { completedRounds: 4, rejectedCompletions: 0 })).toBe(
      "Rounds: 4",
    );
  });

  it("appends the rejected count when completions were rejected", () => {
    expect(formatGoalLoopMeta(labels, { completedRounds: 4, rejectedCompletions: 2 })).toBe(
      "Rounds: 4 · Rejected: 2",
    );
  });
});

describe("formatGrantMeta", () => {
  const labels = { grants: "Grants", revoked: "Revoked" };

  it("shows only the event total when nothing was revoked", () => {
    expect(formatGrantMeta(labels, { totalEvents: 5, revokedEvents: 0 })).toBe("Grants: 5");
  });

  it("appends the revoked count when grants were revoked", () => {
    expect(formatGrantMeta(labels, { totalEvents: 5, revokedEvents: 1 })).toBe(
      "Grants: 5 · Revoked: 1",
    );
  });
});

describe("formatSquadMeta", () => {
  it("joins the leader agent id and member count", () => {
    expect(
      formatSquadMeta(
        { leader: "Leader", members: "Members" },
        { leaderAgentId: "agent-lead", memberAgentIds: ["a", "b", "c"] },
      ),
    ).toBe("Leader: agent-lead · Members: 3");
  });
});

describe("isByokResumeRedispatchable shared predicate", () => {
  it("matches the web/contracts gate: latest run, not settled, interrupted code or recoverable chain", () => {
    const interrupted = makeTask({
      latestRun: { ...makeRun("failed"), failureCode: "byok_resume_interrupted" },
    });
    const recoverable = makeTask({
      latestRun: makeRun("failed"),
      byokResume: {
        runId: "run-1",
        checkpointCount: 1,
        recoveredUtf8Bytes: 8,
        recoverable: true,
        redispatchSettled: false,
      },
    });
    const corrupt = makeTask({
      latestRun: makeRun("failed"),
      byokResume: {
        runId: "run-1",
        checkpointCount: 1,
        recoveredUtf8Bytes: 0,
        recoverable: false,
        redispatchSettled: false,
      },
    });
    const settled = makeTask({
      latestRun: { ...makeRun("failed"), failureCode: "byok_resume_interrupted" },
      byokResume: {
        runId: "run-1",
        checkpointCount: 1,
        recoveredUtf8Bytes: 8,
        recoverable: true,
        redispatchSettled: true,
      },
    });
    expect(isByokResumeRedispatchable(interrupted)).toBe(true);
    expect(isByokResumeRedispatchable(recoverable)).toBe(true);
    expect(isByokResumeRedispatchable(corrupt)).toBe(false);
    expect(isByokResumeRedispatchable(settled)).toBe(false);
    expect(isByokResumeRedispatchable(makeTask({ latestRun: makeRun("failed") }))).toBe(false);
    expect(
      isByokResumeRedispatchable(
        makeTask({
          byokResume: {
            runId: "run-1",
            checkpointCount: 1,
            recoveredUtf8Bytes: 8,
            recoverable: true,
            redispatchSettled: false,
          },
        }),
      ),
    ).toBe(false);
    expect(resolveControlCenterTaskActions(interrupted).byokResumable).toBe(
      isByokResumeRedispatchable(interrupted),
    );
    expect(resolveControlCenterTaskActions(recoverable).byokResumable).toBe(
      isByokResumeRedispatchable(recoverable),
    );
    expect(resolveControlCenterTaskActions(settled).byokResumable).toBe(
      isByokResumeRedispatchable(settled),
    );
  });
});

describe("buildByokResumeRedispatchInput", () => {
  it("uses an empty capability grant list on mobile", () => {
    expect(
      buildByokResumeRedispatchInput({
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        newRunId: "t3-byok-resume-abc",
        note: "recover",
      }),
    ).toEqual({
      taskId: "task-1",
      runId: "run-1",
      agentId: "agent-1",
      newRunId: "t3-byok-resume-abc",
      capabilityIds: [],
      note: "recover",
    });
  });
});

describe("formatByokResumeMeta", () => {
  const labels = {
    checkpoints: "Checkpoints",
    recoveredBytes: "Bytes",
    unrecoverable: "Unrecoverable",
  };

  it("shows checkpoint count and recovered bytes when recoverable", () => {
    expect(
      formatByokResumeMeta(labels, {
        checkpointCount: 2,
        recoveredUtf8Bytes: 42,
        recoverable: true,
      }),
    ).toBe("Checkpoints: 2 · Bytes: 42");
  });

  it("marks an unrecoverable chain without recovered bytes", () => {
    expect(
      formatByokResumeMeta(labels, {
        checkpointCount: 1,
        recoveredUtf8Bytes: 0,
        recoverable: false,
      }),
    ).toBe("Checkpoints: 1 · Unrecoverable");
  });
});

describe("formatByokDelegationMeta", () => {
  const labels = { rounds: "Rounds", errorCode: "Error" };

  it("joins agent id and attempt, and appends a failure code when present", () => {
    expect(formatByokDelegationMeta(labels, { agentId: "provider:byok-inst", attempt: 1 })).toBe(
      "provider:byok-inst · Rounds: 1",
    );
    expect(
      formatByokDelegationMeta(labels, {
        agentId: "provider:byok-inst",
        attempt: 1,
        failureCode: "byok_delegation_interrupted",
      }),
    ).toBe("provider:byok-inst · Rounds: 1 · Error: byok_delegation_interrupted");
  });
});
