import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { EventId, ProviderDriverKind, RuntimeTaskId, ThreadId } from "@codework/contracts";

import { makeCompositionRuntimeAgentDriver } from "./CompositionRuntimeAgentDriver.ts";
import { makeInMemoryCompositionRuntimeAdapter } from "./CompositionRuntimeAdapter.ts";

describe("CompositionRuntimeAgentDriver", () => {
  it("Runtime 实时探测为离线时拒绝派发，不调用 capability handshake 或 dispatch", async () => {
    const adapter = makeInMemoryCompositionRuntimeAdapter({ runtimeId: "runtime-offline" });
    await Effect.runPromise(adapter.setProbeStatus("offline"));
    const handshakeCapabilities = adapter.handshakeCapabilities;
    if (handshakeCapabilities === undefined) {
      throw new Error("测试适配器预期支持 capability handshake。");
    }
    let handshakeCalled = false;
    let dispatched = false;
    const guardedAdapter = {
      ...adapter,
      handshakeCapabilities: (input: Parameters<typeof handshakeCapabilities>[0]) => {
        handshakeCalled = true;
        return handshakeCapabilities(input);
      },
      dispatchTask: (input: Parameters<typeof adapter.dispatchTask>[0]) => {
        dispatched = true;
        return adapter.dispatchTask(input);
      },
    };
    const driver = makeCompositionRuntimeAgentDriver({
      adapter: guardedAdapter,
      agentId: "runtime-offline:agent",
    });

    await expect(
      Effect.runPromise(
        driver.startTask({
          task: {
            taskId: "task-offline",
            projectId: "project-1",
            assigneeKind: "agent",
            assigneeId: driver.agentId,
            mode: "serial",
            status: "queued",
            promptDigest: "sha256:offline",
            dependsOnTaskIds: [],
            createdAtUnixMs: 1,
            updatedAtUnixMs: 1,
          },
          run: {
            runId: "run-offline",
            taskId: "task-offline",
            agentId: driver.agentId,
            runtimeId: driver.runtimeId,
            status: "queued",
            attempt: 1,
            capabilityGrantIds: ["grant-offline"],
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "runtime_offline" });
    expect(handshakeCalled).toBe(false);
    expect(dispatched).toBe(false);
  });

  it("目标 Agent 不在 Runtime 的实时名册中时拒绝派发", async () => {
    const adapter = makeInMemoryCompositionRuntimeAdapter({
      runtimeId: "runtime-agent-scope",
      agents: [],
    });
    let dispatched = false;
    const guardedAdapter = {
      ...adapter,
      dispatchTask: (input: Parameters<typeof adapter.dispatchTask>[0]) => {
        dispatched = true;
        return adapter.dispatchTask(input);
      },
    };
    const driver = makeCompositionRuntimeAgentDriver({
      adapter: guardedAdapter,
      agentId: "runtime-agent-scope:missing-agent",
    });

    const profile = await Effect.runPromise(driver.getProfile!());
    expect(profile).toMatchObject({
      status: "unavailable",
      reasonCode: "runtime_agent_unavailable",
    });

    await expect(
      Effect.runPromise(
        driver.startTask({
          task: {
            taskId: "task-agent-scope",
            projectId: "project-1",
            assigneeKind: "agent",
            assigneeId: driver.agentId,
            mode: "serial",
            status: "queued",
            promptDigest: "sha256:agent-scope",
            dependsOnTaskIds: [],
            createdAtUnixMs: 1,
            updatedAtUnixMs: 1,
          },
          run: {
            runId: "run-agent-scope",
            taskId: "task-agent-scope",
            agentId: driver.agentId,
            runtimeId: driver.runtimeId,
            status: "queued",
            attempt: 1,
            capabilityGrantIds: [],
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "runtime_agent_unavailable" });
    expect(dispatched).toBe(false);
  });

  it("目标 Agent 的 runtimeId 与当前 Adapter 不匹配时拒绝跨 Runtime 派发", async () => {
    const adapter = makeInMemoryCompositionRuntimeAdapter({
      runtimeId: "runtime-scope-owner",
      agents: [
        {
          agentId: "runtime-scope-owner:agent",
          runtimeId: "runtime-scope-other",
          status: "online",
          capabilities: [],
        },
      ],
    });
    let dispatched = false;
    const guardedAdapter = {
      ...adapter,
      dispatchTask: (input: Parameters<typeof adapter.dispatchTask>[0]) => {
        dispatched = true;
        return adapter.dispatchTask(input);
      },
    };
    const driver = makeCompositionRuntimeAgentDriver({
      adapter: guardedAdapter,
      agentId: "runtime-scope-owner:agent",
    });

    await expect(
      Effect.runPromise(
        driver.startTask({
          task: {
            taskId: "task-runtime-scope",
            projectId: "project-1",
            assigneeKind: "agent",
            assigneeId: driver.agentId,
            mode: "serial",
            status: "queued",
            promptDigest: "sha256:runtime-scope",
            dependsOnTaskIds: [],
            createdAtUnixMs: 1,
            updatedAtUnixMs: 1,
          },
          run: {
            runId: "run-runtime-scope",
            taskId: "task-runtime-scope",
            agentId: driver.agentId,
            runtimeId: driver.runtimeId,
            status: "queued",
            attempt: 1,
            capabilityGrantIds: [],
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "runtime_agent_scope_mismatch" });
    expect(dispatched).toBe(false);
  });

  it("把 Run 的 capability grant 传给 Runtime Adapter", async () => {
    let captured: readonly string[] = [];
    let capturedHandshakeId: string | undefined;
    const adapter = makeInMemoryCompositionRuntimeAdapter({ runtimeId: "runtime-grant" });
    const originalDispatch = adapter.dispatchTask;
    const capturingAdapter = {
      ...adapter,
      dispatchTask: (input: Parameters<typeof adapter.dispatchTask>[0]) => {
        captured = input.capabilityGrantIds ?? [];
        capturedHandshakeId = input.capabilityHandshakeId;
        return originalDispatch(input);
      },
    };
    const driver = makeCompositionRuntimeAgentDriver({
      adapter: capturingAdapter,
      agentId: "runtime-grant:agent",
    });

    await Effect.runPromise(
      driver.startTask({
        task: {
          taskId: "task-grant",
          projectId: "project-1",
          assigneeKind: "agent",
          assigneeId: driver.agentId,
          mode: "serial",
          status: "queued",
          promptDigest: "sha256:grant",
          dependsOnTaskIds: [],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
        },
        run: {
          runId: "run-grant",
          taskId: "task-grant",
          agentId: driver.agentId,
          runtimeId: driver.runtimeId,
          status: "queued",
          attempt: 1,
          capabilityGrantIds: ["grant-1"],
        },
      }),
    );

    expect(captured).toEqual(["grant-1"]);
    expect(capturedHandshakeId).toContain("handshake:runtime-grant:task-grant:run-grant");
  });

  it("Runtime 不支持 capability handshake 时拒绝带 grant 的任务，不调用 dispatch", async () => {
    const adapter = makeInMemoryCompositionRuntimeAdapter({ runtimeId: "runtime-no-handshake" });
    let dispatched = false;
    const unsupportedAdapter = {
      ...adapter,
      handshakeCapabilities: () =>
        Effect.succeed({
          runtimeId: adapter.runtimeId,
          taskId: "task-unsupported",
          runId: "run-unsupported",
          agentId: "runtime-no-handshake:agent",
          status: "unsupported" as const,
          acceptedGrantIds: [],
          reasonCode: "runtime_capability_handshake_unsupported",
        }),
      dispatchTask: (input: Parameters<typeof adapter.dispatchTask>[0]) => {
        dispatched = true;
        return adapter.dispatchTask(input);
      },
    };
    const driver = makeCompositionRuntimeAgentDriver({
      adapter: unsupportedAdapter,
      agentId: "runtime-no-handshake:agent",
    });

    await expect(
      Effect.runPromise(
        driver.startTask({
          task: {
            taskId: "task-unsupported",
            projectId: "project-1",
            assigneeKind: "agent",
            assigneeId: driver.agentId,
            mode: "serial",
            status: "queued",
            promptDigest: "sha256:unsupported",
            dependsOnTaskIds: [],
            createdAtUnixMs: 1,
            updatedAtUnixMs: 1,
          },
          run: {
            runId: "run-unsupported",
            taskId: "task-unsupported",
            agentId: driver.agentId,
            runtimeId: driver.runtimeId,
            status: "queued",
            attempt: 1,
            capabilityGrantIds: ["grant-unsupported"],
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "runtime_capability_handshake_unsupported" });
    expect(dispatched).toBe(false);
  });

  it("把 Composition Task 映射到 Runtime Task，并从事件反查 run", async () => {
    const adapter = makeInMemoryCompositionRuntimeAdapter({ runtimeId: "multica-runtime-1" });
    const driver = makeCompositionRuntimeAgentDriver({
      adapter,
      agentId: "multica-runtime-1:agent",
    });
    const started = await Effect.runPromise(
      driver.startTask({
        task: {
          taskId: "task-1",
          projectId: "project-1",
          assigneeKind: "agent",
          assigneeId: driver.agentId,
          mode: "parallel",
          status: "queued",
          promptDigest: "sha256:prompt",
          dependsOnTaskIds: [],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
        },
        run: {
          runId: "run-1",
          taskId: "task-1",
          agentId: driver.agentId,
          runtimeId: driver.runtimeId,
          status: "queued",
          attempt: 1,
          capabilityGrantIds: [],
        },
        prompt: "执行检查",
        workspaceRoot: "C:/workspace",
      }),
    );

    const runtimeTaskId = started.runtimeTaskId;
    if (runtimeTaskId === undefined) throw new Error("测试预期 Runtime Task ID 已返回。");
    expect(runtimeTaskId).toBe("multica-runtime-1:task:task-1:run-1");
    const binding = driver.resolveRuntimeEvent?.({
      eventId: EventId.make("event-1"),
      provider: ProviderDriverKind.make("multica"),
      threadId: ThreadId.make("thread-1"),
      createdAt: "2026-08-25T00:00:00.000Z",
      type: "task.progress",
      payload: {
        taskId: RuntimeTaskId.make(runtimeTaskId),
        description: "执行中",
      },
    });

    expect(binding).toEqual({
      taskId: "task-1",
      runId: "run-1",
      runtimeTaskId,
    });
  });

  it("把 Project 和 Task Graph 元数据传给 Runtime Adapter", async () => {
    let captured: Record<string, unknown> | undefined;
    const adapter = makeInMemoryCompositionRuntimeAdapter({ runtimeId: "runtime-graph" });
    const capturingAdapter = {
      ...adapter,
      dispatchTask: (input: Parameters<typeof adapter.dispatchTask>[0]) => {
        captured = input as unknown as Record<string, unknown>;
        return adapter.dispatchTask(input);
      },
    };
    const driver = makeCompositionRuntimeAgentDriver({
      adapter: capturingAdapter,
      agentId: "runtime-graph:agent",
    });

    await Effect.runPromise(
      driver.startTask({
        task: {
          taskId: "task-graph",
          projectId: "project-graph",
          parentTaskId: "task-parent",
          assigneeKind: "squad",
          assigneeId: "squad-1",
          mode: "parallel",
          status: "queued",
          promptDigest: "sha256:graph",
          dependsOnTaskIds: ["task-dependency"],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
        },
        run: {
          runId: "run-graph",
          taskId: "task-graph",
          agentId: driver.agentId,
          runtimeId: driver.runtimeId,
          status: "queued",
          attempt: 1,
          capabilityGrantIds: [],
        },
      }),
    );

    expect(captured).toMatchObject({
      projectId: "project-graph",
      parentTaskId: "task-parent",
      dependsOnTaskIds: ["task-dependency"],
      mode: "parallel",
      assigneeKind: "squad",
      assigneeId: "squad-1",
    });
  });

  it("将 Runtime Adapter 的取消结果原样转换为 Driver 状态", async () => {
    const adapter = makeInMemoryCompositionRuntimeAdapter({ runtimeId: "runtime-1" });
    const driver = makeCompositionRuntimeAgentDriver({ adapter, agentId: "runtime-1:agent" });
    await Effect.runPromise(
      driver.startTask({
        task: {
          taskId: "task-1",
          projectId: "project-1",
          assigneeKind: "agent",
          assigneeId: driver.agentId,
          mode: "serial",
          status: "queued",
          promptDigest: "sha256:prompt",
          dependsOnTaskIds: [],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
        },
        run: {
          runId: "run-1",
          taskId: "task-1",
          agentId: driver.agentId,
          runtimeId: driver.runtimeId,
          status: "running",
          attempt: 1,
          capabilityGrantIds: [],
          runtimeTaskId: "runtime-1:task:task-1:run-1",
        },
      }),
    );
    const cancelled = await Effect.runPromise(
      driver.cancelTask({
        task: {
          taskId: "task-1",
          projectId: "project-1",
          assigneeKind: "agent",
          assigneeId: driver.agentId,
          mode: "serial",
          status: "running",
          promptDigest: "sha256:prompt",
          dependsOnTaskIds: [],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
        },
        run: {
          runId: "run-1",
          taskId: "task-1",
          agentId: driver.agentId,
          runtimeId: driver.runtimeId,
          status: "running",
          attempt: 1,
          capabilityGrantIds: [],
          runtimeTaskId: "runtime-1:task:task-1:run-1",
        },
        reason: "用户取消",
      }),
    );

    expect(cancelled.status).toBe("cancelled");
  });

  it("撤销 Runtime capability handshake 后仍保留迟到事件的历史 Run 绑定", async () => {
    const adapter = makeInMemoryCompositionRuntimeAdapter({ runtimeId: "runtime-revoke" });
    const driver = makeCompositionRuntimeAgentDriver({
      adapter,
      agentId: "runtime-revoke:agent",
    });
    const task = {
      taskId: "task-revoke",
      projectId: "project-1",
      assigneeKind: "agent" as const,
      assigneeId: driver.agentId,
      mode: "serial" as const,
      status: "queued" as const,
      promptDigest: "sha256:revoke",
      dependsOnTaskIds: [],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1,
    };
    const run = {
      runId: "run-revoke",
      taskId: task.taskId,
      agentId: driver.agentId,
      runtimeId: driver.runtimeId,
      status: "queued" as const,
      attempt: 1,
      capabilityGrantIds: ["grant-revoke"],
    };

    const started = await Effect.runPromise(driver.startTask({ task, run }));
    const handshakeId = started.capabilityHandshakeId;
    if (handshakeId === undefined) throw new Error("测试预期已返回 capability handshake ID。");
    expect(handshakeId).toContain("handshake:runtime-revoke:task-revoke:run-revoke");
    await Effect.runPromise(
      driver.revokeCapabilityHandshake!({
        task,
        run: { ...run, capabilityHandshakeId: handshakeId },
      }),
    );

    expect(
      driver.resolveRuntimeEvent?.({
        eventId: EventId.make("event-after-revoke"),
        provider: ProviderDriverKind.make("multica"),
        threadId: ThreadId.make("thread-after-revoke"),
        createdAt: "2026-08-25T00:00:00.000Z",
        type: "task.progress",
        payload: {
          taskId: RuntimeTaskId.make("runtime-revoke:task:task-revoke:run-revoke"),
          description: "迟到事件",
        },
      }),
    ).toEqual({
      taskId: task.taskId,
      runId: run.runId,
      runtimeTaskId: "runtime-revoke:task:task-revoke:run-revoke",
    });

    await expect(
      Effect.runPromise(
        adapter.dispatchTask({
          taskId: task.taskId,
          runId: run.runId,
          agentId: run.agentId,
          capabilityGrantIds: run.capabilityGrantIds,
          capabilityHandshakeId: handshakeId,
          idempotencyKey: run.runId,
        }),
      ),
    ).rejects.toMatchObject({ code: "capability_handshake_mismatch" });
  });

  it("拒绝跨 Run 复用 runtimeTaskId，并保留旧 Run 的历史绑定", async () => {
    const adapter = makeInMemoryCompositionRuntimeAdapter({ runtimeId: "runtime-reused" });
    const dispatchTask = () =>
      Effect.succeed({ runtimeTaskId: "shared-runtime-task", status: "accepted" as const });
    const reusedAdapter = { ...adapter, dispatchTask };
    const driver = makeCompositionRuntimeAgentDriver({
      adapter: reusedAdapter,
      agentId: "runtime-reused:agent",
    });
    const makeInput = (taskId: string, runId: string) => ({
      task: {
        taskId,
        projectId: "project-1",
        assigneeKind: "agent" as const,
        assigneeId: driver.agentId,
        mode: "serial" as const,
        status: "queued" as const,
        promptDigest: `sha256:${taskId}`,
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1,
      },
      run: {
        runId,
        taskId,
        agentId: driver.agentId,
        runtimeId: driver.runtimeId,
        status: "queued" as const,
        attempt: 1,
        capabilityGrantIds: [],
      },
    });

    await Effect.runPromise(driver.startTask(makeInput("task-reused-1", "run-reused-1")));
    await expect(
      Effect.runPromise(driver.startTask(makeInput("task-reused-2", "run-reused-2"))),
    ).rejects.toMatchObject({ code: "runtime_task_binding_conflict" });

    expect(
      driver.resolveRuntimeEvent?.({
        eventId: EventId.make("event-ambiguous-runtime-task"),
        provider: ProviderDriverKind.make("multica"),
        threadId: ThreadId.make("runtime-reused"),
        createdAt: "2026-08-25T00:00:00.000Z",
        type: "task.progress",
        payload: { taskId: RuntimeTaskId.make("shared-runtime-task"), description: "不应绑定" },
      }),
    ).toEqual({
      taskId: "task-reused-1",
      runId: "run-reused-1",
      runtimeTaskId: "shared-runtime-task",
    });
  });

  it("拒绝 runtimeId 不属于当前 Driver 的 delegated runtime event", async () => {
    const adapter = makeInMemoryCompositionRuntimeAdapter({
      runtimeId: "runtime-delegated-source",
    });
    const driver = makeCompositionRuntimeAgentDriver({
      adapter,
      agentId: "runtime-delegated-source:agent",
    });
    const started = await Effect.runPromise(
      driver.startTask({
        task: {
          taskId: "task-delegated-source",
          projectId: "project-1",
          assigneeKind: "agent",
          assigneeId: driver.agentId,
          mode: "serial",
          status: "queued",
          promptDigest: "sha256:delegated-source",
          dependsOnTaskIds: [],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
        },
        run: {
          runId: "run-delegated-source",
          taskId: "task-delegated-source",
          agentId: driver.agentId,
          runtimeId: driver.runtimeId,
          status: "queued",
          attempt: 1,
          capabilityGrantIds: [],
        },
      }),
    );
    const runtimeTaskId = started.runtimeTaskId;
    if (runtimeTaskId === undefined) throw new Error("测试预期 Runtime Task ID 已返回。");

    expect(
      driver.resolveRuntimeEvent?.({
        eventId: EventId.make("event-delegated-wrong-runtime"),
        provider: ProviderDriverKind.make("cursor"),
        threadId: ThreadId.make("thread-delegated-source"),
        createdAt: "2026-08-27T00:00:00.000Z",
        type: "task.progress",
        payload: { taskId: RuntimeTaskId.make(runtimeTaskId), description: "不属于当前 runtime" },
        raw: {
          source: "ide.jsonrpc",
          runtimeId: "other-runtime",
          runtimeTaskId: RuntimeTaskId.make(runtimeTaskId),
          payload: {},
        },
      }),
    ).toBeUndefined();
  });

  it("拒绝 delegated executionId 与 runtimeTaskId 不一致的事件", async () => {
    const adapter = makeInMemoryCompositionRuntimeAdapter({
      runtimeId: "runtime-delegated-identity",
    });
    const driver = makeCompositionRuntimeAgentDriver({
      adapter,
      agentId: "runtime-delegated-identity:agent",
    });
    const started = await Effect.runPromise(
      driver.startTask({
        task: {
          taskId: "task-delegated-identity",
          projectId: "project-1",
          assigneeKind: "agent",
          assigneeId: driver.agentId,
          mode: "serial",
          status: "queued",
          promptDigest: "sha256:delegated-identity",
          dependsOnTaskIds: [],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
        },
        run: {
          runId: "run-delegated-identity",
          taskId: "task-delegated-identity",
          agentId: driver.agentId,
          runtimeId: driver.runtimeId,
          status: "queued",
          attempt: 1,
          capabilityGrantIds: [],
        },
      }),
    );
    const runtimeTaskId = started.runtimeTaskId;
    if (runtimeTaskId === undefined) throw new Error("测试预期 Runtime Task ID 已返回。");

    expect(
      driver.resolveRuntimeEvent?.({
        eventId: EventId.make("event-delegated-wrong-execution"),
        provider: ProviderDriverKind.make("cursor"),
        threadId: ThreadId.make("thread-delegated-identity"),
        createdAt: "2026-08-27T00:00:01.000Z",
        type: "task.progress",
        payload: { taskId: RuntimeTaskId.make(runtimeTaskId), description: "错误 execution" },
        raw: {
          source: "ide.jsonrpc",
          runtimeId: driver.runtimeId,
          runtimeTaskId: RuntimeTaskId.make(runtimeTaskId),
          payload: {},
          delegatedExecution: {
            executionId: RuntimeTaskId.make("other-execution"),
            sourceMessageId: 1,
          },
        },
      }),
    ).toBeUndefined();
  });

  it("拒绝同一 delegated execution 的旧 sourceMessageId", async () => {
    const adapter = makeInMemoryCompositionRuntimeAdapter({ runtimeId: "runtime-delegated-order" });
    const driver = makeCompositionRuntimeAgentDriver({
      adapter,
      agentId: "runtime-delegated-order:agent",
    });
    const started = await Effect.runPromise(
      driver.startTask({
        task: {
          taskId: "task-delegated-order",
          projectId: "project-1",
          assigneeKind: "agent",
          assigneeId: driver.agentId,
          mode: "serial",
          status: "queued",
          promptDigest: "sha256:delegated-order",
          dependsOnTaskIds: [],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
        },
        run: {
          runId: "run-delegated-order",
          taskId: "task-delegated-order",
          agentId: driver.agentId,
          runtimeId: driver.runtimeId,
          status: "queued",
          attempt: 1,
          capabilityGrantIds: [],
        },
      }),
    );
    const runtimeTaskId = started.runtimeTaskId;
    if (runtimeTaskId === undefined) throw new Error("测试预期 Runtime Task ID 已返回。");
    const event = (eventId: string, sourceMessageId: number) => ({
      eventId: EventId.make(eventId),
      provider: ProviderDriverKind.make("cursor"),
      threadId: ThreadId.make("thread-delegated-order"),
      createdAt: "2026-08-27T00:00:02.000Z",
      type: "task.progress" as const,
      payload: { taskId: RuntimeTaskId.make(runtimeTaskId), description: "委派事件" },
      raw: {
        source: "ide.jsonrpc" as const,
        runtimeId: driver.runtimeId,
        runtimeTaskId: RuntimeTaskId.make(runtimeTaskId),
        payload: {},
        delegatedExecution: {
          executionId: RuntimeTaskId.make(runtimeTaskId),
          sourceMessageId,
        },
      },
    });

    expect(driver.resolveRuntimeEvent?.(event("event-delegated-message-2", 2))).toEqual({
      taskId: "task-delegated-order",
      runId: "run-delegated-order",
      runtimeTaskId,
    });
    expect(driver.resolveRuntimeEvent?.(event("event-delegated-message-1", 1))).toBeUndefined();
  });

  it("接受 providerPass 变化后仍匹配 delegated execution 的事件", async () => {
    const adapter = makeInMemoryCompositionRuntimeAdapter({ runtimeId: "runtime-delegated-pass" });
    const driver = makeCompositionRuntimeAgentDriver({
      adapter,
      agentId: "runtime-delegated-pass:agent",
    });
    const started = await Effect.runPromise(
      driver.startTask({
        task: {
          taskId: "task-delegated-pass",
          projectId: "project-1",
          assigneeKind: "agent",
          assigneeId: driver.agentId,
          mode: "serial",
          status: "queued",
          promptDigest: "sha256:delegated-pass",
          dependsOnTaskIds: [],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
        },
        run: {
          runId: "run-delegated-pass",
          taskId: "task-delegated-pass",
          agentId: driver.agentId,
          runtimeId: driver.runtimeId,
          status: "queued",
          attempt: 1,
          capabilityGrantIds: [],
        },
      }),
    );
    const runtimeTaskId = started.runtimeTaskId;
    if (runtimeTaskId === undefined) throw new Error("测试预期 Runtime Task ID 已返回。");
    const event = (eventId: string, sourceMessageId: number, providerPass: number) => ({
      eventId: EventId.make(eventId),
      provider: ProviderDriverKind.make("cursor"),
      threadId: ThreadId.make("thread-delegated-pass"),
      createdAt: "2026-08-27T00:00:03.000Z",
      type: "task.progress" as const,
      payload: { taskId: RuntimeTaskId.make(runtimeTaskId), description: "委派事件" },
      raw: {
        source: "ide.jsonrpc" as const,
        runtimeId: driver.runtimeId,
        runtimeTaskId: RuntimeTaskId.make(runtimeTaskId),
        payload: {},
        delegatedExecution: {
          executionId: RuntimeTaskId.make(runtimeTaskId),
          sourceMessageId,
          providerPass,
        },
      },
    });

    expect(driver.resolveRuntimeEvent?.(event("event-delegated-pass-1", 1, 1))).toEqual({
      taskId: "task-delegated-pass",
      runId: "run-delegated-pass",
      runtimeTaskId,
    });
    expect(driver.resolveRuntimeEvent?.(event("event-delegated-pass-2", 2, 2))).toEqual({
      taskId: "task-delegated-pass",
      runId: "run-delegated-pass",
      runtimeTaskId,
    });
  });

  it("以同一 Composition Run 请求 Runtime 恢复", async () => {
    let captured: Record<string, unknown> | undefined;
    const adapter = makeInMemoryCompositionRuntimeAdapter({
      runtimeId: "runtime-resume",
      supportsResume: true,
    });
    const originalResumeTask = adapter.resumeTask;
    const capturingAdapter = {
      ...adapter,
      resumeTask: (input: Parameters<typeof adapter.resumeTask>[0]) => {
        captured = input as Record<string, unknown>;
        return originalResumeTask(input);
      },
    };
    const driver = makeCompositionRuntimeAgentDriver({
      adapter: capturingAdapter,
      agentId: "runtime-resume:agent",
    });
    const task = {
      taskId: "task-resume",
      projectId: "project-1",
      assigneeKind: "agent" as const,
      assigneeId: driver.agentId,
      mode: "serial" as const,
      status: "running" as const,
      promptDigest: "sha256:resume",
      dependsOnTaskIds: [],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1,
    };
    const run = {
      runId: "run-resume",
      taskId: task.taskId,
      agentId: driver.agentId,
      runtimeId: driver.runtimeId,
      runtimeTaskId: "runtime-resume:task:task-resume:run-resume",
      capabilityHandshakeId: "handshake:runtime-resume:task-resume:run-resume",
      status: "running" as const,
      attempt: 1,
      capabilityGrantIds: ["grant-resume"],
    };

    await Effect.runPromise(driver.startTask({ task, run }));
    const resumed = await Effect.runPromise(
      driver.resumeTask!({ task, run, reason: "连接恢复后继续执行" }),
    );

    expect(captured).toEqual({
      taskId: task.taskId,
      runId: run.runId,
      runtimeTaskId: run.runtimeTaskId,
    });
    expect(resumed.status).toBe("accepted");
  });

  it("把 Runtime 不支持恢复映射为稳定 Driver 失败", async () => {
    const adapter = makeInMemoryCompositionRuntimeAdapter({ runtimeId: "runtime-no-resume" });
    const driver = makeCompositionRuntimeAgentDriver({
      adapter,
      agentId: "runtime-no-resume:agent",
    });
    const task = {
      taskId: "task-no-resume",
      projectId: "project-1",
      assigneeKind: "agent" as const,
      assigneeId: driver.agentId,
      mode: "serial" as const,
      status: "running" as const,
      promptDigest: "sha256:no-resume",
      dependsOnTaskIds: [],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1,
    };
    const run = {
      runId: "run-no-resume",
      taskId: task.taskId,
      agentId: driver.agentId,
      runtimeId: driver.runtimeId,
      runtimeTaskId: "runtime-no-resume:task:task-no-resume:run-no-resume",
      status: "running" as const,
      attempt: 1,
      capabilityGrantIds: [],
    };

    await Effect.runPromise(driver.startTask({ task, run }));
    await expect(
      Effect.runPromise(driver.resumeTask!({ task, run, reason: "尝试恢复" })),
    ).rejects.toMatchObject({ code: "resume_not_supported" });
  });
});
