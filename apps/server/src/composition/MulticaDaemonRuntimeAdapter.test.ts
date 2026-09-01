import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ProviderDriverKind, ThreadId } from "@codework/contracts";

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
      codeworkAgentId: "agent-1",
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
  quickCreateIntentStore: makeQuickCreateIntentStore(),
  ...overrides,
});

const makeQuickCreateIntentStore = () => {
  type Intent = {
    readonly runId: string;
    readonly taskId: string;
    readonly runtimeId: string;
    readonly idempotencyKey: string;
    readonly state: "prepared" | "sending" | "accepted";
    readonly remoteTaskId?: string;
    readonly createdAtUnixMs: number;
    readonly updatedAtUnixMs: number;
  };
  const intents = new Map<string, Intent>();

  return {
    seed: (intent: Intent) => intents.set(intent.runId, intent),
    createMulticaQuickCreateIntent: (intent: Omit<Intent, "state">) =>
      Effect.sync(() => {
        if (
          intents.has(intent.runId) ||
          [...intents.values()].some(
            (existing) =>
              existing.runtimeId === intent.runtimeId &&
              existing.idempotencyKey === intent.idempotencyKey,
          )
        ) {
          return false;
        }
        intents.set(intent.runId, { ...intent, state: "prepared" });
        return true;
      }),
    getMulticaQuickCreateIntent: (runId: string) =>
      Effect.sync(() => {
        const intent = intents.get(runId);
        return intent === undefined ? Option.none<Intent>() : Option.some(intent);
      }),
    getMulticaQuickCreateIntentByIdempotencyKey: (
      intentRuntimeId: string,
      idempotencyKey: string,
    ) =>
      Effect.sync(() => {
        const intent = [...intents.values()].find(
          (candidate) =>
            candidate.runtimeId === intentRuntimeId && candidate.idempotencyKey === idempotencyKey,
        );
        return intent === undefined ? Option.none<Intent>() : Option.some(intent);
      }),
    claimMulticaQuickCreateIntentForSend: (input: {
      readonly runId: string;
      readonly runtimeId: string;
      readonly updatedAtUnixMs: number;
    }) =>
      Effect.sync(() => {
        const existing = intents.get(input.runId);
        if (
          existing === undefined ||
          existing.runtimeId !== input.runtimeId ||
          existing.state !== "prepared"
        ) {
          return Option.none<Intent>();
        }
        const claimed: Intent = {
          ...existing,
          state: "sending",
          updatedAtUnixMs: input.updatedAtUnixMs,
        };
        intents.set(input.runId, claimed);
        return Option.some(claimed);
      }),
    acceptMulticaQuickCreateIntent: (input: {
      readonly runId: string;
      readonly runtimeId: string;
      readonly remoteTaskId: string;
      readonly updatedAtUnixMs: number;
    }) =>
      Effect.sync(() => {
        const existing = intents.get(input.runId);
        if (
          existing === undefined ||
          existing.runtimeId !== input.runtimeId ||
          existing.state !== "sending"
        ) {
          return Option.none<Intent>();
        }
        const accepted: Intent = {
          ...existing,
          state: "accepted",
          remoteTaskId: input.remoteTaskId,
          updatedAtUnixMs: input.updatedAtUnixMs,
        };
        intents.set(input.runId, accepted);
        return Option.some(accepted);
      }),
  };
};

