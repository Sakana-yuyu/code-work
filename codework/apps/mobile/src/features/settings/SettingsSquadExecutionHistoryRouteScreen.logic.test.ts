import type { CompositionSquadRunBoardExecution } from "@codework/client-runtime/composition/squad-run-board";
import type { CompositionSquadExecutionStatus } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  projectSquadRunBoardHistory,
  SQUAD_EXECUTION_HISTORY_STATUS_LABEL_KEYS,
  squadExecutionHistoryStatusLabelKey,
} from "./SettingsSquadExecutionHistoryRouteScreen.logic";

describe("Squad execution history status labels", () => {
  it("maps all ten persisted statuses to stable i18n keys", () => {
    const statuses = [
      "queued",
      "planning",
      "awaiting_approval",
      "running",
      "in_review",
      "paused",
      "cancelling",
      "completed",
      "failed",
      "cancelled",
    ] as const satisfies ReadonlyArray<CompositionSquadExecutionStatus>;

    expect(statuses.map(squadExecutionHistoryStatusLabelKey)).toEqual([
      "squadExecutionHistory.status.queued",
      "squadExecutionHistory.status.planning",
      "squadExecutionHistory.status.awaitingApproval",
      "squadExecutionHistory.status.running",
      "squadExecutionHistory.status.inReview",
      "squadExecutionHistory.status.paused",
      "squadExecutionHistory.status.cancelling",
      "squadExecutionHistory.status.completed",
      "squadExecutionHistory.status.failed",
      "squadExecutionHistory.status.cancelled",
    ]);
    expect(Object.keys(SQUAD_EXECUTION_HISTORY_STATUS_LABEL_KEYS)).toHaveLength(10);
  });
});

describe("projectSquadRunBoardHistory", () => {
  it("为完整 execution 投影补充 Squad 与项目展示名，不丢失节点快照", () => {
    const board = {
      executionId: "execution-board",
      squadId: "squad-1",
      squadRevision: 5,
      projectId: "project-1",
      status: "running",
      pendingApprovalCount: 0,
      createdAtUnixMs: 1_000,
      updatedAtUnixMs: 2_000,
      nodes: [
        {
          nodeId: "worker",
          taskId: "task-worker",
          runId: "run-worker",
          agentId: "agent-worker",
        },
      ],
    } satisfies CompositionSquadRunBoardExecution;

    const [item] = projectSquadRunBoardHistory(
      [board],
      new Map([["squad-1", "移动协作组"]]),
      new Map([["project-1", "Code Work"]]),
    );

    expect(item).toMatchObject({
      executionId: "execution-board",
      squadDisplayName: "移动协作组",
      projectTitle: "Code Work",
      statusLabelKey: "squadExecutionHistory.status.running",
      revision: 5,
      nodes: board.nodes,
    });
  });
});
