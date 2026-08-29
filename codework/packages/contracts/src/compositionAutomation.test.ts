import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  CompositionAutomation,
  CompositionAutomationCreateRequest,
  CompositionAutomationDeleteResult,
  CompositionAutomationGetRequest,
  CompositionAutomationListRequest,
  CompositionAutomationListResult,
  CompositionAutomationResult,
  CompositionAutomationRetryRequest,
  CompositionAutomationRevisionMutationRequest,
  CompositionAutomationRun,
  CompositionAutomationRunListRequest,
  CompositionAutomationRunListResult,
  CompositionAutomationRunOnceRequest,
  CompositionAutomationRunRequest,
  CompositionAutomationRunResult,
  CompositionAutomationRpcError,
  CompositionAutomationTarget,
  CompositionAutomationUpdateRequest,
  makeCompositionAutomationRunIdempotencyKey,
  validateCompositionAutomation,
  validateCompositionAutomationRun,
  validateCompositionAutomationTarget,
} from "./compositionAutomation.ts";

const decodeAutomation = Schema.decodeUnknownSync(CompositionAutomation);
const decodeCreate = Schema.decodeUnknownSync(CompositionAutomationCreateRequest);
const decodeDeleteResult = Schema.decodeUnknownSync(CompositionAutomationDeleteResult);
const decodeGet = Schema.decodeUnknownSync(CompositionAutomationGetRequest);
const decodeList = Schema.decodeUnknownSync(CompositionAutomationListRequest);
const decodeListResult = Schema.decodeUnknownSync(CompositionAutomationListResult);
const decodeResult = Schema.decodeUnknownSync(CompositionAutomationResult);
const decodeRetry = Schema.decodeUnknownSync(CompositionAutomationRetryRequest);
const decodeRevisionMutation = Schema.decodeUnknownSync(
  CompositionAutomationRevisionMutationRequest,
);
const decodeRun = Schema.decodeUnknownSync(CompositionAutomationRun);
const decodeRunList = Schema.decodeUnknownSync(CompositionAutomationRunListRequest);
const decodeRunListResult = Schema.decodeUnknownSync(CompositionAutomationRunListResult);
const decodeRunOnce = Schema.decodeUnknownSync(CompositionAutomationRunOnceRequest);
const decodeRunRequest = Schema.decodeUnknownSync(CompositionAutomationRunRequest);
const decodeRunResult = Schema.decodeUnknownSync(CompositionAutomationRunResult);
const decodeTarget = Schema.decodeUnknownSync(CompositionAutomationTarget);
const decodeUpdate = Schema.decodeUnknownSync(CompositionAutomationUpdateRequest);

const agentTarget = {
  type: "agent" as const,
  agentId: "agent-1",
  capabilityIds: ["t3.workspace.read_file"],
  executionContext: {
    mode: "isolated" as const,
    workspaceRoot: "E:/workspace",
    archiveOnFinish: true,
  },
};

const activeAutomation = {
  automationId: "automation-1",
  projectId: "project-1",
  name: "每日代码审查",
  prompt: "检查项目中的高风险回归并给出证据。",
  cadence: {
    type: "cron" as const,
    expression: "0 9 * * 1-5",
    timezone: "Asia/Shanghai",
  },
  target: agentTarget,
  status: "active" as const,
  revision: 1,
  maxRuns: 10,
  runCount: 2,
  createdAtUnixMs: 1_000,
  updatedAtUnixMs: 2_000,
  nextRunAtUnixMs: 3_000,
  lastRunAtUnixMs: 1_500,
  pausedAtUnixMs: null,
  expiresAtUnixMs: 9_000,
};

