import type {
  CompositionSquadExecutionStatus,
  CompositionSquadExecutionSummary,
} from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  projectSquadExecutionHistory,
  SQUAD_EXECUTION_HISTORY_STATUS_LABEL_KEYS,
  squadExecutionHistoryStatusLabelKey,
} from "./SettingsSquadExecutionHistoryRouteScreen.logic";

const makeSummary = (
  overrides: Partial<CompositionSquadExecutionSummary> = {},
): CompositionSquadExecutionSummary => ({
  executionId: "execution-1",
  squadId: "squad-1",
  squadDisplayName: "移动端协同组",
  squadRevision: 3,
  projectId: "project-1",
  status: "running",
  nodeCount: 1,
  pendingApprovalCount: 0,
  createdAtUnixMs: 1_000,
  ...overrides,
});

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

describe("projectSquadExecutionHistory", () => {
  it("preserves server order and projects display-ready safe fields", () => {
    const first = makeSummary({
      executionId: "execution-first",
      squadRevision: 4,
      status: "awaiting_approval",
      nodeCount: 5,
      pendingApprovalCount: 2,
      resultSummary: "已完成规划，等待审批。",
      createdAtUnixMs: 9_000,
    });
    const second = makeSummary({
      executionId: "execution-second",
      squadId: "squad-2",
      squadDisplayName: "故障恢复组",
      projectId: "project-2",
      status: "failed",
      nodeCount: 0,
      pendingApprovalCount: 0,
      failureCode: "leader_dispatch_failed",
      createdAtUnixMs: 1_000,
    });

    const projected = projectSquadExecutionHistory(
      [first, second],
      new Map([
        ["project-1", "Code Work"],
        ["project-2", "移动端验收"],
      ]),
    );

    expect(projected.map((item) => item.executionId)).toEqual([
      "execution-first",
      "execution-second",
    ]);
    expect(projected[0]).toEqual({
      executionId: "execution-first",
      squadId: "squad-1",
      squadDisplayName: "移动端协同组",
      projectId: "project-1",
      projectTitle: "Code Work",
      status: "awaiting_approval",
      statusLabelKey: "squadExecutionHistory.status.awaitingApproval",
      revision: 4,
      nodeCount: 5,
      pendingApprovalCount: 2,
      createdAtUnixMs: 9_000,
      resultSummary: "已完成规划，等待审批。",
    });
    expect(projected[1]).toEqual({
      executionId: "execution-second",
      squadId: "squad-2",
      squadDisplayName: "故障恢复组",
      projectId: "project-2",
      projectTitle: "移动端验收",
      status: "failed",
      statusLabelKey: "squadExecutionHistory.status.failed",
      revision: 3,
      nodeCount: 0,
      pendingApprovalCount: 0,
      createdAtUnixMs: 1_000,
      failureCode: "leader_dispatch_failed",
    });
  });

  it("falls back to the project id and never forwards unexpected internal fields", () => {
    const summaryWithUnexpectedInternals = {
      ...makeSummary({
        squadId: "toString",
        squadDisplayName: "服务端协同组",
        projectId: "__proto__",
        nodeCount: 7,
      }),
      goalDigest: "private goal digest",
      workspaceRootDigest: "private workspace digest",
      planDigest: "private plan digest",
      failureDetail: "private failure detail",
      nodes: [
        {
          taskId: "other-execution:squad:other-squad:r99:task:misleading",
          promptDigest: "private prompt digest",
        },
      ],
    };
    const [item] = projectSquadExecutionHistory([summaryWithUnexpectedInternals], new Map());

    expect(item).toMatchObject({
      squadDisplayName: "服务端协同组",
      projectTitle: "__proto__",
      nodeCount: 7,
    });
    expect(item).not.toHaveProperty("resultSummary");
    expect(item).not.toHaveProperty("failureCode");
    expect(item).not.toHaveProperty("failureDetail");
    expect(item).not.toHaveProperty("goalDigest");
    expect(item).not.toHaveProperty("workspaceRootDigest");
    expect(item).not.toHaveProperty("planDigest");
    expect(item).not.toHaveProperty("nodes");
    expect(item).not.toHaveProperty("promptDigest");
  });
});
