import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ProviderDriverKind, ThreadId } from "@t3tools/contracts";

import {
  makeMulticaDaemonRuntimeAdapter,
  type MulticaDaemonRuntimeAdapterOptions,
} from "./MulticaDaemonRuntimeAdapter.ts";
import type {
  MulticaDaemonProtocol,
  MulticaHeartbeatResponse,
  MulticaTask,
} from "./MulticaDaemonProtocol.ts";

const runtimeId = "multica:daemon-1:runtime-1";
const daemonRuntimeId = "runtime-1";

const task: MulticaTask = {
  id: "task-1",
  agentId: "agent-1",
  runtimeId: daemonRuntimeId,
  status: "dispatched",
  issueId: "issue-1",
  workspaceId: "workspace-1",
};

const heartbeat = (
  overrides: Partial<MulticaHeartbeatResponse> = {},
): MulticaHeartbeatResponse => ({
  runtimeId: daemonRuntimeId,
  status: "online",
  serverCapabilities: ["rpc-v1"],
  runtimeGone: false,
  ...overrides,
});

const makeProtocol = (overrides: Partial<MulticaDaemonProtocol> = {}): MulticaDaemonProtocol => ({
  register: () => Effect.die("测试未实现 register"),
  heartbeat: () => Effect.succeed(heartbeat()),
  claimTask: () => Effect.succeed<MulticaTask | null>(task),
  startTask: () => Effect.void,
  reportProgress: () => Effect.void,
  completeTask: () => Effect.void,
  failTask: () => Effect.void,
  acknowledgeCancellation: () => Effect.void,
  getTaskStatus: () => Effect.succeed({ status: "running" }),
  quickCreateTask: () => Effect.succeed({ taskId: "created-task-1" }),
  ...overrides,
});

const makeOptions = (
  overrides: Partial<MulticaDaemonRuntimeAdapterOptions> = {},
): MulticaDaemonRuntimeAdapterOptions => ({
  runtimeId,
  daemonId: "daemon-1",
  daemonRuntimeId,
  baseUrl: "https://multica.test",
  protocol: makeProtocol(),
  taskAssigneeRoutes: [
    {
      t3AgentId: "agent-1",
      workspaceId: "workspace-1",
      multicaAgentId: "agent-1",
    },
  ],
  agents: [
    {
      agentId: "agent-1",
      runtimeId,
      displayName: "Multica Agent",
      status: "online",
      capabilities: ["squad", "leader"],
    },
  ],
  capabilities: ["rpc-v1", "squad", "leader", "task-graph"],
  supportsResume: false,
  supportsMcp: true,
  ...overrides,
});

