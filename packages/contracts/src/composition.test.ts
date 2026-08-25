import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  CompositionAgentLoopRequest,
  CompositionAgentLoopRunRequest,
  CompositionAgentLoopRunResult,
  CompositionCapabilityDescriptor,
  CompositionCapabilityPolicyDecision,
  CompositionTaskCancelRequest,
  CompositionTaskDispatchRequest,
  CompositionTaskEventsResult,
  CompositionTaskListRequest,
  CompositionTaskEvent,
  CompositionToolInvocation,
  CompositionToolResult,
} from "./composition.ts";

const decodeAgentLoopRequest = Schema.decodeUnknownSync(CompositionAgentLoopRequest);
const decodeCapability = Schema.decodeUnknownSync(CompositionCapabilityDescriptor);
const decodePolicyDecision = Schema.decodeUnknownSync(CompositionCapabilityPolicyDecision);
const decodeTaskEvent = Schema.decodeUnknownSync(CompositionTaskEvent);
const decodeTaskDispatch = Schema.decodeUnknownSync(CompositionTaskDispatchRequest);
const decodeTaskCancel = Schema.decodeUnknownSync(CompositionTaskCancelRequest);
const decodeTaskEvents = Schema.decodeUnknownSync(CompositionTaskEventsResult);
const decodeTaskList = Schema.decodeUnknownSync(CompositionTaskListRequest);
const decodeToolInvocation = Schema.decodeUnknownSync(CompositionToolInvocation);
const decodeToolResult = Schema.decodeUnknownSync(CompositionToolResult);
const decodeAgentLoopRunRequest = Schema.decodeUnknownSync(CompositionAgentLoopRunRequest);
const decodeAgentLoopRunResult = Schema.decodeUnknownSync(CompositionAgentLoopRunResult);

describe("composition contracts", () => {
  it("accepts a legacy text request without agent identity", () => {
    const decoded = decodeAgentLoopRequest({
      mode: "legacy_text",
      providerInstanceId: "byok",
      modelId: "gpt-4o-mini",
      threadId: "thread-1",
    });

    expect(decoded.mode).toBe("legacy_text");
    expect("taskId" in decoded).toBe(false);
    expect("agentId" in decoded).toBe(false);
  });

  it("requires task, agent, and grants for agent_loop requests", () => {
    expect(() =>
      decodeAgentLoopRequest({
        mode: "agent_loop",
        providerInstanceId: "byok",
        modelId: "gpt-4o-mini",
        threadId: "thread-1",
      }),
    ).toThrow();

    const decoded = decodeAgentLoopRequest({
      mode: "agent_loop",
      providerInstanceId: "byok",
      modelId: "gpt-4o-mini",
      threadId: "thread-1",
      taskId: "task-1",
      agentId: "agent-1",
      capabilityGrantIds: ["grant-1"],
    });

    if (decoded.mode === "agent_loop") {
      expect(decoded.capabilityGrantIds).toEqual(["grant-1"]);
    }
  });

  it("keeps capability status separate from grant and approval state", () => {
    const decoded = decodeCapability({
      capabilityId: "workspace.read",
      kind: "tool",
      status: "available",
      grants: {
        read: true,
        execute: false,
        mutate: false,
      },
      approval: "never",
      source: "t3",
    });

    expect(decoded.status).toBe("available");
    expect(decoded.grants.read).toBe(true);
    expect(decoded.grants.mutate).toBe(false);
  });

  it("accepts explicit policy outcomes and rejects unknown decisions", () => {
    expect(
      decodePolicyDecision({
        decision: "approval_required",
        reasonCode: "tool_approval_required",
        approvalRequestId: "approval-1",
      }).decision,
    ).toBe("approval_required");

    expect(() =>
      decodePolicyDecision({
        decision: "maybe",
        reasonCode: "unknown",
      }),
    ).toThrow();
  });

  it("enforces ordered task event metadata and bounded progress", () => {
    const decoded = decodeTaskEvent({
      taskId: "task-1",
      runId: "run-1",
      agentId: "agent-1",
      status: "running",
      sequence: 3,
      eventType: "progress",
      summary: "读取工作区",
      progress: 25,
    });

    expect(decoded.sequence).toBe(3);
    expect(decoded.progress).toBe(25);
    expect(() =>
      decodeTaskEvent({
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        status: "running",
        sequence: 4,
        eventType: "progress",
        summary: "超出范围",
        progress: 101,
      }),
    ).toThrow();
  });

  it("keeps tool invocation and result identities stable", () => {
    const invocation = decodeToolInvocation({
      taskId: "task-1",
      runId: "run-1",
      agentId: "agent-1",
      toolCallId: "call-1",
      canonicalToolName: "workspace.read",
      arguments: { relativePath: "README.md" },
      idempotencyKey: "idem-1",
    });
    const result = decodeToolResult({
      invocationId: "invocation-1",
      taskId: "task-1",
      runId: "run-1",
      toolCallId: invocation.toolCallId,
      canonicalToolName: invocation.canonicalToolName,
      status: "succeeded",
      result: { contents: "ok" },
    });

    expect(result.toolCallId).toBe(invocation.toolCallId);
    expect(result.canonicalToolName).toBe(invocation.canonicalToolName);
  });

  it("keeps the explicit agent loop RPC payload separate from legacy text turns", () => {
    const decoded = decodeAgentLoopRunRequest({
      mode: "agent_loop",
      providerInstanceId: "byok",
      modelId: "openai/gpt-5",
      taskId: "task-1",
      runId: "run-1",
      agentId: "agent-1",
      workspaceRoot: "C:/workspace",
      prompt: "检查项目",
      capabilityGrantIds: ["t3.workspace.read_file"],
      tools: [],
    });

    expect(decoded.mode).toBe("agent_loop");
    expect(decodeAgentLoopRunResult({ text: "完成", rounds: 1 }).rounds).toBe(1);
  });

  it("keeps the full dispatch prompt transient while exposing stable task identities", () => {
    const dispatch = decodeTaskDispatch({
      taskId: "task-1",
      runId: "run-1",
      projectId: "project-1",
      assigneeKind: "agent",
      assigneeId: "provider:codex",
      mode: "serial",
      promptDigest: "sha256:prompt",
      prompt: "检查工作区",
      workspaceRoot: "C:/workspace",
      dependsOnTaskIds: [],
    });
    expect(dispatch.prompt).toBe("检查工作区");
    expect(decodeTaskCancel({ taskId: "task-1", runId: "run-1", reason: "用户取消" }).reason).toBe(
      "用户取消",
    );
    expect(
      decodeTaskEvents({
        taskId: "task-1",
        runId: "run-1",
        events: [],
      }).events,
    ).toEqual([]);
    expect(decodeTaskList({ projectId: "project-1" }).projectId).toBe("project-1");
  });
});
