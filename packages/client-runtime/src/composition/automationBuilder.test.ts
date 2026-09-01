import type { CompositionAutomation } from "@codework/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCompositionAutomationCreateRequest,
  buildCompositionAutomationUpdateRequest,
  createEmptyCompositionAutomationDraft,
  draftFromCompositionAutomation,
  getCompositionAutomationActions,
} from "./automationBuilder.ts";

const localUnixMs = (value: string): number =>
  DateTime.toEpochMillis(
    DateTime.makeZonedUnsafe(value, {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      adjustForTimeZone: true,
    }),
  );

const ACTIVE_AUTOMATION: CompositionAutomation = {
  automationId: "automation-1",
  projectId: "project-1",
  name: "Daily review",
  prompt: "Review the workspace and report blockers.",
  cadence: { type: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Shanghai" },
  target: {
    type: "goal_loop",
    agentId: "leader",
    reviewerAgentId: "reviewer",
    model: "codex",
    capabilityIds: ["workspace.read", "git.status"],
    maxAttempts: 4,
    maxCostUnits: 80,
    stalePivotRounds: 2,
    deadlineDurationMs: 1_800_000,
    executionContext: {
      mode: "isolated",
      workspaceRoot: "E:/MyProject/code-work/codework",
      archiveOnFinish: true,
    },
  },
  status: "active",
  revision: 3,
  maxRuns: 20,
  runCount: 2,
  createdAtUnixMs: 1_000,
  updatedAtUnixMs: 2_000,
  nextRunAtUnixMs: 3_000,
  lastRunAtUnixMs: 1_500,
  pausedAtUnixMs: null,
  expiresAtUnixMs: null,
};

describe("Composition Automation builder", () => {
  it("创建适合表单直接编辑的默认草稿", () => {
    expect(createEmptyCompositionAutomationDraft("Asia/Shanghai")).toEqual({
      automationId: "",
      projectId: "",
      name: "",
      prompt: "",
      cadenceType: "every",
      intervalValueText: "30",
      intervalUnit: "minute",
      cronExpression: "0 9 * * 1-5",
      timezone: "Asia/Shanghai",
      targetType: "agent",
      agentId: "",
      model: "",
      capabilityIdsText: "",
      squadId: "",
      squadRevisionText: "1",
      reviewerAgentId: "",
      maxAttemptsText: "3",
      maxCostUnitsText: "",
      stalePivotRoundsText: "",
      deadlineMinutesText: "",
      executionMode: "isolated",
      threadId: "",
      workspaceRoot: "",
      archiveOnFinish: true,
      maxRunsText: "",
      expiresAtText: "",
      runOnCreate: false,
    });
  });

  it("构建 every + Agent + existing thread 创建请求", () => {
    const draft = {
      ...createEmptyCompositionAutomationDraft("UTC"),
      automationId: " automation-1 ",
      projectId: " project-1 ",
      name: " Interval review ",
      prompt: " Check pending work. ",
      intervalValueText: "15",
      intervalUnit: "minute" as const,
      agentId: " agent-1 ",
      model: " codex ",
      capabilityIdsText: "workspace.read, git.status",
      executionMode: "existing_thread" as const,
      threadId: " thread-1 ",
      maxRunsText: "5",
      expiresAtText: "2026-08-30T12:00",
      runOnCreate: true,
    };

    const result = buildCompositionAutomationCreateRequest(draft, localUnixMs("2026-08-29T12:00"));

    expect(result.issues).toEqual([]);
    expect(result.request).toEqual({
      automationId: "automation-1",
      projectId: "project-1",
      name: "Interval review",
      prompt: "Check pending work.",
      cadence: { type: "every", intervalMs: 900_000 },
      target: {
        type: "agent",
        agentId: "agent-1",
        model: "codex",
        capabilityIds: ["workspace.read", "git.status"],
        executionContext: { mode: "existing_thread", threadId: "thread-1" },
      },
      maxRuns: 5,
      expiresAtUnixMs: localUnixMs("2026-08-30T12:00"),
      runOnCreate: true,
    });
  });

  it("构建 cron + Squad + isolated 创建请求", () => {
    const draft = {
      ...createEmptyCompositionAutomationDraft("Asia/Shanghai"),
      automationId: "automation-squad",
      projectId: "project-1",
      name: "Morning squad",
      prompt: "Run the squad review.",
      cadenceType: "cron" as const,
      cronExpression: "0 9 * * 1-5",
      targetType: "squad" as const,
      squadId: "squad-1",
      squadRevisionText: "7",
      workspaceRoot: "E:/MyProject/code-work/codework",
      archiveOnFinish: false,
    };

    const result = buildCompositionAutomationCreateRequest(draft, 1_000);

    expect(result.issues).toEqual([]);
    expect(result.request?.cadence).toEqual({
      type: "cron",
      expression: "0 9 * * 1-5",
      timezone: "Asia/Shanghai",
    });
    expect(result.request?.target).toEqual({
      type: "squad",
      squadId: "squad-1",
      squadRevision: 7,
      executionContext: {
        mode: "isolated",
        workspaceRoot: "E:/MyProject/code-work/codework",
        archiveOnFinish: false,
      },
    });
  });

  it("集中报告数字、时区、上下文和 Goal Loop 跨字段错误", () => {
    const draft = {
      ...createEmptyCompositionAutomationDraft("Invalid/Timezone"),
      automationId: "automation-invalid",
      projectId: "project-1",
      name: "Invalid goal",
      prompt: "Try it.",
      cadenceType: "cron" as const,
      cronExpression: "",
      targetType: "goal_loop" as const,
      agentId: "same-agent",
      reviewerAgentId: "same-agent",
      capabilityIdsText: "workspace.read, workspace.read",
      maxAttemptsText: "2",
      stalePivotRoundsText: "3",
      maxCostUnitsText: "0",
      deadlineMinutesText: "-1",
      workspaceRoot: "",
      maxRunsText: "0",
      expiresAtText: "2026-08-29T11:00",
    };

    const result = buildCompositionAutomationCreateRequest(draft, localUnixMs("2026-08-29T12:00"));

    expect(result.request).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "cron_expression_required",
        "timezone_invalid",
        "duplicate_capability",
        "reviewer_must_differ",
        "stale_pivot_exceeds_attempts",
        "positive_integer_required",
        "workspace_root_required",
        "expiration_must_be_future",
      ]),
    );
  });

  it("从持久化记录回填草稿，并生成带 revision 的完整更新请求", () => {
    const draft = draftFromCompositionAutomation(ACTIVE_AUTOMATION);

    expect(draft).toMatchObject({
      automationId: "automation-1",
      projectId: "project-1",
      cadenceType: "cron",
      targetType: "goal_loop",
      reviewerAgentId: "reviewer",
      maxAttemptsText: "4",
      maxCostUnitsText: "80",
      stalePivotRoundsText: "2",
      deadlineMinutesText: "30",
      executionMode: "isolated",
      archiveOnFinish: true,
      maxRunsText: "20",
    });

    const result = buildCompositionAutomationUpdateRequest(
      { ...draft, name: "Updated review" },
      ACTIVE_AUTOMATION,
      5_000,
    );

    expect(result.issues).toEqual([]);
    expect(result.request).toMatchObject({
      automationId: "automation-1",
      expectedRevision: 3,
      name: "Updated review",
      prompt: ACTIVE_AUTOMATION.prompt,
      cadence: ACTIVE_AUTOMATION.cadence,
      target: ACTIVE_AUTOMATION.target,
      maxRuns: 20,
      expiresAtUnixMs: null,
    });
  });

  it("按状态只暴露服务端真实允许的操作", () => {
    expect(getCompositionAutomationActions(ACTIVE_AUTOMATION)).toEqual([
      "pause",
      "run_once",
      "delete",
    ]);
    expect(
      getCompositionAutomationActions({
        ...ACTIVE_AUTOMATION,
        status: "paused",
        nextRunAtUnixMs: null,
        pausedAtUnixMs: 2_000,
      }),
    ).toEqual(["resume", "run_once", "delete"]);
    expect(
      getCompositionAutomationActions({
        ...ACTIVE_AUTOMATION,
        status: "completed",
        nextRunAtUnixMs: null,
      }),
    ).toEqual(["delete"]);
  });
});
