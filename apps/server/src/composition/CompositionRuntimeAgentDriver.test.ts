import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { EventId, ProviderDriverKind, RuntimeTaskId, ThreadId } from "@t3tools/contracts";

import { makeCompositionRuntimeAgentDriver } from "./CompositionRuntimeAgentDriver.ts";
import { makeInMemoryCompositionRuntimeAdapter } from "./CompositionRuntimeAdapter.ts";

describe("CompositionRuntimeAgentDriver", () => {
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

  it("返回并撤销 Runtime capability handshake", async () => {
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
});