describe("MulticaDaemonRuntimeAdapter", () => {
  it("把 heartbeat 映射为 T3 probe/heartbeat，并保留 runtimeGone 的离线事实", async () => {
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions({
        protocol: makeProtocol({
          heartbeat: () =>
            Effect.succeed(
              heartbeat({
                status: "degraded",
                runtimeGone: true,
                serverCapabilities: ["rpc-v1", "remote-mcp"],
              }),
            ),
        }),
      }),
    );

    await expect(Effect.runPromise(adapter.probe())).resolves.toMatchObject({
      runtimeId,
      driverKind: "multica",
      status: "offline",
      supportsMcp: true,
      capabilities: expect.arrayContaining(["rpc-v1", "remote-mcp"]),
      reasonCode: "runtime_gone",
    });
    await expect(Effect.runPromise(adapter.heartbeat())).resolves.toMatchObject({
      runtimeId,
      status: "offline",
      activeTaskCount: 0,
    });
  });

  it("通过 quick-create 派发，并显式暴露 claim/终态回报", async () => {
    const calls: string[] = [];
    let quickCreateInput: unknown;
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions({
        protocol: makeProtocol({
          quickCreateTask: (input) => {
            quickCreateInput = input;
            calls.push("quick-create");
            return Effect.succeed({ taskId: "created-task-1" });
          },
          claimTask: () => {
            calls.push("claim");
            return Effect.succeed(task);
          },
          startTask: () => {
            calls.push("start");
            return Effect.void;
          },
          reportProgress: () => {
            calls.push("progress");
            return Effect.void;
          },
          completeTask: () => {
            calls.push("complete");
            return Effect.void;
          },
          acknowledgeCancellation: () => {
            calls.push("cancel-ack");
            return Effect.void;
          },
        }),
      }),
    );

    await expect(
      Effect.runPromise(
        adapter.dispatchTask({
          taskId: "t3-task-1",
          runId: "run-1",
          agentId: "agent-1",
          prompt: "执行任务",
          idempotencyKey: "run-1",
          capabilityGrantIds: ["grant-1"],
        }),
      ),
    ).resolves.toEqual({ runtimeTaskId: "created-task-1", status: "accepted" });
    expect(quickCreateInput).toEqual({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      prompt: "执行任务",
    });
    expect(quickCreateInput).not.toHaveProperty("capabilityGrantIds");
    await expect(
      Effect.runPromise(
        adapter.dispatchTask({
          taskId: "t3-task-1",
          runId: "run-1",
          agentId: "agent-1",
          prompt: "执行任务",
          idempotencyKey: "run-1",
        }),
      ),
    ).resolves.toEqual({ runtimeTaskId: "created-task-1", status: "already_running" });

    await expect(Effect.runPromise(adapter.claimTask())).resolves.toEqual(task);
    await Effect.runPromise(adapter.startTask(task.id));
    await Effect.runPromise(
      adapter.reportProgress(task.id, { summary: "处理中", step: 1, total: 2 }),
    );
    await Effect.runPromise(adapter.completeTask(task.id, { output: "完成" }));
    await Effect.runPromise(adapter.acknowledgeCancellation(task.id, {}));
    expect(calls).toEqual(["quick-create", "claim", "start", "progress", "complete", "cancel-ack"]);
  });

  it("没有显式 assignee 映射时拒绝派发，不猜测远端 UUID", async () => {
    const adapter = makeMulticaDaemonRuntimeAdapter(makeOptions({ taskAssigneeRoutes: [] }));

    await expect(
      Effect.runPromise(
        adapter.dispatchTask({
          taskId: "t3-task-2",
          runId: "run-2",
          agentId: "agent-1",
          prompt: "执行任务",
          idempotencyKey: "run-2",
        }),
      ),
    ).rejects.toMatchObject({ code: "assignee_mapping_missing" });
  });

  it("只将 task 事实帧投影为 ProviderRuntimeEvent，并对同一原始帧生成稳定 eventId", async () => {
    const frames = [
      { type: "daemon:heartbeat_ack", payload: { runtime_id: daemonRuntimeId, status: "online" } },
      {
        type: "task:progress",
        payload: { task_id: "task-1", summary: "处理中", step: 1, total: 3 },
      },
      {
        type: "task:progress",
        payload: { task_id: "task-1", summary: "处理中", step: 1, total: 3 },
      },
      { type: "task:completed", payload: { task_id: "task-1", output: "完成" } },
    ] as const;
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions({
        streamFrames: () => Stream.fromIterable(frames),
      }),
    );

    const events = await Effect.runPromise(
      adapter.streamEvents({ runtimeTaskId: "task-1" }).pipe(Stream.runCollect),
    );
    expect(Array.from(events)).toHaveLength(3);
    expect(Array.from(events).map((event) => event.type)).toEqual([
      "task.progress",
      "task.progress",
      "task.completed",
    ]);
    expect(Array.from(events)[0]?.eventId).toBe(Array.from(events)[1]?.eventId);
    expect(Array.from(events)[0]).toMatchObject({
      provider: ProviderDriverKind.make("multica"),
      threadId: ThreadId.make(runtimeId),
      payload: { taskId: "task-1", summary: "处理中" },
    });
  });

  it("没有 WebSocket transport 时 streamEvents 显式失败，不返回空流掩盖断线", async () => {
    const adapter = makeMulticaDaemonRuntimeAdapter(makeOptions());
    await expect(
      Effect.runPromise(adapter.streamEvents().pipe(Stream.runCollect)),
    ).rejects.toMatchObject({ code: "stream_unavailable" });
  });

  it("外部取消接口未支持时返回稳定错误，并保持运行任务事实", async () => {
    const adapter = makeMulticaDaemonRuntimeAdapter(makeOptions());

    await expect(
      Effect.runPromise(
        adapter.dispatchTask({
          taskId: "t3-task-cancel",
          runId: "run-cancel",
          agentId: "agent-1",
          prompt: "执行可取消任务",
          idempotencyKey: "run-cancel",
        }),
      ),
    ).resolves.toEqual({ runtimeTaskId: "created-task-1", status: "accepted" });

    await expect(
      Effect.runPromise(
        adapter.cancelTask({
          taskId: "t3-task-cancel",
          runId: "run-cancel",
          runtimeTaskId: "created-task-1",
        }),
      ),
    ).rejects.toMatchObject({ code: "cancel_not_supported" });

    await expect(Effect.runPromise(adapter.heartbeat())).resolves.toMatchObject({
      activeTaskCount: 1,
    });
  });
});