describe("MulticaDaemonRuntimeAdapter", () => {
  it("把 heartbeat 映射为 Code Work probe/heartbeat，并保留 runtimeGone 的离线事实", async () => {
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
      idempotencyKey: "run-1",
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

  it("重建 Adapter 后遇到已发送但未确认的 quick-create intent 时拒绝重放 POST", async () => {
    const intentStore = makeQuickCreateIntentStore();
    intentStore.seed({
      runId: "run-response-lost",
      taskId: "task-response-lost",
      runtimeId,
      idempotencyKey: "run-response-lost",
      state: "sending",
      createdAtUnixMs: 1_000,
      updatedAtUnixMs: 1_001,
    });
    let quickCreateCalls = 0;
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions({
        protocol: makeProtocol({
          quickCreateTask: () =>
            Effect.sync(() => {
              quickCreateCalls += 1;
              return { taskId: "unexpected-duplicate-task" };
            }),
        }),
        quickCreateIntentStore: intentStore,
      }),
    );

    await expect(
      Effect.runPromise(
        adapter.dispatchTask({
          taskId: "task-response-lost",
          runId: "run-response-lost",
          agentId: "agent-1",
          prompt: "响应丢失后不得重复创建",
          idempotencyKey: "run-response-lost",
        }),
      ),
    ).rejects.toMatchObject({ code: "quick_create_recovery_required" });
    expect(quickCreateCalls).toBe(0);
  });

  it("重建 Adapter 后复用已绑定远端 taskId 的 quick-create intent", async () => {
    const intentStore = makeQuickCreateIntentStore();
    intentStore.seed({
      runId: "run-accepted",
      taskId: "task-accepted",
      runtimeId,
      idempotencyKey: "run-accepted",
      state: "accepted",
      remoteTaskId: "multica-task-accepted",
      createdAtUnixMs: 1_000,
      updatedAtUnixMs: 1_001,
    });
    let quickCreateCalls = 0;
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions({
        protocol: makeProtocol({
          quickCreateTask: () =>
            Effect.sync(() => {
              quickCreateCalls += 1;
              return { taskId: "unexpected-duplicate-task" };
            }),
        }),
        quickCreateIntentStore: intentStore,
      }),
    );

    await expect(
      Effect.runPromise(
        adapter.dispatchTask({
          taskId: "task-accepted",
          runId: "run-accepted",
          agentId: "agent-1",
          prompt: "已确认的远端任务不得重复创建",
          idempotencyKey: "run-accepted",
        }),
      ),
    ).resolves.toEqual({
      runtimeTaskId: "multica-task-accepted",
      status: "already_running",
    });
    expect(quickCreateCalls).toBe(0);
  });

  it("同一 Runtime 下不同 Run 复用幂等键时拒绝创建第二个远端任务", async () => {
    const intentStore = makeQuickCreateIntentStore();
    intentStore.seed({
      runId: "run-idempotency-owner",
      taskId: "task-idempotency-owner",
      runtimeId,
      idempotencyKey: "shared-idempotency-key",
      state: "accepted",
      remoteTaskId: "multica-task-owner",
      createdAtUnixMs: 1_000,
      updatedAtUnixMs: 1_001,
    });
    let quickCreateCalls = 0;
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions({
        protocol: makeProtocol({
          quickCreateTask: () =>
            Effect.sync(() => {
              quickCreateCalls += 1;
              return { taskId: "unexpected-duplicate-task" };
            }),
        }),
        quickCreateIntentStore: intentStore,
      }),
    );

    await expect(
      Effect.runPromise(
        adapter.dispatchTask({
          taskId: "task-idempotency-contender",
          runId: "run-idempotency-contender",
          agentId: "agent-1",
          prompt: "不得复用其他 Run 的幂等键",
          idempotencyKey: "shared-idempotency-key",
        }),
      ),
    ).rejects.toMatchObject({ code: "quick_create_idempotency_conflict" });
    expect(quickCreateCalls).toBe(0);
  });

  it("不同 Runtime 可以独立使用相同 quick-create 幂等键", async () => {
    const intentStore = makeQuickCreateIntentStore();
    intentStore.seed({
      runId: "run-runtime-a",
      taskId: "task-runtime-a",
      runtimeId,
      idempotencyKey: "runtime-scoped-key",
      state: "accepted",
      remoteTaskId: "multica-task-runtime-a",
      createdAtUnixMs: 1_000,
      updatedAtUnixMs: 1_001,
    });
    const otherRuntimeId = "multica:daemon-2:runtime-2";
    let quickCreateCalls = 0;
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions({
        runtimeId: otherRuntimeId,
        daemonId: "daemon-2",
        daemonRuntimeId: "runtime-2",
        agents: [
          {
            agentId: "agent-1",
            runtimeId: otherRuntimeId,
            displayName: "Multica Agent 2",
            status: "online",
            capabilities: ["squad", "leader"],
          },
        ],
        protocol: makeProtocol({
          quickCreateTask: () =>
            Effect.sync(() => {
              quickCreateCalls += 1;
              return { taskId: "multica-task-runtime-b" };
            }),
        }),
        quickCreateIntentStore: intentStore,
      }),
    );

    await expect(
      Effect.runPromise(
        adapter.dispatchTask({
          taskId: "task-runtime-b",
          runId: "run-runtime-b",
          agentId: "agent-1",
          prompt: "不同 Runtime 独立派发",
          idempotencyKey: "runtime-scoped-key",
        }),
      ),
    ).resolves.toEqual({ runtimeTaskId: "multica-task-runtime-b", status: "accepted" });
    expect(quickCreateCalls).toBe(1);
  });

  it("并发的不同 Run 争用同一 Runtime 幂等键时只发送一次 POST", async () => {
    const intentStore = makeQuickCreateIntentStore();
    let releaseFirstRequest: () => void = () => undefined;
    let signalFirstRequest: () => void = () => undefined;
    const firstRequestStarted = new Promise<void>((resolve) => {
      signalFirstRequest = resolve;
    });
    const firstRequestRelease = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    let quickCreateCalls = 0;
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions({
        protocol: makeProtocol({
          quickCreateTask: () =>
            Effect.promise(async () => {
              quickCreateCalls += 1;
              signalFirstRequest();
              await firstRequestRelease;
              return { taskId: "multica-task-concurrent-owner" };
            }),
        }),
        quickCreateIntentStore: intentStore,
      }),
    );
    const firstDispatch = Effect.runPromise(
      adapter.dispatchTask({
        taskId: "task-concurrent-owner",
        runId: "run-concurrent-owner",
        agentId: "agent-1",
        prompt: "第一个并发请求",
        idempotencyKey: "concurrent-shared-key",
      }),
    );

    await firstRequestStarted;
    try {
      await expect(
        Effect.runPromise(
          adapter.dispatchTask({
            taskId: "task-concurrent-contender",
            runId: "run-concurrent-contender",
            agentId: "agent-1",
            prompt: "第二个并发请求",
            idempotencyKey: "concurrent-shared-key",
          }),
        ),
      ).rejects.toMatchObject({ code: "quick_create_idempotency_conflict" });
    } finally {
      releaseFirstRequest();
    }
    await expect(firstDispatch).resolves.toEqual({
      runtimeTaskId: "multica-task-concurrent-owner",
      status: "accepted",
    });
    expect(quickCreateCalls).toBe(1);
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

  it("按显式 Code Work Squad 路由选择远端 Squad，允许同一 Leader 服务多个 Squad", async () => {
    const inputs: unknown[] = [];
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions({
        taskAssigneeRoutes: [
          {
            codeworkAgentId: "agent-1",
            codeworkSquadId: "squad-a",
            workspaceId: "workspace-1",
            multicaSquadId: "remote-squad-a",
          },
          {
            codeworkAgentId: "agent-1",
            codeworkSquadId: "squad-b",
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
      {
        workspaceId: "workspace-1",
        squadId: "remote-squad-a",
        idempotencyKey: "run-squad-a",
        prompt: "执行 A",
      },
      {
        workspaceId: "workspace-1",
        squadId: "remote-squad-b",
        idempotencyKey: "run-squad-b",
        prompt: "执行 B",
      },
    ]);
  });

  it("只将 task 事实帧投影为 ProviderRuntimeEvent，并优先使用顶层 event_id", async () => {
    const frames = [
      { type: "daemon:heartbeat_ack", payload: { runtime_id: daemonRuntimeId, status: "online" } },
      {
        type: "task:progress",
        payload: { task_id: "task-1", summary: "处理中", step: 1, total: 3 },
        eventId: "relay-event-1",
      },
      {
        type: "task:progress",
        payload: { task_id: "task-1", summary: "处理中", step: 1, total: 3 },
        eventId: "relay-event-2",
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
    expect(Array.from(events)[0]?.eventId).not.toBe(Array.from(events)[1]?.eventId);
    expect(Array.from(events)[0]?.eventId).toBe("relay-event-1");
    expect(Array.from(events)[1]?.eventId).toBe("relay-event-2");
    expect(Array.from(events)[0]).toMatchObject({
      provider: ProviderDriverKind.make("multica"),
      threadId: ThreadId.make(runtimeId),
      payload: { taskId: "task-1", summary: "处理中" },
    });
  });

  it("同时消费独立的 daemon control stream，并把 task_available 交给唤醒处理器而不是投影为任务事件", async () => {
    const controlTypes: string[] = [];
    const adapter = makeMulticaDaemonRuntimeAdapter({
      ...makeOptions({
        streamFrames: () =>
          Stream.fromIterable([
            { type: "task:progress", payload: { task_id: "task-1", summary: "处理中" } },
          ]),
      }),
      controlFrames: () =>
        Stream.fromIterable([
          { type: "daemon:heartbeat_ack", payload: { runtime_id: daemonRuntimeId } },
          {
            type: "daemon:task_available",
            payload: { runtime_id: daemonRuntimeId, task_id: "task-1" },
          },
          {
            type: "daemon:pending_work",
            payload: { runtime_id: daemonRuntimeId, kind: "model_list" },
          },
        ]),
      onControlFrame: (frame: { readonly type: string }) =>
        Effect.sync(() => {
          controlTypes.push(frame.type);
        }),
    } as MulticaDaemonRuntimeAdapterOptions & {
      readonly controlFrames: NonNullable<MulticaDaemonRuntimeAdapterOptions["streamFrames"]>;
      readonly onControlFrame: (frame: { readonly type: string }) => Effect.Effect<void>;
    });

    const events = await Effect.runPromise(
      adapter.streamEvents({ runtimeTaskId: "task-1" }).pipe(Stream.runCollect),
    );

    expect(Array.from(events).map((event) => event.type)).toEqual(["task.progress"]);
    expect(controlTypes).toEqual(["daemon:task_available", "daemon:pending_work"]);
  });

  it("没有自定义处理器时，task_available 触发一次权威 claim 和 start", async () => {
    const calls: string[] = [];
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions({
        streamFrames: () => Stream.empty,
        controlFrames: () =>
          Stream.fromIterable([
            {
              type: "daemon:task_available",
              payload: { runtime_id: daemonRuntimeId, task_id: "task-1" },
            },
          ]),
        protocol: makeProtocol({
          claimTask: () =>
            Effect.sync(() => {
              calls.push("claim");
              return task;
            }),
          startTask: (runtimeTaskId) =>
            Effect.sync(() => {
              calls.push("start:" + runtimeTaskId);
            }),
        }),
      }),
    );

    await Effect.runPromise(adapter.streamEvents().pipe(Stream.runCollect));

    expect(calls).toEqual(["claim", "start:task-1"]);
  });

  it("一次唤醒会有界地 drain 多个不同任务，遇到重复任务后停止", async () => {
    const calls: string[] = [];
    const taskTwo = { ...task, id: "task-2" };
    const claimedTasks: Array<MulticaTask | null> = [task, taskTwo, taskTwo];
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions({
        streamFrames: () => Stream.empty,
        controlFrames: () =>
          Stream.fromIterable([
            {
              type: "daemon:task_available",
              payload: { runtime_id: daemonRuntimeId },
            },
          ]),
        protocol: makeProtocol({
          claimTask: () =>
            Effect.sync(() => {
              calls.push("claim");
              return claimedTasks.shift() ?? null;
            }),
          startTask: (runtimeTaskId) =>
            Effect.sync(() => {
              calls.push("start:" + runtimeTaskId);
            }),
        }),
      }),
    );

    await Effect.runPromise(adapter.streamEvents().pipe(Stream.runCollect));

    expect(calls).toEqual(["claim", "start:task-1", "claim", "start:task-2", "claim"]);
  });

  it("重复 task_available hint 不会重复 claim 或 start 已激活的任务", async () => {
    const calls: string[] = [];
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions({
        streamFrames: () => Stream.empty,
        controlFrames: () =>
          Stream.fromIterable([
            {
              type: "daemon:task_available",
              payload: { runtime_id: daemonRuntimeId, task_id: "task-1" },
            },
            {
              type: "daemon:task_available",
              payload: { runtime_id: daemonRuntimeId, task_id: "task-1" },
            },
          ]),
        protocol: makeProtocol({
          claimTask: () =>
            Effect.sync(() => {
              calls.push("claim");
              return task;
            }),
          startTask: (runtimeTaskId) =>
            Effect.sync(() => {
              calls.push("start:" + runtimeTaskId);
            }),
        }),
      }),
    );

    await Effect.runPromise(adapter.streamEvents().pipe(Stream.runCollect));

    expect(calls).toEqual(["claim", "start:task-1"]);
  });

  it("start 失败后清理 hint 状态，后续 hint 可以再次 claim/start", async () => {
    const calls: string[] = [];
    let startAttempts = 0;
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions({
        streamFrames: () => Stream.empty,
        controlFrames: () =>
          Stream.fromIterable([
            {
              type: "daemon:task_available",
              payload: { runtime_id: daemonRuntimeId, task_id: "task-1" },
            },
            {
              type: "daemon:task_available",
              payload: { runtime_id: daemonRuntimeId, task_id: "task-1" },
            },
          ]),
        protocol: makeProtocol({
          claimTask: () =>
            Effect.sync(() => {
              calls.push("claim");
              return task;
            }),
          startTask: (runtimeTaskId) =>
            Effect.sync(() => {
              startAttempts += 1;
              calls.push("start:" + runtimeTaskId);
              if (startAttempts === 1) throw new Error("start failed");
            }),
        }),
      }),
    );

    await Effect.runPromise(adapter.streamEvents().pipe(Stream.runCollect));

    expect(calls).toEqual(["claim", "start:task-1", "claim", "start:task-1"]);
  });

  it("pending_work 只作为唤醒提示，claim 为空时不启动任务", async () => {
    const calls: string[] = [];
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions({
        streamFrames: () => Stream.empty,
        controlFrames: () =>
          Stream.fromIterable([
            {
              type: "daemon:pending_work",
              payload: { runtime_id: daemonRuntimeId, kind: "model_list" },
            },
          ]),
        protocol: makeProtocol({
          claimTask: () =>
            Effect.sync(() => {
              calls.push("claim");
              return null;
            }),
          startTask: () =>
            Effect.sync(() => {
              calls.push("start");
            }),
        }),
      }),
    );

    await Effect.runPromise(adapter.streamEvents().pipe(Stream.runCollect));

    expect(calls).toEqual(["claim"]);
  });

  it("使用规范化 runtimeTaskId 清理 start 和终态回报状态", async () => {
    const calls: string[] = [];
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions({
        streamFrames: () => Stream.empty,
        protocol: makeProtocol({
          startTask: (runtimeTaskId) =>
            Effect.sync(() => {
              calls.push(`start:${runtimeTaskId}`);
            }),
          completeTask: (runtimeTaskId) =>
            Effect.sync(() => {
              calls.push(`complete:${runtimeTaskId}`);
            }),
        }),
      }),
    );

    await Effect.runPromise(adapter.startTask(" task-1 "));
    await expect(Effect.runPromise(adapter.heartbeat())).resolves.toMatchObject({
      activeTaskCount: 1,
    });

    await Effect.runPromise(adapter.completeTask(" task-1 ", { output: "完成" }));
    await expect(Effect.runPromise(adapter.heartbeat())).resolves.toMatchObject({
      activeTaskCount: 0,
    });
    expect(calls).toEqual(["start:task-1", "complete:task-1"]);
  });

  it("保留 Multica 任务事件的进度、消息、终态字段和原始帧来源", async () => {
    const adapter = makeMulticaDaemonRuntimeAdapter(
      makeOptions({
        streamFrames: () =>
          Stream.fromIterable([
            {
              type: "task:progress",
              payload: { task_id: "task-1", summary: "处理中", step: 2, total: 5 },
            },
            {
              type: "task:message",
              payload: {
                task_id: "task-1",
                issue_id: "issue-1",
                seq: 7,
                type: "tool_result",
                tool: "terminal",
                content: "命令已完成",
                output: "ok",
                created_at: "2026-08-26T04:00:00.000Z",
              },
            },
            {
              type: "task:failed",
              payload: {
                task_id: "task-1",
                error: "命令失败",
                failure_reason: "exit_code",
              },
            },
          ]),
      }),
    );

    const events = Array.from(
      await Effect.runPromise(
        adapter.streamEvents({ runtimeTaskId: "task-1" }).pipe(Stream.runCollect),
      ),
    );

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      type: "task.progress",
      payload: { taskId: "task-1", step: 2, total: 5 },
      raw: {
        source: "multica.task-event",
        messageType: "task:progress",
      },
    });
    expect(events[1]).toMatchObject({
      type: "task.progress",
      payload: {
        taskId: "task-1",
        summary: "命令已完成",
        messageType: "tool_result",
        messageSeq: 7,
        messageTool: "terminal",
        messageOutput: "ok",
      },
    });
    expect(events[2]).toMatchObject({
      type: "task.completed",
      payload: {
        taskId: "task-1",
        status: "failed",
        error: "命令失败",
        failureReason: "exit_code",
      },
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

  it("只在显式 Code Work capability 扩展接受后开放带 grant 的派发", async () => {
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
          prompt: "执行带 Code Work 工具授权的任务",
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