describe("Composition Automation contracts", () => {
  it("定义 every 与带显式时区的 cron cadence", () => {
    expect(
      decodeCreate({
        automationId: "automation-every",
        projectId: "project-1",
        name: "周期检查",
        prompt: "检查运行状态",
        cadence: { type: "every", intervalMs: 60_000 },
        target: agentTarget,
        maxRuns: null,
        expiresAtUnixMs: null,
        runOnCreate: true,
      }).cadence,
    ).toEqual({ type: "every", intervalMs: 60_000 });

    expect(decodeAutomation(activeAutomation).cadence).toEqual({
      type: "cron",
      expression: "0 9 * * 1-5",
      timezone: "Asia/Shanghai",
    });
    expect(() =>
      decodeCreate({
        automationId: "automation-cron-without-timezone",
        projectId: "project-1",
        name: "错误 Cron",
        prompt: "不允许隐式使用服务器时区",
        cadence: { type: "cron", expression: "0 9 * * *" },
        target: agentTarget,
        maxRuns: null,
        expiresAtUnixMs: null,
        runOnCreate: false,
      }),
    ).toThrow();
  });

  it("覆盖 Agent、固定 revision Squad 与 Goal Loop 三类目标", () => {
    expect(decodeTarget(agentTarget).type).toBe("agent");
    expect(
      decodeTarget({
        type: "squad",
        squadId: "squad-1",
        squadRevision: 4,
        executionContext: { mode: "existing_thread", threadId: "thread-1" },
      }),
    ).toMatchObject({ type: "squad", squadRevision: 4 });
    expect(
      decodeTarget({
        type: "goal_loop",
        agentId: "agent-worker",
        reviewerAgentId: "agent-reviewer",
        model: "provider/model",
        capabilityIds: ["t3.workspace.read_file"],
        maxAttempts: 8,
        maxCostUnits: 20,
        stalePivotRounds: 3,
        deadlineDurationMs: 300_000,
        executionContext: {
          mode: "isolated",
          workspaceRoot: "E:/workspace",
          archiveOnFinish: false,
        },
      }),
    ).toMatchObject({ type: "goal_loop", maxAttempts: 8, stalePivotRounds: 3 });
  });

  it("拒绝重复能力、Goal Loop 自审和超过轮数的停滞阈值", () => {
    expect(
      validateCompositionAutomationTarget({
        ...agentTarget,
        capabilityIds: ["t3.workspace.read_file", "t3.workspace.read_file"],
      }),
    ).toEqual([{ code: "duplicate_capability", path: "capabilityIds" }]);

    const invalidGoalLoop = {
      type: "goal_loop" as const,
      agentId: "agent-1",
      reviewerAgentId: "agent-1",
      capabilityIds: [],
      maxAttempts: 2,
      stalePivotRounds: 3,
      executionContext: { mode: "existing_thread" as const, threadId: "thread-1" },
    };
    expect(validateCompositionAutomationTarget(invalidGoalLoop)).toEqual([
      { code: "reviewer_must_differ", path: "reviewerAgentId" },
      { code: "stale_pivot_exceeds_attempts", path: "stalePivotRounds" },
    ]);
    expect(() => decodeTarget(invalidGoalLoop)).toThrow();
  });

  it("校验 active、paused、completed 的时间与运行次数不变量", () => {
    expect(validateCompositionAutomation(activeAutomation)).toEqual([]);
    expect(() =>
      decodeAutomation({
        ...activeAutomation,
        status: "paused",
        nextRunAtUnixMs: 3_000,
        pausedAtUnixMs: null,
      }),
    ).toThrow();
    expect(() =>
      decodeAutomation({
        ...activeAutomation,
        status: "completed",
        runCount: 11,
        nextRunAtUnixMs: null,
      }),
    ).toThrow();
    expect(() =>
      decodeAutomation({
        ...activeAutomation,
        nextRunAtUnixMs: 10_000,
      }),
    ).toThrow();
  });

  it("更新请求要求至少一个业务字段并携带 expectedRevision", () => {
    expect(
      decodeUpdate({
        automationId: "automation-1",
        expectedRevision: 3,
        cadence: { type: "every", intervalMs: 120_000 },
        maxRuns: null,
      }),
    ).toMatchObject({ automationId: "automation-1", expectedRevision: 3 });
    expect(() => decodeUpdate({ automationId: "automation-1", expectedRevision: 3 })).toThrow();
  });

  it("Run 使用 scheduledFor 与稳定幂等键记录触发身份", () => {
    const idempotencyKey = makeCompositionAutomationRunIdempotencyKey({
      automationId: "automation-1",
      scheduledForUnixMs: 3_000,
    });
    const running = {
      automationRunId: "automation-run-1",
      automationId: "automation-1",
      automationRevision: 2,
      scheduledForUnixMs: 3_000,
      idempotencyKey,
      trigger: "scheduled" as const,
      status: "running" as const,
      attempt: 1,
      requestedAtUnixMs: 3_001,
      startedAtUnixMs: 3_002,
      finishedAtUnixMs: null,
      compositionTaskId: "task-1",
      compositionRunId: "run-1",
      outputSummary: null,
      errorCode: null,
      errorDetail: null,
    };

    expect(decodeRun(running).idempotencyKey).toBe("composition-automation:automation-1:3000");
    expect(validateCompositionAutomationRun(running)).toEqual([]);
    expect(
      decodeRunRequest({
        automationId: "automation-1",
        automationRevision: 2,
        scheduledForUnixMs: 3_000,
        trigger: "scheduled",
        idempotencyKey,
      }),
    ).toMatchObject({ automationId: "automation-1", scheduledForUnixMs: 3_000 });
    expect(
      makeCompositionAutomationRunIdempotencyKey({
        automationId: "automation-1",
        scheduledForUnixMs: 3_000,
      }),
    ).toBe(idempotencyKey);
    expect(() =>
      decodeRunRequest({
        automationId: "automation-1",
        automationRevision: 2,
        scheduledForUnixMs: 3_000,
        trigger: "recovery",
        idempotencyKey: "composition-automation:automation-1:recovery:3000",
      }),
    ).toThrow();
  });

  it("拒绝终态缺少结束时间、成功态带错误以及倒序时间", () => {
    const invalidRun = {
      automationRunId: "automation-run-2",
      automationId: "automation-1",
      automationRevision: 2,
      scheduledForUnixMs: 3_000,
      idempotencyKey: "composition-automation:automation-1:3000",
      trigger: "scheduled" as const,
      status: "succeeded" as const,
      attempt: 1,
      requestedAtUnixMs: 3_005,
      startedAtUnixMs: 3_004,
      finishedAtUnixMs: null,
      compositionTaskId: "task-1",
      compositionRunId: "run-1",
      outputSummary: "已完成",
      errorCode: "unexpected",
      errorDetail: null,
    };

    expect(validateCompositionAutomationRun(invalidRun)).toEqual([
      { code: "timestamp_order_invalid", path: "startedAtUnixMs" },
      { code: "terminal_time_invalid", path: "finishedAtUnixMs" },
      { code: "success_error_invalid", path: "errorCode" },
    ]);
    expect(() => decodeRun(invalidRun)).toThrow();
  });

  it("允许排队中的运行在执行器启动前被取消", () => {
    expect(
      decodeRun({
        automationRunId: "automation-run-cancelled",
        automationId: "automation-1",
        automationRevision: 2,
        scheduledForUnixMs: 3_000,
        idempotencyKey: "composition-automation:automation-1:3000",
        trigger: "run_once",
        status: "cancelled",
        attempt: 1,
        requestedAtUnixMs: 3_001,
        startedAtUnixMs: null,
        finishedAtUnixMs: 3_002,
        compositionTaskId: null,
        compositionRunId: null,
        outputSummary: null,
        errorCode: null,
        errorDetail: null,
      }),
    ).toMatchObject({ status: "cancelled", startedAtUnixMs: null });
  });

  it("定义查询、列表和 revision 保护的生命周期合同", () => {
    expect(decodeGet({ automationId: "automation-1" })).toEqual({
      automationId: "automation-1",
    });
    expect(decodeList({ projectId: "project-1", statuses: ["active", "paused"] })).toEqual({
      projectId: "project-1",
      statuses: ["active", "paused"],
    });
    expect(decodeRevisionMutation({ automationId: "automation-1", expectedRevision: 2 })).toEqual({
      automationId: "automation-1",
      expectedRevision: 2,
    });
    expect(decodeResult({ automation: activeAutomation }).automation.automationId).toBe(
      "automation-1",
    );
    expect(decodeListResult({ automations: [activeAutomation] }).automations).toHaveLength(1);
    expect(decodeDeleteResult({ automationId: "automation-1", deletedAtUnixMs: 4_000 })).toEqual({
      automationId: "automation-1",
      deletedAtUnixMs: 4_000,
    });
  });

  it("定义立即运行、失败重试和运行历史分页合同", () => {
    const runOnce = decodeRunOnce({
      automationId: "automation-1",
      expectedRevision: 2,
      operationId: "operation-run-once-1",
    });
    const retry = decodeRetry({
      automationId: "automation-1",
      automationRunId: "automation-run-1",
      expectedRevision: 2,
      operationId: "operation-retry-1",
    });
    const list = decodeRunList({
      automationId: "automation-1",
      cursor: "automation-run-cursor-1",
      limit: 50,
    });

    expect(runOnce.operationId).toBe("operation-run-once-1");
    expect(retry.automationRunId).toBe("automation-run-1");
    expect(list.limit).toBe(50);
    expect(list.cursor).toBe("automation-run-cursor-1");
    expect(
      decodeRunResult({
        run: {
          automationRunId: "automation-run-1",
          automationId: "automation-1",
          automationRevision: 2,
          scheduledForUnixMs: 3_000,
          idempotencyKey: "composition-automation:automation-1:3000",
          trigger: "scheduled",
          status: "running",
          attempt: 1,
          requestedAtUnixMs: 3_001,
          startedAtUnixMs: 3_002,
          finishedAtUnixMs: null,
          compositionTaskId: "task-1",
          compositionRunId: "run-1",
          outputSummary: null,
          errorCode: null,
          errorDetail: null,
        },
      }).run.automationRevision,
    ).toBe(2);
    expect(decodeRunListResult({ runs: [], nextCursor: null })).toEqual({
      runs: [],
      nextCursor: null,
    });
    expect(() => decodeRunList({ automationId: "automation-1", limit: 201 })).toThrow();
  });

  it("Automation RPC 错误保留稳定错误码和 revision 证据", () => {
    const error = new CompositionAutomationRpcError({
      code: "revision_conflict",
      detail: "Automation 已被其他客户端更新",
      automationId: "automation-1",
      expectedRevision: 2,
      actualRevision: 3,
    });

    expect(error.message).toContain("revision_conflict");
    expect(error.actualRevision).toBe(3);
  });
});
