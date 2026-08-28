import type {
  CompositionControlCenterGoalLoop,
  CompositionControlCenterTask,
} from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildRedispatchInput,
  formatGoalLoopMeta,
  formatGrantMeta,
  formatSquadMeta,
  goalLoopStateLabelKey,
  resolveControlCenterTaskActions,
} from "./SettingsControlCenterRouteScreen.logic";

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

  it("renders no actions for rows without a latest run", () => {
    const actions = resolveControlCenterTaskActions(
      makeTask({ status: "in_review", goalLoop: makeGoalLoop("interrupted") }),
    );
    expect(actions).toEqual({
      redispatchable: false,
      cancellable: false,
      reviewable: false,
      abandonable: false,
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
