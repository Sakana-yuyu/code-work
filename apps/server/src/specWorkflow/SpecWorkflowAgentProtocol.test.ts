import { describe, expect, it } from "vite-plus/test";
import type { SpecWorkflowState } from "@codework/contracts";

import {
  formatSpecWorkflowAgentInput,
  parseSpecWorkflowIntent,
} from "./SpecWorkflowAgentProtocol.ts";

const state: SpecWorkflowState = {
  workflowId: "workflow-1",
  projectId: "project-1" as SpecWorkflowState["projectId"],
  threadId: "thread-1" as SpecWorkflowState["threadId"],
  changeName: "支付回调重试",
  mode: "full",
  stage: "research",
  status: "active",
  revision: 1,
  tbdCount: 2,
  proposalStatus: "pending",
  implementationCompleted: false,
  verificationStatus: "pending",
  acceptanceStatus: "pending",
  activeTaskId: null,
  loopConfig: null,
  lastError: null,
  updatedAt: 1,
};

describe("SpecWorkflowAgentProtocol", () => {
  it("只接受唯一的合同意图并剥离内部 marker", () => {
    expect(parseSpecWorkflowIntent("已完成研究。\n[[SPEC_WORKFLOW_INTENT: design]]")).toEqual({
      intent: "design",
      cleanText: "已完成研究。",
    });
  });

  it("多 marker 或未知意图不会形成可执行指令", () => {
    expect(
      parseSpecWorkflowIntent(
        "说明\n[[SPEC_WORKFLOW_INTENT: design]]\n[[SPEC_WORKFLOW_INTENT: unknown]]",
      ),
    ).toEqual({ intent: undefined, cleanText: "说明" });
  });

  it("把阶段事实和安全边界传给 Provider", () => {
    const prompt = formatSpecWorkflowAgentInput(state, "请先梳理风险");
    expect(prompt).toContain("当前阶段：research");
    expect(prompt).toContain("未决问题数：2");
    expect(prompt).toContain("Router/Decider 是最终门禁");
    expect(prompt).toContain("请先梳理风险");
  });
});
