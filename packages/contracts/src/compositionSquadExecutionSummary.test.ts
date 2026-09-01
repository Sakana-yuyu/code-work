import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSITION_SQUAD_EXECUTION_HISTORY_MAX_LIMIT,
  CompositionSquadExecutionListRequest,
  CompositionSquadExecutionSummary,
  CompositionSquadExecutionSummaryListRequest,
  CompositionSquadExecutionSummaryListResult,
} from "./composition.ts";

const decodeRequest = Schema.decodeUnknownSync(CompositionSquadExecutionSummaryListRequest);
const decodeSummary = Schema.decodeUnknownSync(CompositionSquadExecutionSummary);
const decodeResult = Schema.decodeUnknownSync(CompositionSquadExecutionSummaryListResult);

const baseSummary = {
  executionId: "execution-1",
  squadId: "squad-1",
  squadDisplayName: "发布检查组",
  projectId: "project-1",
  status: "running",
  squadRevision: 3,
  nodeCount: 2,
  pendingApprovalCount: 1,
  createdAtUnixMs: 1_000,
} as const;

describe("Squad execution history summary contracts", () => {
  it("复用 execution 历史的安全过滤条件和 limit 上限", () => {
    expect(CompositionSquadExecutionSummaryListRequest).toBe(CompositionSquadExecutionListRequest);
    expect(
      decodeRequest({
        projectId: "project-1",
        threadId: "thread-1",
        squadId: "squad-1",
        statuses: ["running", "failed"],
        limit: COMPOSITION_SQUAD_EXECUTION_HISTORY_MAX_LIMIT,
      }),
    ).toEqual({
      projectId: "project-1",
      threadId: "thread-1",
      squadId: "squad-1",
      statuses: ["running", "failed"],
      limit: COMPOSITION_SQUAD_EXECUTION_HISTORY_MAX_LIMIT,
    });
    expect(() =>
      decodeRequest({ limit: COMPOSITION_SQUAD_EXECUTION_HISTORY_MAX_LIMIT + 1 }),
    ).toThrow();
  });

  it("摘要只保留历史页需要的字段", () => {
    expect(
      decodeSummary({
        ...baseSummary,
        resultSummary: "全部节点完成。",
        failureCode: "provider_unavailable",
        goalDigest: "sha256:secret-goal",
        planDigest: "sha256:secret-plan",
        workspaceRootDigest: "sha256:secret-workspace",
        failureDetail: "SECRET_FAILURE_DETAIL",
        goalTaskId: "task-goal",
        leaderTaskId: "task-leader",
        leaderRunId: "run-leader",
        nodes: [{ taskId: "task-node", runId: "run-node" }],
        pendingApprovals: [{ approvalRequestId: "approval-1" }],
      }),
    ).toEqual({
      ...baseSummary,
      resultSummary: "全部节点完成。",
      failureCode: "provider_unavailable",
    });
  });

  it("结果数组同样强制 execution 历史上限", () => {
    expect(
      decodeResult({
        executions: Array.from(
          { length: COMPOSITION_SQUAD_EXECUTION_HISTORY_MAX_LIMIT },
          (_, index) => ({ ...baseSummary, executionId: `execution-${index}` }),
        ),
      }).executions,
    ).toHaveLength(COMPOSITION_SQUAD_EXECUTION_HISTORY_MAX_LIMIT);
    expect(() =>
      decodeResult({
        executions: Array.from(
          { length: COMPOSITION_SQUAD_EXECUTION_HISTORY_MAX_LIMIT + 1 },
          (_, index) => ({ ...baseSummary, executionId: `execution-${index}` }),
        ),
      }),
    ).toThrow();
  });
});
