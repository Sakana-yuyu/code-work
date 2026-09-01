import { describe, expect, it } from "vite-plus/test";

import type { ByokDelegationSupervisionConfig } from "@codework/contracts";

import {
  applySubagentPromptFragment,
  buildSupervisorReviewPrompt,
  INITIAL_SUPERVISION_COUNTERS,
  nextSupervisionAction,
  parseSupervisionDecision,
  resolveSubagentPromptFragment,
  type SupervisionCounters,
} from "./DelegationSupervision.ts";

const supervisionConfig = (
  overrides: Partial<ByokDelegationSupervisionConfig> = {},
): ByokDelegationSupervisionConfig => ({
  enabled: true,
  supervisorModelId: "model-supervisor",
  reviewerModelId: "",
  maxCorrections: 2,
  maxRetries: 1,
  maxRounds: 8,
  allowReassign: true,
  allowEscalate: true,
  strictUnavailable: false,
  ...overrides,
});

describe("buildSupervisorReviewPrompt", () => {
  it("embeds the task, the bounded result, and the strict JSON contract", () => {
    const prompt = buildSupervisorReviewPrompt({
      task: "整理导出报告",
      result: "已完成报告",
      errorMessage: undefined,
      counters: INITIAL_SUPERVISION_COUNTERS,
      config: supervisionConfig(),
    });
    expect(prompt).toContain("整理导出报告");
    expect(prompt).toContain("已完成报告");
    expect(prompt).toContain('"decision"');
    expect(prompt).toContain("accept|retry|reassign|escalate|fail");
  });

  it("prefers the error message when the worker failed", () => {
    const prompt = buildSupervisorReviewPrompt({
      task: "task",
      result: "",
      errorMessage: "Executor exited with code 3",
      counters: INITIAL_SUPERVISION_COUNTERS,
      config: supervisionConfig(),
    });
    expect(prompt).toContain("执行失败");
    expect(prompt).toContain("Executor exited with code 3");
  });
});

describe("parseSupervisionDecision", () => {
  it("parses a strict JSON decision object", () => {
    const decision = parseSupervisionDecision(
      '{"decision":"retry","reason":"结果不完整","correctedTask":"重做并补全"}',
    );
    expect(decision?.decision).toBe("retry");
    expect(decision?.reason).toBe("结果不完整");
    expect(decision?.correctedTask).toBe("重做并补全");
  });

  it("extracts the decision from surrounding prose or code fences", () => {
    const decision = parseSupervisionDecision(
      '审查结论如下：\n```json\n{"decision":"accept","reason":"达成目标"}\n```',
    );
    expect(decision?.decision).toBe("accept");
  });

  it("returns undefined for unparseable or unknown decisions", () => {
    expect(parseSupervisionDecision("我觉得还行")).toBeUndefined();
    expect(parseSupervisionDecision('{"decision":"maybe"}')).toBeUndefined();
  });
});

describe("nextSupervisionAction", () => {
  const candidates = ["m-a", "m-b", "m-c"];

  it("accept ends the loop with unchanged counters", () => {
    const action = nextSupervisionAction({
      decision: { decision: "accept", reason: "", correctedTask: undefined },
      counters: INITIAL_SUPERVISION_COUNTERS,
      config: supervisionConfig(),
      candidateModelIds: candidates,
      currentModelId: "m-a",
      lastTask: "task",
    });
    expect(action.kind).toBe("done");
  });

  it("retry resubmits within the retry budget and fails once exhausted", () => {
    const counters: SupervisionCounters = { ...INITIAL_SUPERVISION_COUNTERS, retries: 0 };
    const first = nextSupervisionAction({
      decision: { decision: "retry", reason: "", correctedTask: "重试任务" },
      counters,
      config: supervisionConfig({ maxRetries: 1 }),
      candidateModelIds: candidates,
      currentModelId: "m-a",
      lastTask: "task",
    });
    expect(first.kind).toBe("resubmit");
    if (first.kind === "resubmit") {
      expect(first.taskOverride).toBe("重试任务");
      expect(first.modelOverride).toBeUndefined();
      expect(first.counters.retries).toBe(1);
    }

    const exhausted = nextSupervisionAction({
      decision: { decision: "retry", reason: "", correctedTask: undefined },
      counters: { ...INITIAL_SUPERVISION_COUNTERS, retries: 1 },
      config: supervisionConfig({ maxRetries: 1, allowEscalate: false }),
      candidateModelIds: candidates,
      currentModelId: "m-a",
      lastTask: "task",
    });
    expect(exhausted.kind).toBe("fail");
  });

  it("reassign moves to the next candidate model and respects the allowReassign flag", () => {
    const action = nextSupervisionAction({
      decision: { decision: "reassign", reason: "", correctedTask: undefined },
      counters: INITIAL_SUPERVISION_COUNTERS,
      config: supervisionConfig(),
      candidateModelIds: candidates,
      currentModelId: "m-a",
      lastTask: "task",
    });
    expect(action.kind).toBe("resubmit");
    if (action.kind === "resubmit") {
      expect(action.modelOverride).toBe("m-b");
    }

    const blocked = nextSupervisionAction({
      decision: { decision: "reassign", reason: "", correctedTask: undefined },
      counters: INITIAL_SUPERVISION_COUNTERS,
      config: supervisionConfig({ allowReassign: false }),
      candidateModelIds: candidates,
      currentModelId: "m-a",
      lastTask: "task",
    });
    expect(blocked.kind).toBe("fail");
  });

  it("maxRounds bounds the loop regardless of remaining budgets", () => {
    const counters: SupervisionCounters = { ...INITIAL_SUPERVISION_COUNTERS, round: 7 };
    const action = nextSupervisionAction({
      decision: { decision: "retry", reason: "", correctedTask: undefined },
      counters,
      config: supervisionConfig({ maxRounds: 8 }),
      candidateModelIds: candidates,
      currentModelId: "m-a",
      lastTask: "task",
    });
    expect(action.kind).toBe("fail");
  });
});

describe("subagent prompt fragments", () => {
  it("prefers configured overrides and honours empty-fragment disabling", () => {
    const profiles = [
      { subagentType: "explore", promptFragment: "" },
      { subagentType: "reviewer", promptFragment: "只审查，不修改。" },
    ];
    expect(resolveSubagentPromptFragment(profiles, "reviewer")).toBe("只审查，不修改。");
    // Empty configured fragment disables injection for that type.
    expect(resolveSubagentPromptFragment(profiles, "explore")).toBeUndefined();
    // Unknown types fall back to the builtins.
    expect(resolveSubagentPromptFragment(profiles, "generalPurpose")).toBeDefined();
    expect(resolveSubagentPromptFragment(profiles, undefined)).toBeUndefined();
  });

  it("appends the fragment after the task body", () => {
    expect(applySubagentPromptFragment("任务正文", "约束一")).toBe(
      "任务正文\n\n[子代理角色约束]\n约束一",
    );
    expect(applySubagentPromptFragment("任务正文", undefined)).toBe("任务正文");
  });
});
