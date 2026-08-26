import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { EventId, ProviderDriverKind, RuntimeTaskId, ThreadId } from "@t3tools/contracts";

import {
  CompositionRuntimeAdapterFailure,
  makeInMemoryCompositionRuntimeAdapter,
} from "./CompositionRuntimeAdapter.ts";

const taskInput = {
  taskId: "task-1",
  runId: "run-1",
  agentId: "multica:agent",
  promptDigest: "sha256:prompt",
  idempotencyKey: "run-1",
};

describe("CompositionRuntimeAdapter", () => {
  it("提供探测、Agent 列表和心跳，不把离线状态伪装成在线", async () => {
    const adapter = makeInMemoryCompositionRuntimeAdapter({
      runtimeId: "multica:daemon-1:codex",
      version: "0.4.0",
      capabilities: ["rpc-v1", "local-worktree-v1"],
      supportsResume: true,
      supportsMcp: true,
    });

    await expect(Effect.runPromise(adapter.probe())).resolves.toMatchObject({
      status: "online",
      supportsResume: true,
      capabilities: ["rpc-v1", "local-worktree-v1"],
    });
    await expect(Effect.runPromise(adapter.listAgents())).resolves.toMatchObject([
      { agentId: "multica:daemon-1:codex:agent", status: "online" },
    ]);
    await Effect.runPromise(adapter.setProbeStatus("offline"));
    await expect(Effect.runPromise(adapter.heartbeat())).resolves.toMatchObject({
      runtimeId: "multica:daemon-1:codex",
      status: "offline",
      activeTaskCount: 0,
    });
    await expect(Effect.runPromise(adapter.dispatchTask(taskInput))).rejects.toMatchObject({
      code: "runtime_offline",
    });
  });

  it("按 task/run 幂等派发，并返回稳定 runtimeTaskId", async () => {
    const adapter = makeInMemoryCompositionRuntimeAdapter({ runtimeId: "runtime-1" });

    const first = await Effect.runPromise(adapter.dispatchTask(taskInput));
    const duplicate = await Effect.runPromise(adapter.dispatchTask(taskInput));

    expect(first).toEqual({ runtimeTaskId: "runtime-1:task:task-1:run-1", status: "accepted" });
    expect(duplicate).toEqual({
      runtimeTaskId: first.runtimeTaskId,
      status: "already_running",
    });
    await expect(Effect.runPromise(adapter.heartbeat())).resolves.toMatchObject({
      activeTaskCount: 1,
    });
  });

  it("先完成 capability handshake，再允许带 grant 的派发", async () => {
    const adapter = makeInMemoryCompositionRuntimeAdapter({ runtimeId: "runtime-grant" });
    const request = {
      runtimeId: adapter.runtimeId,
      taskId: "task-grant",
      runId: "run-grant",
      agentId: "runtime-grant:agent",
      capabilityGrantIds: ["grant-1"],
    } as const;

    await expect(
      Effect.runPromise(
        adapter.dispatchTask({
          ...taskInput,
          ...request,
          idempotencyKey: request.runId,
        }),
      ),
    ).rejects.toMatchObject({ code: "capability_handshake_required" });

    const handshake = await Effect.runPromise(adapter.handshakeCapabilities!(request));
    expect(handshake).toMatchObject({ status: "accepted", acceptedGrantIds: ["grant-1"] });

    await expect(
      Effect.runPromise(
        adapter.dispatchTask({
          ...taskInput,
          ...request,
          idempotencyKey: request.runId,
          ...(handshake.handshakeId === undefined
            ? {}
            : { capabilityHandshakeId: handshake.handshakeId }),
        }),
      ),
    ).resolves.toMatchObject({ status: "accepted" });
  });

  it("区分取消终态和恢复能力，并拒绝未知 Runtime Task", async () => {
    const adapter = makeInMemoryCompositionRuntimeAdapter({
      runtimeId: "runtime-1",
      supportsResume: true,
    });
    const started = await Effect.runPromise(adapter.dispatchTask(taskInput));

    await expect(
      Effect.runPromise(
        adapter.cancelTask({
          taskId: taskInput.taskId,
          runId: taskInput.runId,
          runtimeTaskId: started.runtimeTaskId,
        }),
      ),
    ).resolves.toMatchObject({ status: "cancelled" });
    await expect(
      Effect.runPromise(adapter.cancelTask({ taskId: taskInput.taskId, runId: taskInput.runId })),
    ).resolves.toMatchObject({ status: "already_terminal" });
    await expect(
      Effect.runPromise(adapter.resumeTask({ taskId: taskInput.taskId, runId: taskInput.runId })),
    ).resolves.toMatchObject({ status: "already_terminal" });
    await expect(
      Effect.runPromise(adapter.cancelTask({ taskId: "missing", runId: "run-missing" })),
    ).rejects.toBeInstanceOf(CompositionRuntimeAdapterFailure);
  });

  it("事件流支持 thread/runtimeTaskId 过滤，并保留重复事件供上层去重", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = makeInMemoryCompositionRuntimeAdapter({ runtimeId: "runtime-1" });
        const started = yield* adapter.dispatchTask(taskInput);
        const event = {
          eventId: EventId.make("runtime-event-1"),
          provider: ProviderDriverKind.make("codex"),
          threadId: ThreadId.make("thread-1"),
          createdAt: "2026-08-25T00:00:00.000Z",
          type: "task.progress",
          payload: {
            taskId: RuntimeTaskId.make(started.runtimeTaskId),
            description: "处理中",
          },
        } as const;
        const fiber = yield* adapter
          .streamEvents({
            threadId: ThreadId.make("thread-1"),
            runtimeTaskId: started.runtimeTaskId,
          })
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

        yield* Effect.yieldNow;
        yield* adapter.emitEvent(event);
        yield* adapter.emitEvent(event);
        const events = yield* Fiber.join(fiber);

        expect(Array.from(events)).toHaveLength(2);
        expect(Array.from(events).map((entry) => entry.eventId)).toEqual([
          "runtime-event-1",
          "runtime-event-1",
        ]);
      }),
    );
  });
});
