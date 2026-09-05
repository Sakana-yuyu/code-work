import { ProjectId, ThreadId, type SpecWorkflowLoopConfig } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import { routeSpecWorkflowIntent } from "./SpecWorkflowRouter.ts";

const enabled = {
  threadId: ThreadId.make("thread-1"),
  enabled: true,
  revision: 1,
  updatedAt: 1,
};
const disabled = { ...enabled, enabled: false };
const loopConfig = { maxAttempts: 3 } as SpecWorkflowLoopConfig;

const state = (
  overrides: Partial<{
    stage: "research" | "awaitingApproval" | "apply" | "verify";
    tbdCount: number;
    proposalStatus: "pending" | "approved" | "rejected";
    implementationCompleted: boolean;
    verificationStatus: "pending" | "passed" | "failed";
    status: "active" | "paused";
    mode: "full" | "fix" | "loop";
  }>,
) => ({
  workflowId: "workflow-1",
  projectId: ProjectId.make("project-1"),
  threadId: ThreadId.make("thread-1"),
  changeName: "native-spec-workflow",
  mode: "full" as const,
  stage: "research" as const,
  status: "active" as const,
  revision: 1,
  tbdCount: 0,
  proposalStatus: "pending" as const,
  implementationCompleted: false,
  verificationStatus: "pending" as const,
  acceptanceStatus: "pending" as const,
  activeTaskId: null,
  lastError: null,
  updatedAt: 1,
  ...overrides,
});

describe("Spec Workflow typed intent router", () => {
  it("单节点选择拒绝其他意图，允许从后续阶段单独重做调研", () => {
    const capability = { ...enabled, selectedIntent: "research" as const };
    expect(
      routeSpecWorkflowIntent({ capability, intent: "apply", state: state({ stage: "apply" }) }),
    ).toMatchObject({ action: "show-status", reason: "node-not-selected" });
    expect(
      routeSpecWorkflowIntent({
        capability,
        intent: "research",
        state: state({ stage: "verify" }),
      }),
    ).toMatchObject({ action: "advance", targetStage: "research", corrected: false });
    expect(
      routeSpecWorkflowIntent({
        capability: { ...capability, enabled: false },
        intent: "research",
      }),
    ).toMatchObject({ action: "pass-through" });
  });
  it("能力未启用时完全 pass-through", () => {
    expect(routeSpecWorkflowIntent({ capability: disabled, intent: "apply" })).toEqual({
      requestedIntent: "apply",
      action: "pass-through",
      targetStage: null,
      corrected: false,
      reason: "not-enabled",
    });
  });

  it("仍有 TBD 时把 propose 纠正到 ask", () => {
    expect(
      routeSpecWorkflowIntent({
        capability: enabled,
        state: state({ tbdCount: 2 }),
        intent: "propose",
      }),
    ).toMatchObject({
      action: "advance",
      targetStage: "ask",
      corrected: true,
      reason: "tbd-remaining",
    });
  });

  it("未批准方案时把 apply 纠正为等待确认", () => {
    expect(
      routeSpecWorkflowIntent({
        capability: enabled,
        state: state({ stage: "awaitingApproval", proposalStatus: "pending" }),
        intent: "apply",
      }),
    ).toMatchObject({
      action: "show-status",
      targetStage: "awaitingApproval",
      corrected: true,
      reason: "proposal-not-approved",
    });
  });

  it("未完成实施时阻止 verify，验证失败时把 archive 退回 apply", () => {
    expect(
      routeSpecWorkflowIntent({
        capability: enabled,
        state: state({ stage: "apply", implementationCompleted: false }),
        intent: "verify",
      }),
    ).toMatchObject({
      action: "show-status",
      targetStage: "apply",
      corrected: true,
      reason: "implementation-incomplete",
    });
    expect(
      routeSpecWorkflowIntent({
        capability: enabled,
        state: state({ stage: "verify", verificationStatus: "failed" }),
        intent: "archive",
      }),
    ).toMatchObject({
      action: "advance",
      targetStage: "apply",
      corrected: true,
      reason: "verification-failed",
    });
  });

  it("fix 在 apply 无活动任务时重新唤醒实施阶段", () => {
    expect(
      routeSpecWorkflowIntent({
        capability: enabled,
        state: state({ stage: "apply", implementationCompleted: false }),
        intent: "fix",
      }),
    ).toMatchObject({
      action: "advance",
      targetStage: "apply",
      corrected: false,
      reason: "requested-stage-allowed",
    });
  });

  it("轻量修复批次允许连续 fix，并由 ship 唤醒一次独立验证", () => {
    expect(
      routeSpecWorkflowIntent({
        capability: enabled,
        state: state({ mode: "fix", stage: "apply", implementationCompleted: true }),
        intent: "fix",
      }),
    ).toMatchObject({
      action: "advance",
      targetStage: "apply",
      corrected: false,
    });
    expect(
      routeSpecWorkflowIntent({
        capability: enabled,
        state: state({ mode: "fix", stage: "apply", implementationCompleted: true }),
        intent: "ship",
      }),
    ).toMatchObject({
      action: "advance",
      targetStage: "verify",
      corrected: true,
      reason: "fix-batch-verification-required",
    });
  });

  it("loop 没有预算时只展示当前状态，有预算时沿用 apply 门禁", () => {
    expect(
      routeSpecWorkflowIntent({
        capability: enabled,
        state: state({ stage: "awaitingApproval", proposalStatus: "approved" }),
        intent: "loop",
      }),
    ).toMatchObject({
      action: "show-status",
      targetStage: "awaitingApproval",
      corrected: true,
      reason: "loop-budget-required",
    });
    expect(
      routeSpecWorkflowIntent({
        capability: enabled,
        state: state({ stage: "awaitingApproval", proposalStatus: "approved" }),
        intent: "loop",
        loopConfig,
      }),
    ).toMatchObject({
      action: "advance",
      targetStage: "apply",
      corrected: false,
      reason: "requested-stage-allowed",
    });
  });

  it("ship 从验证通过后先纠正到 acceptance，而不是跳过最终验收", () => {
    expect(
      routeSpecWorkflowIntent({
        capability: enabled,
        state: state({ stage: "verify", verificationStatus: "passed" }),
        intent: "ship",
      }),
    ).toMatchObject({
      action: "advance",
      targetStage: "acceptance",
      corrected: true,
      reason: "acceptance-required",
    });
  });
});
