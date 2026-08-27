import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { classifyTaskAgentKind, ProviderRuntimeEvent } from "./providerRuntime.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

describe("ProviderRuntimeEvent", () => {
  it("解码 Runtime Adapter 提供的 delegated execution 关联元数据", () => {
    const parsed = decodeRuntimeEvent({
      type: "task.progress",
      eventId: "event-delegated-execution",
      provider: "cursor",
      createdAt: "2026-08-27T00:00:00.000Z",
      threadId: "thread-delegated-execution",
      payload: {
        taskId: "runtime-task-delegated-execution",
        description: "执行中",
      },
      raw: {
        source: "ide.jsonrpc",
        runtimeId: "cursor-runtime-1",
        runtimeTaskId: "runtime-task-delegated-execution",
        delegatedExecution: {
          executionId: "runtime-task-delegated-execution",
          sourceMessageId: 2,
          providerPass: 1,
        },
        payload: {},
      },
    });

    expect(parsed.raw?.delegatedExecution).toEqual({
      executionId: "runtime-task-delegated-execution",
      sourceMessageId: 2,
      providerPass: 1,
    });
  });

  it("拒绝非法 delegated execution 关联元数据", () => {
    const baseEvent = {
      type: "task.progress",
      eventId: "event-invalid-delegated-execution",
      provider: "cursor",
      createdAt: "2026-08-27T00:00:01.000Z",
      threadId: "thread-invalid-delegated-execution",
      payload: {
        taskId: "runtime-task-invalid-delegated-execution",
        description: "执行中",
      },
      raw: {
        source: "ide.jsonrpc",
        runtimeId: "cursor-runtime-1",
        runtimeTaskId: "runtime-task-invalid-delegated-execution",
        payload: {},
      },
    };

    expect(() =>
      decodeRuntimeEvent({
        ...baseEvent,
        raw: {
          ...baseEvent.raw,
          delegatedExecution: { executionId: "   " },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeRuntimeEvent({
        ...baseEvent,
        raw: {
          ...baseEvent.raw,
          delegatedExecution: {
            executionId: "runtime-task-invalid-delegated-execution",
            sourceMessageId: -1,
          },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeRuntimeEvent({
        ...baseEvent,
        raw: {
          ...baseEvent.raw,
          delegatedExecution: {
            executionId: "runtime-task-invalid-delegated-execution",
            providerPass: -1,
          },
        },
      }),
    ).toThrow();
  });

  it("兼容不带 delegated execution 元数据的既有 Runtime raw event", () => {
    const parsed = decodeRuntimeEvent({
      type: "task.progress",
      eventId: "event-legacy-runtime-raw",
      provider: "multica",
      createdAt: "2026-08-27T00:00:02.000Z",
      threadId: "thread-legacy-runtime-raw",
      payload: {
        taskId: "runtime-task-legacy-raw",
        description: "执行中",
      },
      raw: {
        source: "multica.task-event",
        runtimeId: "multica-runtime-1",
        runtimeTaskId: "runtime-task-legacy-raw",
        payload: {},
      },
    });

    expect(parsed.raw?.delegatedExecution).toBeUndefined();
  });

  it("accepts fork-provided driver kinds as branded slugs", () => {
    const parsed = decodeRuntimeEvent({
      type: "session.started",
      eventId: "event-ollama-session",
      provider: "ollama",
      providerInstanceId: "ollama_local",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      payload: {
        message: "started",
      },
    });

    expect(parsed.provider).toBe("ollama");
    expect(parsed.providerInstanceId).toBe("ollama_local");
  });

  it("decodes turn.plan.updated for plan rendering", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.plan.updated",
      eventId: "event-1",
      provider: "claudeAgent",
      sessionId: "runtime-session-1",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        explanation: "Implement schema updates",
        plan: [
          { step: "Define event union", status: "completed" },
          { step: "Wire adapter mapping", status: "inProgress" },
        ],
      },
    });

    expect(parsed.type).toBe("turn.plan.updated");
    if (parsed.type !== "turn.plan.updated") {
      throw new Error("expected turn.plan.updated");
    }
    expect(parsed.payload.plan).toHaveLength(2);
    expect(parsed.payload.plan[1]?.status).toBe("inProgress");
  });

  it("decodes proposed-plan completion events", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: "event-proposed-plan-1",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        planMarkdown: "# Ship it",
      },
    });

    expect(parsed.type).toBe("turn.proposed.completed");
    if (parsed.type !== "turn.proposed.completed") {
      throw new Error("expected turn.proposed.completed");
    }
    expect(parsed.payload.planMarkdown).toBe("# Ship it");
  });

  it("decodes user-input.requested with structured questions", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.requested",
      eventId: "event-2",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow edits in workspace only",
              },
              {
                label: "danger-full-access",
                description: "Allow unrestricted access",
              },
            ],
          },
        ],
      },
    });

    expect(parsed.type).toBe("user-input.requested");
    if (parsed.type !== "user-input.requested") {
      throw new Error("expected user-input.requested");
    }
    expect(parsed.payload.questions[0]?.id).toBe("sandbox_mode");
    expect(parsed.payload.questions[0]?.options).toHaveLength(2);
  });

  it("decodes user-input.resolved with answer map", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.resolved",
      eventId: "event-3",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:02.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    expect(parsed.type).toBe("user-input.resolved");
    if (parsed.type !== "user-input.resolved") {
      throw new Error("expected user-input.resolved");
    }
    expect(parsed.payload.answers.sandbox_mode).toBe("workspace-write");
  });

  it("rejects legacy message.delta type", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "message.delta",
        eventId: "event-4",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        payload: { delta: "legacy" },
      }),
    ).toThrow();
  });

  it("rejects empty branded canonical ids", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "runtime.error",
        eventId: "event-5",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        threadId: "   ",
        payload: { message: "boom" },
      }),
    ).toThrow();
  });

  it("decodes normalized thread token usage snapshots", () => {
    const parsed = decodeRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: "event-token-usage-1",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:04.000Z",
      threadId: "thread-1",
      payload: {
        usage: {
          usedTokens: 31251,
          maxTokens: 200000,
          toolUses: 25,
          durationMs: 43567,
        },
      },
    });

    expect(parsed.type).toBe("thread.token-usage.updated");
    if (parsed.type !== "thread.token-usage.updated") {
      throw new Error("expected thread.token-usage.updated");
    }
    expect(parsed.payload.usage.maxTokens).toBe(200000);
    expect(parsed.payload.usage.usedTokens).toBe(31251);
  });
});

describe("classifyTaskAgentKind", () => {
  it("classifies agent-flavored, watch-loop, and inert types", () => {
    expect(classifyTaskAgentKind({ taskType: "local_agent" })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: "local_workflow" })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: undefined })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: "brand_new_agent_type" })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: "local_bash" })).toBe("background");
    expect(classifyTaskAgentKind({ taskType: "monitor" })).toBe("background");
    expect(classifyTaskAgentKind({ taskType: "plan" })).toBe("background");
  });

  it("agent-owned tasks are background unless themselves agent-flavored", () => {
    expect(classifyTaskAgentKind({ taskType: "local_bash", agentId: "owner" })).toBe("background");
    expect(classifyTaskAgentKind({ taskType: undefined, agentId: "owner" })).toBe("background");
    // Nested agent: outlives its parent, stays in the roster.
    expect(classifyTaskAgentKind({ taskType: "local_agent", agentId: "owner" })).toBe("agent");
  });
});
