import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { EventId, ProviderDriverKind, RuntimeTaskId, ThreadId } from "@t3tools/contracts";

import { makeCompositionRuntimeAgentDriver } from "./CompositionRuntimeAgentDriver.ts";
import { makeInMemoryCompositionRuntimeAdapter } from "./CompositionRuntimeAdapter.ts";

describe("CompositionRuntimeAgentDriver", () => {
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
          runtimeTaskId: "runtime-1:task:task-1:run-1",
        },
        reason: "用户取消",
      }),
    );

    expect(cancelled.status).toBe("cancelled");
  });
});
