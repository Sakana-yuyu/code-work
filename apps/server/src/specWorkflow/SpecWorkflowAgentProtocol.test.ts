import { describe, expect, it } from "vite-plus/test";
import type { SpecWorkflowState } from "@codework/contracts";

import {
  formatSpecWorkflowAgentInput,
  formatSpecWorkflowSelectedInput,
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
  const capability = { threadId: state.threadId, enabled: true, revision: 1, updatedAt: 1 };
  it("关闭后原样透传；纯讨论无需初始化产物且不携带其他节点授权", () => {
    expect(
      formatSpecWorkflowSelectedInput(
        { ...capability, enabled: false, selectedIntent: "design" },
        state,
        "hello",
      ),
    ).toBe("hello");
    const input = formatSpecWorkflowSelectedInput(
      { ...capability, selectedIntent: "chat" },
      null,
      "只讨论方向",
    );
    expect(input).toContain("不创建或修改任何文件");
    expect(input).toContain("当前没有已启动的工作流");
    expect(input).not.toContain("[[SPEC_WORKFLOW_INTENT:");
    expect(input).toContain("只讨论方向");
  });
  it("单选节点只授予所选 marker，未批准实施时不派发", () => {
    const input = formatSpecWorkflowSelectedInput(
      { ...capability, selectedIntent: "design" },
      { ...state, tbdCount: 0 },
      "设计接口",
    );
    expect(input).toContain("[[SPEC_WORKFLOW_INTENT: design]]");
    expect(input).not.toContain("[[SPEC_WORKFLOW_INTENT: apply]]");
    expect(input).toContain("完成后停止");
    const blocked = formatSpecWorkflowSelectedInput(
      { ...capability, selectedIntent: "apply" },
      { ...state, stage: "awaitingApproval" },
      "开始实施",
    );
    expect(blocked).toContain("proposal-not-approved");
    expect(blocked).not.toContain("[[SPEC_WORKFLOW_INTENT:");
  });
  it("修复批次允许启动独立验证，但不自动继续其他节点", () => {
    const input = formatSpecWorkflowSelectedInput(
      { ...capability, selectedIntent: "ship" },
      { ...state, mode: "fix", stage: "apply", implementationCompleted: true },
      "验证批次",
    );
    expect(input).toContain("[[SPEC_WORKFLOW_INTENT: ship]]");
    expect(input).toContain("失败时保留记录");
  });
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
