import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  SpecWorkflowCapability,
  SpecWorkflowControlInput,
  SpecWorkflowDispatchInput,
  SpecWorkflowEvent,
  SpecWorkflowState,
  SpecWorkflowSetInput,
} from "./specWorkflow.ts";

const decodeCapability = Schema.decodeUnknownSync(SpecWorkflowCapability);
const decodeSetInput = Schema.decodeUnknownSync(SpecWorkflowSetInput);
const decodeEvent = Schema.decodeUnknownSync(SpecWorkflowEvent);
const decodeState = Schema.decodeUnknownSync(SpecWorkflowState);
const decodeDispatch = Schema.decodeUnknownSync(SpecWorkflowDispatchInput);

describe("Spec Workflow capability contracts", () => {
  it("只允许线程级 enabled/revision/updatedAt 状态", () => {
    const capability = decodeCapability({
      threadId: "thread-1",
      enabled: false,
      revision: 0,
      updatedAt: 0,
    });

    expect(capability.enabled).toBe(false);
    expect(Object.keys(SpecWorkflowSetInput.fields)).toEqual([
      "threadId",
      "enabled",
      "expectedRevision",
    ]);
    expect(() => decodeCapability({ ...capability, revision: -1 })).toThrow();
  });

  it("支持带 revision 的显式开关和 typed 更新事件", () => {
    const input = decodeSetInput({
      threadId: "thread-1",
      enabled: true,
      expectedRevision: 0,
    });
    const event = decodeEvent({
      type: "updated",
      capability: {
        threadId: input.threadId,
        enabled: input.enabled,
        revision: 1,
        updatedAt: 1_700_000_000_000,
      },
    });

    expect(event.type).toBe("updated");
    expect(event.capability.enabled).toBe(true);
  });

  it("提供可被状态机和投影复用的 typed snapshot", () => {
    const state = decodeState({
      workflowId: "workflow-1",
      projectId: "project-1",
      threadId: "thread-1",
      changeName: "native-spec-workflow",
      mode: "full",
      stage: "research",
      status: "active",
      revision: 1,
      tbdCount: 0,
      proposalStatus: "pending",
      implementationCompleted: false,
      verificationStatus: "pending",
      acceptanceStatus: "pending",
      activeTaskId: null,
      lastError: null,
      updatedAt: 1,
    });

    expect(state.stage).toBe("research");
    expect(state.proposalStatus).toBe("pending");
  });

  it("提供 Server service 的派发、暂停和恢复合同", () => {
    const input = decodeDispatch({
      workflowId: "workflow-1",
      projectId: "project-1",
      threadId: "thread-1",
      changeName: "native-spec-workflow",
      mode: "full",
      intent: "apply",
      workspaceRoot: "C:/workspace/project-1",
      assigneeId: "agent-1",
      prompt: "执行已批准方案。",
      promptDigest: "sha256:proposal",
    });
    const control = Schema.decodeUnknownSync(SpecWorkflowControlInput)({
      threadId: input.threadId,
      expectedRevision: 5,
    });

    expect(input.intent).toBe("apply");
    expect(control.expectedRevision).toBe(5);
  });
});
