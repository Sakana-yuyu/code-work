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
import type { MulticaTaskMcpLease } from "./MulticaTaskMcpLease.ts";

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

  it("采用 heartbeat 宣布的 Squad、Leader 和 Task Graph 能力", async () => {
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions({
        capabilities: ["rpc-v1"],
        supportsSquad: undefined,
        supportsLeader: undefined,
        supportsTaskGraph: undefined,
        protocol: makeProtocol({
          heartbeat: () =>
            Effect.succeed(
              heartbeat({
                serverCapabilities: ["rpc-v1", "squad", "leader", "task-graph"],
              }),
            ),
        }),
      }),
    );

    await expect(Effect.runPromise(adapter.probeMultica())).resolves.toMatchObject({
      supportsSquad: true,
      supportsLeader: true,
      supportsTaskGraph: true,
    });
    await expect(Effect.runPromise(adapter.probe())).resolves.toMatchObject({
      capabilities: expect.arrayContaining(["squad", "leader", "task-graph"]),
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
          projectId: "project-1",
          parentTaskId: "task-parent",
          dependsOnTaskIds: ["task-dependency"],
          prompt: "执行任务",
          idempotencyKey: "run-1",
        }),
      ),
    ).resolves.toEqual({ runtimeTaskId: "created-task-1", status: "accepted" });
    expect(quickCreateInput).toEqual({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      projectId: "project-1",
      prompt: "执行任务",
    });
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

  it("按显式 T3 Squad 路由选择远端 Squad，允许同一 Leader 服务多个 Squad", async () => {
    const inputs: unknown[] = [];
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions({
        taskAssigneeRoutes: [
          {
            t3AgentId: "agent-1",
            t3SquadId: "squad-a",
            workspaceId: "workspace-1",
            multicaSquadId: "remote-squad-a",
          },
          {
            t3AgentId: "agent-1",
            t3SquadId: "squad-b",
            workspaceId: "workspace-1",
            multicaSquadId: "remote-squad-b",
          },
        ],
        protocol: makeProtocol({
          quickCreateTask: (input) =>
            Effect.sync(() => {
              inputs.push(input);
              return { taskId: `created-${inputs.length}` };
            }),
        }),
      }),
    );

    await Effect.runPromise(
      adapter.dispatchTask({
        taskId: "task-squad-a",
        runId: "run-squad-a",
        agentId: "agent-1",
        assigneeKind: "squad",
        assigneeId: "squad-a",
        prompt: "执行 A",
        idempotencyKey: "run-squad-a",
      }),
    );
    await Effect.runPromise(
      adapter.dispatchTask({
        taskId: "task-squad-b",
        runId: "run-squad-b",
        agentId: "agent-1",
        assigneeKind: "squad",
        assigneeId: "squad-b",
        prompt: "执行 B",
        idempotencyKey: "run-squad-b",
      }),
    );

    expect(inputs).toEqual([
      { workspaceId: "workspace-1", squadId: "remote-squad-a", prompt: "执行 A" },
      { workspaceId: "workspace-1", squadId: "remote-squad-b", prompt: "执行 B" },
    ]);
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

  it("Multica 窄协议不支持 capability handshake 时拒绝带 grant 的派发", async () => {
    const adapter = makeMulticaDaemonRuntimeAdapter(makeOptions());

    await expect(
      Effect.runPromise(
        adapter.handshakeCapabilities!({
          runtimeId,
          taskId: "task-grant",
          runId: "run-grant",
          agentId: "agent-1",
          capabilityGrantIds: ["grant-1"],
        }),
      ),
    ).resolves.toMatchObject({
      status: "unsupported",
      reasonCode: "multica_capability_handshake_unsupported",
      acceptedGrantIds: [],
    });

    await expect(
      Effect.runPromise(
        adapter.dispatchTask({
          taskId: "t3-task-grant",
          runId: "run-grant",
          agentId: "agent-1",
          prompt: "执行任务",
          idempotencyKey: "run-grant",
          capabilityGrantIds: ["grant-1"],
        }),
      ),
    ).rejects.toMatchObject({ code: "capability_handshake_unsupported" });
  });

  it("只在显式 T3 capability 扩展接受后开放带 grant 的派发", async () => {
    const handshakeCalls: string[] = [];
    const revokeCalls: string[] = [];
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions({
        capabilities: ["rpc-v1", "t3.toolbroker", "t3.capability_handshake"],
        capabilityBridge: {
          handshakeCapabilities: (input) =>
            Effect.sync(() => {
              handshakeCalls.push(input.runId);
              return {
                runtimeId,
                taskId: input.taskId,
                runId: input.runId,
                agentId: input.agentId,
                status: "accepted" as const,
                handshakeId: "handshake-1",
                acceptedGrantIds: [...input.capabilityGrantIds],
              };
            }),
          revokeCapabilityHandshake: ({ handshakeId }) =>
            Effect.sync(() => {
              revokeCalls.push(handshakeId);
            }),
        },
      }),
    );

    await expect(
      Effect.runPromise(
        adapter.handshakeCapabilities!({
          runtimeId,
          taskId: "task-grant-2",
          runId: "run-grant-2",
          agentId: "agent-1",
          capabilityGrantIds: ["grant-1"],
        }),
      ),
    ).resolves.toMatchObject({
      status: "accepted",
      handshakeId: "handshake-1",
      acceptedGrantIds: ["grant-1"],
    });
    await expect(
      Effect.runPromise(
        adapter.dispatchTask({
          taskId: "task-grant-2",
          runId: "run-grant-2",
          agentId: "agent-1",
          prompt: "执行带 T3 工具授权的任务",
          idempotencyKey: "run-grant-2",
          capabilityGrantIds: ["grant-1"],
          capabilityHandshakeId: "handshake-1",
        }),
      ),
    ).resolves.toMatchObject({ status: "accepted" });
    await expect(
      Effect.runPromise(
        adapter.dispatchTask({
          taskId: "task-grant-other",
          runId: "run-grant-other",
          agentId: "agent-1",
          prompt: "尝试借用授权",
          idempotencyKey: "run-grant-other",
          capabilityGrantIds: ["grant-1"],
          capabilityHandshakeId: "handshake-1",
        }),
      ),
    ).rejects.toMatchObject({ code: "capability_handshake_mismatch" });
    await Effect.runPromise(
      adapter.revokeCapabilityHandshake!({ handshakeId: "handshake-1" }),
    ).catch(() => undefined);

    expect(handshakeCalls).toEqual(["run-grant-2"]);
    expect(revokeCalls).toEqual(["handshake-1"]);
  });

  it("远端没有 revoke 合同时清理本地 handshake，并拒绝继续派发", async () => {
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions({
        capabilities: ["rpc-v1", "t3.toolbroker", "t3.capability_handshake"],
        capabilityBridge: {
          handshakeCapabilities: (input) =>
            Effect.succeed({
              ...input,
              status: "accepted" as const,
              handshakeId: "handshake-no-revoke",
              acceptedGrantIds: [...input.capabilityGrantIds],
            }),
        },
      }),
    );

    await expect(
      Effect.runPromise(
        adapter.handshakeCapabilities!({
          runtimeId,
          taskId: "task-no-revoke",
          runId: "run-no-revoke",
          agentId: "agent-1",
          capabilityGrantIds: ["grant-no-revoke"],
        }),
      ),
    ).resolves.toMatchObject({ status: "accepted", handshakeId: "handshake-no-revoke" });

    await expect(
      Effect.runPromise(adapter.revokeCapabilityHandshake!({ handshakeId: "handshake-no-revoke" })),
    ).rejects.toMatchObject({ code: "capability_handshake_revoke_unsupported" });
    await expect(
      Effect.runPromise(
        adapter.dispatchTask({
          taskId: "task-no-revoke",
          runId: "run-no-revoke",
          agentId: "agent-1",
          prompt: "不能借用已撤销的握手",
          idempotencyKey: "run-no-revoke",
          capabilityGrantIds: ["grant-no-revoke"],
          capabilityHandshakeId: "handshake-no-revoke",
        }),
      ),
    ).rejects.toMatchObject({ code: "capability_handshake_mismatch" });
  });

  it("没有 Lease bridge 时不伪造 task-local Lease，并在 Runtime 回收时保持空操作", async () => {
    const adapter = makeMulticaDaemonRuntimeAdapter(makeOptions());

    await expect(Effect.runPromise(adapter.getTaskMcpLease("missing-handshake"))).resolves.toBe(
      undefined,
    );
    await expect(Effect.runPromise(adapter.revokeTaskMcpLeases())).resolves.toBeUndefined();
  });

  it("claim 后在 start 前把匹配的每 Run MCP overlay 注入执行器", async () => {
    const injected: unknown[] = [];
    const executionTask: MulticaTask = { ...task, id: "remote-task-execution" };
    const lease = {
      runtimeId,
      taskId: "t3-task-execution",
      runId: "run-execution",
      agentId: "agent-1",
      capabilityGrantIds: ["grant-execution"],
      endpoint: "http://127.0.0.1:4317/mcp/composition-runtime",
      expiresAtUnixMs: 60_000,
      capabilityHandshakeId: "handshake-execution",
      rawToken: "test-only-token",
      binding: {
        runtimeId,
        taskId: "t3-task-execution",
        runId: "run-execution",
        agentId: "agent-1",
        capabilityGrantIds: ["grant-execution"],
        expiresAtUnixMs: 60_000,
        capabilityHandshakeId: "handshake-execution",
      },
      mcpConfig: {
        mcpServers: {
          "t3-composition-runtime": {
            type: "http" as const,
            url: "http://127.0.0.1:4317/mcp/composition-runtime",
            headers: { Authorization: "Bearer test-only-token" },
          },
        },
      },
    } satisfies MulticaTaskMcpLease;
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions({
        now: () => 1_000,
        capabilityBridge: {
          handshakeCapabilities: (input) =>
            Effect.succeed({
              ...input,
              status: "accepted" as const,
              handshakeId: "handshake-execution",
              acceptedGrantIds: [...input.capabilityGrantIds],
              expiresAtUnixMs: 60_000,
            }),
        },
        taskMcpLeaseBridge: {
          get: () => Effect.succeed(lease),
          revokeRuntime: () => Effect.void,
        },
        taskExecutionBridge: {
          injectTaskStart: (context) =>
            Effect.sync(() => {
              injected.push(context);
            }),
        },
        protocol: makeProtocol({
          claimTask: () => Effect.succeed(executionTask),
          quickCreateTask: () => Effect.succeed({ taskId: executionTask.id }),
        }),
      }),
    );

    await expect(
      Effect.runPromise(
        adapter.handshakeCapabilities!({
          runtimeId,
          taskId: "t3-task-execution",
          runId: "run-execution",
          agentId: "agent-1",
          capabilityGrantIds: ["grant-execution"],
        }),
      ),
    ).resolves.toMatchObject({ status: "accepted", handshakeId: "handshake-execution" });
    await Effect.runPromise(
      adapter.dispatchTask({
        taskId: "t3-task-execution",
        runId: "run-execution",
        agentId: "agent-1",
        prompt: "执行带 task-local MCP 的任务",
        idempotencyKey: "run-execution",
        capabilityGrantIds: ["grant-execution"],
        capabilityHandshakeId: "handshake-execution",
      }),
    );
    await Effect.runPromise(adapter.claimTask());
    await Effect.runPromise(adapter.startTask(executionTask.id));

    expect(injected).toHaveLength(1);
    expect(injected[0]).toMatchObject({
      taskId: "t3-task-execution",
      runId: "run-execution",
      agentId: "agent-1",
      runtimeTaskId: executionTask.id,
      mcpConfig: lease.mcpConfig,
    });
  });

  it("Lease 过期或 scope 不匹配时拒绝 start，不能调用 Multica startTask", async () => {
    let protocolStartCalls = 0;
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions({
        now: () => 10_000,
        capabilityBridge: {
          handshakeCapabilities: (input) =>
            Effect.succeed({
              ...input,
              status: "accepted" as const,
              handshakeId: "handshake-1",
              acceptedGrantIds: [...input.capabilityGrantIds],
              expiresAtUnixMs: 20_000,
            }),
        },
        taskMcpLeaseBridge: {
          get: () =>
            Effect.succeed({
              runtimeId,
              taskId: "other-task",
              runId: "other-run",
              agentId: "agent-1",
              capabilityGrantIds: ["grant-1"],
              endpoint: "http://127.0.0.1:4317/mcp/composition-runtime",
              expiresAtUnixMs: 9_999,
              capabilityHandshakeId: "handshake-1",
              rawToken: "test-only-token",
              binding: {
                runtimeId,
                taskId: "other-task",
                runId: "other-run",
                agentId: "agent-1",
                capabilityGrantIds: ["grant-1"],
                expiresAtUnixMs: 9_999,
                capabilityHandshakeId: "handshake-1",
              },
              mcpConfig: {
                mcpServers: {
                  "t3-composition-runtime": {
                    type: "http" as const,
                    url: "http://127.0.0.1:4317/mcp/composition-runtime",
                    headers: { Authorization: "Bearer test-only-token" },
                  },
                },
              },
            } satisfies MulticaTaskMcpLease),
          revokeRuntime: () => Effect.void,
        },
        taskExecutionBridge: {
          injectTaskStart: () => Effect.void,
        },
        protocol: makeProtocol({
          claimTask: () => Effect.succeed({ ...task, id: "remote-task-expired" }),
          startTask: () =>
            Effect.sync(() => {
              protocolStartCalls += 1;
            }),
          quickCreateTask: () => Effect.succeed({ taskId: "remote-task-expired" }),
        }),
      }),
    );

    await Effect.runPromise(
      adapter.handshakeCapabilities!({
        runtimeId,
        taskId: "t3-task-expired",
        runId: "run-expired",
        agentId: "agent-1",
        capabilityGrantIds: ["grant-1"],
      }),
    ).then(() => undefined);
    await Effect.runPromise(
      adapter.dispatchTask({
        taskId: "t3-task-expired",
        runId: "run-expired",
        agentId: "agent-1",
        prompt: "执行",
        idempotencyKey: "run-expired",
        capabilityGrantIds: ["grant-1"],
        capabilityHandshakeId: "handshake-1",
      }),
    );
    await Effect.runPromise(adapter.claimTask());

    await expect(Effect.runPromise(adapter.startTask("remote-task-expired"))).rejects.toMatchObject(
      {
        code: "task_mcp_lease_mismatch",
      },
    );
    expect(protocolStartCalls).toBe(0);
  });
});
