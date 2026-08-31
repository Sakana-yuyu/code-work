import { describe, expect, it } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  EventId,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
} from "@codework/contracts";

import { ProviderValidationError } from "../provider/Errors.ts";
import { makeCompositionProviderAgentDriver } from "./CompositionProviderAgentDriver.ts";
import type { CompositionRuntimeToolBridgeShape } from "./CompositionRuntimeToolBridge.ts";

const unusedRuntimeToolBridge = {
  invoke: () => Effect.die("测试不应调用 Runtime Tool Bridge"),
  cancel: () => Effect.die("测试不应取消 Runtime Tool Bridge"),
} satisfies CompositionRuntimeToolBridgeShape;

const makeAdapter = (options?: { readonly failTurn?: boolean }) => {
  const calls: string[] = [];
  const sessionInputs: ProviderSessionStartInput[] = [];
  const session = {
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex-local"),
    status: "ready",
    runtimeMode: "full-access",
    threadId: ThreadId.make("composition-thread-1"),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as ProviderSession;

  return {
    calls,
    adapter: {
      startSession: (input: ProviderSessionStartInput) => {
        sessionInputs.push(input);
        calls.push(`start:${input.threadId}`);
        return Effect.succeed(session);
      },
      sendTurn: (
        input: ProviderSendTurnInput,
      ): Effect.Effect<ProviderTurnStartResult, ProviderValidationError> => {
        calls.push(`send:${input.threadId}:${input.input ?? ""}`);
        if (options?.failTurn === true) {
          return Effect.fail(
            new ProviderValidationError({ operation: "sendTurn", issue: "测试失败" }),
          );
        }
        return Effect.succeed({ threadId: input.threadId, turnId: TurnId.make("turn-1") });
      },
      interruptTurn: (threadId: ThreadId, turnId?: TurnId) => {
        calls.push(`interrupt:${threadId}:${turnId ?? ""}`);
        return Effect.void;
      },
      stopSession: (threadId: ThreadId) => {
        calls.push(`stop:${threadId}`);
        return Effect.void;
      },
    },
    sessionInputs,
  };
};

describe("CompositionProviderAgentDriver", () => {
  it("Provider 仅允许在 orphan session 对账后恢复，不声明自动重放", () => {
    const fake = makeAdapter();
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-provider-recovery-policy",
      runtimeId: "provider-recovery-policy",
      providerInstanceId: ProviderInstanceId.make("provider-recovery-policy"),
      adapter: fake.adapter,
    });

    expect(driver.startRecoveryPolicy).toEqual({
      mode: "reconcile-only",
      after: "provider-sessions.reconcile",
      requiredReceipt: "runtime-task-and-handshake-when-granted",
    });
  });

  it("仅在同一 thread 的 turn.started 后归属启动中 Provider Run", async () => {
    const fake = makeAdapter();
    const turnStarted = Effect.runSync(Deferred.make<void>());
    const releaseTurn = Effect.runSync(Deferred.make<ProviderTurnStartResult>());
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-codex",
      runtimeId: "codex-local",
      providerInstanceId: ProviderInstanceId.make("codex-local"),
      adapter: {
        ...fake.adapter,
        sendTurn: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(turnStarted, undefined);
            return yield* Deferred.await(releaseTurn);
          }),
      },
    });
    const task = {
      taskId: "task-pending-provider",
      projectId: "project-1",
      threadId: "thread-pending-provider",
      assigneeKind: "agent" as const,
      assigneeId: "agent-codex",
      mode: "serial" as const,
      status: "queued" as const,
      promptDigest: "sha256:pending-provider",
      dependsOnTaskIds: [],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1,
    };
    const run = {
      runId: "run-pending-provider",
      taskId: task.taskId,
      agentId: task.assigneeId,
      runtimeId: "codex-local",
      status: "queued" as const,
      attempt: 1,
      capabilityGrantIds: [],
    };
    const startFiber = Effect.runFork(
      driver.startTask({ task, run, prompt: "等待 Runtime 事件", workspaceRoot: "C:/workspace" }),
    );
    await Effect.runPromise(Deferred.await(turnStarted));

    const event = (threadId: string, type: ProviderRuntimeEvent["type"]): ProviderRuntimeEvent =>
      ({
        eventId: EventId.make(`event-${threadId}-${type}`),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex-local"),
        threadId: ThreadId.make(threadId),
        turnId: TurnId.make("turn-pending-provider"),
        createdAt: "2026-08-27T00:00:00.000Z",
        type,
        payload: type === "turn.started" ? {} : { state: "cancelled" },
      }) as ProviderRuntimeEvent;

    expect(
      driver.resolveRuntimeEvent?.(event("thread-other-provider", "turn.started")),
    ).toBeUndefined();
    expect(driver.resolveRuntimeEvent?.(event(task.threadId, "turn.completed"))).toBeUndefined();
    expect(driver.resolveRuntimeEvent?.(event(task.threadId, "turn.started"))).toEqual({
      taskId: task.taskId,
      runId: run.runId,
      runtimeTaskId: "codex-local:thread-pending-provider:turn-pending-provider",
    });
    expect(driver.resolveRuntimeEvent?.(event(task.threadId, "turn.completed"))).toEqual({
      taskId: task.taskId,
      runId: run.runId,
      runtimeTaskId: "codex-local:thread-pending-provider:turn-pending-provider",
    });

    await Effect.runPromise(
      Deferred.succeed(releaseTurn, {
        threadId: ThreadId.make(task.threadId),
        turnId: TurnId.make("turn-pending-provider"),
      }),
    );
    await Effect.runPromise(Fiber.join(startFiber));
  });

  it("拒绝同一 Provider thread 的并发启动，避免事件串流", async () => {
    const fake = makeAdapter();
    const turnStarted = Effect.runSync(Deferred.make<void>());
    const releaseTurn = Effect.runSync(Deferred.make<ProviderTurnStartResult>());
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-codex",
      runtimeId: "codex-local",
      providerInstanceId: ProviderInstanceId.make("codex-local"),
      adapter: {
        ...fake.adapter,
        sendTurn: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(turnStarted, undefined);
            return yield* Deferred.await(releaseTurn);
          }),
      },
    });
    const task = {
      taskId: "task-shared-thread",
      projectId: "project-1",
      threadId: "thread-shared-provider",
      assigneeKind: "agent" as const,
      assigneeId: "agent-codex",
      mode: "serial" as const,
      status: "queued" as const,
      promptDigest: "sha256:shared-thread",
      dependsOnTaskIds: [],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1,
    };
    const firstRun = {
      runId: "run-shared-provider-1",
      taskId: task.taskId,
      agentId: task.assigneeId,
      runtimeId: "codex-local",
      status: "queued" as const,
      attempt: 1,
      capabilityGrantIds: [],
    };
    const firstStart = Effect.runFork(
      driver.startTask({
        task,
        run: firstRun,
        prompt: "第一个任务",
        workspaceRoot: "C:/workspace",
      }),
    );
    await Effect.runPromise(Deferred.await(turnStarted));

    await expect(
      Effect.runPromise(
        driver.startTask({
          task: { ...task, taskId: "task-shared-thread-2" },
          run: { ...firstRun, runId: "run-shared-provider-2", taskId: "task-shared-thread-2" },
          prompt: "第二个任务",
          workspaceRoot: "C:/workspace",
        }),
      ),
    ).rejects.toMatchObject({ code: "provider_thread_busy" });

    await Effect.runPromise(
      Deferred.succeed(releaseTurn, {
        threadId: ThreadId.make(task.threadId),
        turnId: TurnId.make("turn-shared-provider"),
      }),
    );
    await Effect.runPromise(Fiber.join(firstStart));
    expect(fake.calls).toEqual(["start:thread-shared-provider"]);
  });

  it("早到终态在 startTask 返回后撤销待定 capability handshake", async () => {
    const fake = makeAdapter();
    const turnStarted = Effect.runSync(Deferred.make<void>());
    const releaseTurn = Effect.runSync(Deferred.make<ProviderTurnStartResult>());
    const revokedHandshakeIds: string[] = [];
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-codex",
      runtimeId: "codex-local",
      providerInstanceId: ProviderInstanceId.make("codex-local"),
      adapter: {
        ...fake.adapter,
        handshakeCapabilities: (input) =>
          Effect.succeed({
            ...input,
            status: "accepted" as const,
            handshakeId: "handshake-early-terminal",
            acceptedGrantIds: [...input.capabilityGrantIds],
          }),
        revokeCapabilityHandshake: ({ handshakeId }) =>
          Effect.sync(() => revokedHandshakeIds.push(handshakeId)),
        sendTurn: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(turnStarted, undefined);
            return yield* Deferred.await(releaseTurn);
          }),
      },
    });
    const task = {
      taskId: "task-early-terminal-handshake",
      projectId: "project-1",
      threadId: "thread-early-terminal-handshake",
      assigneeKind: "agent" as const,
      assigneeId: "agent-codex",
      mode: "serial" as const,
      status: "queued" as const,
      promptDigest: "sha256:early-terminal-handshake",
      dependsOnTaskIds: [],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1,
    };
    const run = {
      runId: "run-early-terminal-handshake",
      taskId: task.taskId,
      agentId: task.assigneeId,
      runtimeId: "codex-local",
      status: "queued" as const,
      attempt: 1,
      capabilityGrantIds: ["grant-early-terminal"],
    };
    const startFiber = Effect.runFork(
      driver.startTask({ task, run, prompt: "等待终态", workspaceRoot: "C:/workspace" }),
    );
    await Effect.runPromise(Deferred.await(turnStarted));
    const event = (type: "turn.started" | "turn.completed"): ProviderRuntimeEvent =>
      ({
        eventId: EventId.make(`event-early-terminal-handshake-${type}`),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex-local"),
        threadId: ThreadId.make(task.threadId),
        turnId: TurnId.make("turn-early-terminal-handshake"),
        createdAt: "2026-08-27T00:00:00.000Z",
        type,
        payload: type === "turn.started" ? {} : { state: "cancelled" },
      }) as ProviderRuntimeEvent;
    driver.resolveRuntimeEvent?.(event("turn.started"));
    driver.resolveRuntimeEvent?.(event("turn.completed"));

    await Effect.runPromise(
      Deferred.succeed(releaseTurn, {
        threadId: ThreadId.make(task.threadId),
        turnId: TurnId.make("turn-early-terminal-handshake"),
      }),
    );
    await Effect.runPromise(Fiber.join(startFiber));
    expect(revokedHandshakeIds).toEqual(["handshake-early-terminal"]);
  });

  it("早到 turnId 与 Provider 返回不一致时清理 handshake 和 ToolBroker", async () => {
    const fake = makeAdapter();
    const turnStarted = Effect.runSync(Deferred.make<void>());
    const releaseTurn = Effect.runSync(Deferred.make<ProviderTurnStartResult>());
    const revokedHandshakeIds: string[] = [];
    const clearedThreadIds: string[] = [];
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-cursor",
      runtimeId: "cursor-local",
      providerInstanceId: ProviderInstanceId.make("cursor-local"),
      toolBrokerBridge: unusedRuntimeToolBridge,
      toolBrokerCanonicalTools: ["workspace.read_file"],
      adapter: {
        ...fake.adapter,
        handshakeCapabilities: (input) =>
          Effect.succeed({
            ...input,
            status: "accepted" as const,
            handshakeId: "handshake-turn-mismatch",
            acceptedGrantIds: [...input.capabilityGrantIds],
          }),
        configureToolBroker: () => Effect.void,
        clearToolBroker: (threadId) => Effect.sync(() => clearedThreadIds.push(threadId)),
        revokeCapabilityHandshake: ({ handshakeId }) =>
          Effect.sync(() => revokedHandshakeIds.push(handshakeId)),
        sendTurn: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(turnStarted, undefined);
            return yield* Deferred.await(releaseTurn);
          }),
      },
    });
    const task = {
      taskId: "task-turn-mismatch",
      projectId: "project-1",
      threadId: "thread-turn-mismatch",
      assigneeKind: "agent" as const,
      assigneeId: "agent-cursor",
      mode: "serial" as const,
      status: "queued" as const,
      promptDigest: "sha256:turn-mismatch",
      dependsOnTaskIds: [],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1,
    };
    const run = {
      runId: "run-turn-mismatch",
      taskId: task.taskId,
      agentId: task.assigneeId,
      runtimeId: "cursor-local",
      status: "queued" as const,
      attempt: 1,
      capabilityGrantIds: ["grant-turn-mismatch"],
    };
    const startFiber = Effect.runFork(
      driver.startTask({ task, run, prompt: "等待不一致 turn", workspaceRoot: "C:/workspace" }),
    );
    await Effect.runPromise(Deferred.await(turnStarted));
    driver.resolveRuntimeEvent?.({
      eventId: EventId.make("event-turn-mismatch"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("cursor-local"),
      threadId: ThreadId.make(task.threadId),
      turnId: TurnId.make("turn-from-event"),
      createdAt: "2026-08-27T00:00:00.000Z",
      type: "turn.started",
      payload: {},
    });
    await Effect.runPromise(
      Deferred.succeed(releaseTurn, {
        threadId: ThreadId.make(task.threadId),
        turnId: TurnId.make("turn-from-result"),
      }),
    );

    await expect(Effect.runPromise(Fiber.join(startFiber))).rejects.toMatchObject({
      code: "provider_runtime_binding_invalid",
    });
    expect(revokedHandshakeIds).toEqual(["handshake-turn-mismatch"]);
    expect(clearedThreadIds).toEqual([task.threadId]);
  });

  it("ToolBroker 配置失败后允许同一 Provider thread 重新启动", async () => {
    const fake = makeAdapter();
    let configureAttempts = 0;
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-cursor",
      runtimeId: "cursor-local",
      providerInstanceId: ProviderInstanceId.make("cursor-local"),
      toolBrokerBridge: unusedRuntimeToolBridge,
      toolBrokerCanonicalTools: ["workspace.read_file"],
      adapter: {
        ...fake.adapter,
        handshakeCapabilities: (input) =>
          Effect.succeed({
            ...input,
            status: "accepted" as const,
            handshakeId: `handshake-retry-${input.runId}`,
            acceptedGrantIds: [...input.capabilityGrantIds],
          }),
        configureToolBroker: () => {
          configureAttempts += 1;
          return configureAttempts === 1
            ? Effect.fail(
                new ProviderValidationError({
                  operation: "configureToolBroker",
                  issue: "首次配置失败",
                }),
              )
            : Effect.void;
        },
        clearToolBroker: () => Effect.void,
        revokeCapabilityHandshake: () => Effect.void,
      },
    });
    const task = {
      taskId: "task-toolbroker-retry",
      projectId: "project-1",
      threadId: "thread-toolbroker-retry",
      assigneeKind: "agent" as const,
      assigneeId: "agent-cursor",
      mode: "serial" as const,
      status: "queued" as const,
      promptDigest: "sha256:toolbroker-retry",
      dependsOnTaskIds: [],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1,
    };
    const firstRun = {
      runId: "run-toolbroker-retry-1",
      taskId: task.taskId,
      agentId: task.assigneeId,
      runtimeId: "cursor-local",
      status: "queued" as const,
      attempt: 1,
      capabilityGrantIds: ["grant-toolbroker-retry"],
    };

    await expect(
      Effect.runPromise(
        driver.startTask({
          task,
          run: firstRun,
          prompt: "首次配置",
          workspaceRoot: "C:/workspace",
        }),
      ),
    ).rejects.toMatchObject({ code: "provider_toolbroker_configure_failed" });
    await expect(
      Effect.runPromise(
        driver.startTask({
          task: { ...task, taskId: "task-toolbroker-retry-2" },
          run: { ...firstRun, runId: "run-toolbroker-retry-2", taskId: "task-toolbroker-retry-2" },
          prompt: "重新配置",
          workspaceRoot: "C:/workspace",
        }),
      ),
    ).resolves.toMatchObject({ runtimeTaskId: "cursor-local:thread-toolbroker-retry:turn-1" });
    expect(configureAttempts).toBe(2);
  });

  it("starts a provider session and sends the transient task prompt", async () => {
    const fake = makeAdapter();
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-codex",
      runtimeId: "codex-local",
      providerInstanceId: ProviderInstanceId.make("codex-local"),
      adapter: fake.adapter,
    });

    await expect(
      Effect.runPromise(
        driver.startTask({
          task: {
            taskId: "task-1",
            projectId: "project-1",
            threadId: "thread-1",
            assigneeKind: "agent",
            assigneeId: "agent-codex",
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
            agentId: "agent-codex",
            runtimeId: "codex-local",
            status: "queued",
            attempt: 1,
            capabilityGrantIds: [],
          },
          prompt: "检查工作区",
          workspaceRoot: "C:/workspace",
        }),
      ),
    ).resolves.toMatchObject({ runtimeTaskId: "codex-local:thread-1:turn-1" });
    expect(fake.calls).toEqual(["start:thread-1", "send:thread-1:检查工作区"]);

    const binding = driver.resolveRuntimeEvent?.({
      eventId: EventId.make("event-1"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex-local"),
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      createdAt: "2026-08-25T00:00:00.000Z",
      type: "turn.completed",
      payload: { state: "completed" },
    } satisfies ProviderRuntimeEvent);
    expect(binding).toEqual({
      taskId: "task-1",
      runId: "run-1",
      runtimeTaskId: "codex-local:thread-1:turn-1",
    });
  });

  it("清理活动 Provider Run 后仍能解析带 turnId 的迟到事件", async () => {
    const fake = makeAdapter();
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-codex",
      runtimeId: "codex-local",
      providerInstanceId: ProviderInstanceId.make("codex-local"),
      adapter: fake.adapter,
    });
    const task = {
      taskId: "task-late-provider",
      projectId: "project-1",
      threadId: "thread-late-provider",
      assigneeKind: "agent" as const,
      assigneeId: "agent-codex",
      mode: "serial" as const,
      status: "queued" as const,
      promptDigest: "sha256:late-provider",
      dependsOnTaskIds: [],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1,
    };
    const run = {
      runId: "run-late-provider",
      taskId: task.taskId,
      agentId: "agent-codex",
      runtimeId: "codex-local",
      status: "queued" as const,
      attempt: 1,
      capabilityGrantIds: [],
    };
    await Effect.runPromise(
      driver.startTask({ task, run, prompt: "检查", workspaceRoot: "C:/workspace" }),
    );
    await Effect.runPromise(driver.revokeCapabilityHandshake!({ task, run }));

    expect(
      driver.resolveRuntimeEvent?.({
        eventId: EventId.make("event-late-provider"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex-local"),
        threadId: ThreadId.make("thread-late-provider"),
        turnId: TurnId.make("turn-1"),
        createdAt: "2026-08-26T00:00:00.000Z",
        type: "turn.completed",
        payload: { state: "completed" },
      } satisfies ProviderRuntimeEvent),
    ).toEqual({
      taskId: task.taskId,
      runId: run.runId,
      runtimeTaskId: "codex-local:thread-late-provider:turn-1",
    });
  });

  it("只为匹配 Provider 实例且带 turnId 的事件派生持久化恢复键", () => {
    const fake = makeAdapter();
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-cursor",
      runtimeId: "provider:cursor-local",
      providerInstanceId: ProviderInstanceId.make("cursor-local"),
      adapter: fake.adapter,
    });
    const matching = {
      eventId: EventId.make("event-provider-persisted-correlation"),
      provider: ProviderDriverKind.make("cursor"),
      providerInstanceId: ProviderInstanceId.make("cursor-local"),
      threadId: ThreadId.make("thread-persisted-correlation"),
      turnId: TurnId.make("turn-persisted-correlation"),
      createdAt: "2026-08-27T00:00:00.000Z",
      type: "turn.completed" as const,
      payload: { state: "completed" as const },
    } satisfies ProviderRuntimeEvent;

    expect(driver.resolvePersistedRuntimeEvent?.(matching)).toEqual({
      runtimeId: "provider:cursor-local",
      runtimeTaskId:
        "provider:cursor-local:thread-persisted-correlation:turn-persisted-correlation",
    });
    expect(
      driver.resolvePersistedRuntimeEvent?.({
        ...matching,
        eventId: EventId.make("event-provider-persisted-other-instance"),
        providerInstanceId: ProviderInstanceId.make("cursor-other"),
      }),
    ).toBeUndefined();
    const {
      providerInstanceId: _providerInstanceId,
      turnId: _turnId,
      ...withoutCorrelation
    } = matching;
    expect(driver.resolvePersistedRuntimeEvent?.(withoutCorrelation)).toBeUndefined();
  });

  it("Provider 没有 capability handshake 时拒绝带 grant 的任务", async () => {
    const fake = makeAdapter();
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-codex",
      runtimeId: "codex-local",
      providerInstanceId: ProviderInstanceId.make("codex-local"),
      adapter: fake.adapter,
    });

    await expect(
      Effect.runPromise(
        driver.startTask({
          task: {
            taskId: "task-grant",
            projectId: "project-1",
            assigneeKind: "agent",
            assigneeId: "agent-codex",
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
            agentId: "agent-codex",
            runtimeId: "codex-local",
            status: "queued",
            attempt: 1,
            capabilityGrantIds: ["grant-1"],
          },
          prompt: "检查工作区",
        }),
      ),
    ).rejects.toMatchObject({ code: "provider_capability_handshake_unsupported" });
    expect(fake.sessionInputs).toHaveLength(0);
  });

  it("把已接受的 Provider capability handshake ID 传入 Session", async () => {
    const fake = makeAdapter();
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-codex",
      runtimeId: "codex-local",
      providerInstanceId: ProviderInstanceId.make("codex-local"),
      adapter: {
        ...fake.adapter,
        handshakeCapabilities: (input) =>
          Effect.succeed({
            ...input,
            status: "accepted" as const,
            handshakeId: "provider-handshake-1",
            acceptedGrantIds: [...input.capabilityGrantIds],
          }),
      },
    });

    const started = await Effect.runPromise(
      driver.startTask({
        task: {
          taskId: "task-provider-grant",
          projectId: "project-1",
          assigneeKind: "agent",
          assigneeId: "agent-codex",
          mode: "serial",
          status: "queued",
          promptDigest: "sha256:provider-grant",
          dependsOnTaskIds: [],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
        },
        run: {
          runId: "run-provider-grant",
          taskId: "task-provider-grant",
          agentId: "agent-codex",
          runtimeId: "codex-local",
          status: "queued",
          attempt: 1,
          capabilityGrantIds: ["grant-provider-1"],
        },
        prompt: "检查工作区",
      }),
    );

    expect(started.capabilityHandshakeId).toBe("provider-handshake-1");
    expect(fake.sessionInputs[0]).toMatchObject({
      runtimeMode: "full-access",
      capabilityHandshakeId: "provider-handshake-1",
    });
  });

  it.each([
    ["错绑 runtime", { runtimeId: "other-runtime" }],
    ["错绑 task", { taskId: "other-task" }],
    ["错绑 run", { runId: "other-run" }],
    ["错绑 agent", { agentId: "other-agent" }],
    ["额外 grant", { acceptedGrantIds: ["grant-provider-1", "grant-extra"] }],
    ["重复 grant", { acceptedGrantIds: ["grant-provider-1", "grant-provider-1"] }],
    ["已过期", { expiresAtUnixMs: 1 }],
  ])("拒绝%s的 capability handshake", async (_label, override) => {
    const fake = makeAdapter();
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-codex",
      runtimeId: "codex-local",
      providerInstanceId: ProviderInstanceId.make("codex-local"),
      adapter: {
        ...fake.adapter,
        handshakeCapabilities: (input) =>
          Effect.succeed({
            ...input,
            status: "accepted" as const,
            handshakeId: "provider-handshake-invalid",
            acceptedGrantIds: [...input.capabilityGrantIds],
            ...override,
          }),
      },
    });

    await expect(
      Effect.runPromise(
        driver.startTask({
          task: {
            taskId: "task-provider-grant",
            projectId: "project-1",
            assigneeKind: "agent",
            assigneeId: "agent-codex",
            mode: "serial",
            status: "queued",
            promptDigest: "sha256:provider-grant",
            dependsOnTaskIds: [],
            createdAtUnixMs: 1,
            updatedAtUnixMs: 1,
          },
          run: {
            runId: "run-provider-grant",
            taskId: "task-provider-grant",
            agentId: "agent-codex",
            runtimeId: "codex-local",
            status: "queued",
            attempt: 1,
            capabilityGrantIds: ["grant-provider-1"],
          },
          prompt: "检查工作区",
        }),
      ),
    ).rejects.toMatchObject({ code: "provider_capability_handshake_rejected" });
    expect(fake.sessionInputs).toHaveLength(0);
  });

  it("interrupts the provider turn when the composition task is cancelled", async () => {
    const fake = makeAdapter();
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-codex",
      runtimeId: "codex-local",
      providerInstanceId: ProviderInstanceId.make("codex-local"),
      adapter: fake.adapter,
    });
    const task = {
      taskId: "task-1",
      projectId: "project-1",
      threadId: "thread-1",
      assigneeKind: "agent" as const,
      assigneeId: "agent-codex",
      mode: "serial" as const,
      status: "queued" as const,
      promptDigest: "sha256:prompt",
      dependsOnTaskIds: [],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1,
    };
    const run = {
      runId: "run-1",
      taskId: "task-1",
      agentId: "agent-codex",
      runtimeId: "codex-local",
      status: "queued" as const,
      attempt: 1,
      capabilityGrantIds: [],
    };

    await Effect.runPromise(
      driver.startTask({ task, run, prompt: "继续", workspaceRoot: "C:/workspace" }),
    );
    await expect(
      Effect.runPromise(driver.cancelTask({ task, run, reason: "用户取消" })),
    ).resolves.toEqual({ status: "cancelled" });
    expect(fake.calls).toContain("interrupt:thread-1:turn-1");
  });

  it("stops the provider session when starting the turn fails", async () => {
    const fake = makeAdapter({ failTurn: true });
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-codex",
      runtimeId: "codex-local",
      providerInstanceId: ProviderInstanceId.make("codex-local"),
      adapter: fake.adapter,
    });

    await expect(
      Effect.runPromise(
        driver.startTask({
          task: {
            taskId: "task-1",
            projectId: "project-1",
            threadId: "thread-1",
            assigneeKind: "agent",
            assigneeId: "agent-codex",
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
            agentId: "agent-codex",
            runtimeId: "codex-local",
            status: "queued",
            attempt: 1,
            capabilityGrantIds: [],
          },
          prompt: "失败测试",
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "CompositionAgentDriverFailure",
      code: "provider_turn_start_failed",
    });
    expect(fake.calls).toEqual(["start:thread-1", "send:thread-1:失败测试", "stop:thread-1"]);
  });

  it("只在可信 ToolBroker 和 handshake 都可用时投影真实工具能力", async () => {
    const fake = makeAdapter();
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-cursor",
      runtimeId: "provider:cursor-local",
      providerInstanceId: ProviderInstanceId.make("cursor-local"),
      toolBrokerBridge: unusedRuntimeToolBridge,
      toolBrokerCanonicalTools: [
        "workspace.read_file",
        "terminal.open",
        "git.status",
        "mcp.example.search",
        "ide.invoke",
      ],
      adapter: {
        ...fake.adapter,
        handshakeCapabilities: (input) =>
          Effect.succeed({
            ...input,
            status: "accepted" as const,
            handshakeId: "provider-handshake-profile",
            acceptedGrantIds: [...input.capabilityGrantIds],
          }),
        revokeCapabilityHandshake: () => Effect.void,
        configureToolBroker: () => Effect.void,
        clearToolBroker: () => Effect.void,
      },
    });

    await expect(Effect.runPromise(driver.getProfile!())).resolves.toMatchObject({
      status: "available",
      supportsToolBroker: true,
      supportsCapabilityHandshake: true,
      supportsWorkspace: true,
      supportsTerminal: true,
      supportsGit: true,
      supportsMcp: true,
      supportsIde: true,
      supportsProviderApi: true,
    });
    const profile = await Effect.runPromise(driver.getProfile!());
    expect(profile.reasonCode).toBeUndefined();
    expect(profile.capabilities).toEqual(
      expect.arrayContaining([
        "t3.toolbroker",
        "t3.workspace",
        "t3.terminal",
        "t3.git",
        "t3.mcp",
        "t3.ide",
        "t3.provider_api",
      ]),
    );
  });

  it("ToolBroker 缺少 workspace 时撤销已接受的 handshake", async () => {
    const fake = makeAdapter();
    const calls: string[] = [];
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-cursor",
      runtimeId: "provider:cursor-local",
      providerInstanceId: ProviderInstanceId.make("cursor-local"),
      toolBrokerBridge: unusedRuntimeToolBridge,
      toolBrokerCanonicalTools: ["workspace.read_file"],
      adapter: {
        ...fake.adapter,
        handshakeCapabilities: (input) =>
          Effect.succeed({
            ...input,
            status: "accepted" as const,
            handshakeId: "provider-handshake-missing-workspace",
            acceptedGrantIds: [...input.capabilityGrantIds],
          }),
        revokeCapabilityHandshake: ({ handshakeId }) =>
          Effect.sync(() => calls.push(`revoke:${handshakeId}`)),
        configureToolBroker: () => Effect.void,
        clearToolBroker: () => Effect.void,
      },
    });

    await expect(
      Effect.runPromise(
        driver.startTask({
          task: {
            taskId: "task-missing-workspace",
            projectId: "project-1",
            assigneeKind: "agent",
            assigneeId: "agent-cursor",
            mode: "serial",
            status: "queued",
            promptDigest: "sha256:missing-workspace",
            dependsOnTaskIds: [],
            createdAtUnixMs: 1,
            updatedAtUnixMs: 1,
          },
          run: {
            runId: "run-missing-workspace",
            taskId: "task-missing-workspace",
            agentId: "agent-cursor",
            runtimeId: "provider:cursor-local",
            status: "queued",
            attempt: 1,
            capabilityGrantIds: ["grant-workspace"],
          },
          prompt: "读取文件",
        }),
      ),
    ).rejects.toMatchObject({ code: "provider_toolbroker_context_missing" });
    expect(calls).toEqual(["revoke:provider-handshake-missing-workspace"]);
  });

  it("取消中断失败时仍停止会话并清理 ToolBroker 与 handshake", async () => {
    const fake = makeAdapter();
    const cleanupCalls: string[] = [];
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-cursor",
      runtimeId: "provider:cursor-local",
      providerInstanceId: ProviderInstanceId.make("cursor-local"),
      toolBrokerBridge: unusedRuntimeToolBridge,
      toolBrokerCanonicalTools: ["workspace.read_file"],
      adapter: {
        ...fake.adapter,
        handshakeCapabilities: (input) =>
          Effect.succeed({
            ...input,
            status: "accepted" as const,
            handshakeId: "provider-handshake-cancel",
            acceptedGrantIds: [...input.capabilityGrantIds],
          }),
        revokeCapabilityHandshake: ({ handshakeId }) =>
          Effect.sync(() => cleanupCalls.push(`revoke:${handshakeId}`)),
        configureToolBroker: ({ threadId }) =>
          Effect.sync(() => cleanupCalls.push(`configure:${threadId}`)),
        clearToolBroker: (threadId) => Effect.sync(() => cleanupCalls.push(`clear:${threadId}`)),
        interruptTurn: () =>
          Effect.fail(
            new ProviderValidationError({ operation: "interruptTurn", issue: "测试中断失败" }),
          ),
        stopSession: (threadId) => Effect.sync(() => cleanupCalls.push(`stop:${threadId}`)),
      },
    });
    const task = {
      taskId: "task-cancel-cleanup",
      projectId: "project-1",
      threadId: "thread-cancel-cleanup",
      assigneeKind: "agent" as const,
      assigneeId: "agent-cursor",
      mode: "serial" as const,
      status: "queued" as const,
      promptDigest: "sha256:cancel-cleanup",
      dependsOnTaskIds: [],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1,
    };
    const run = {
      runId: "run-cancel-cleanup",
      taskId: task.taskId,
      agentId: "agent-cursor",
      runtimeId: "provider:cursor-local",
      status: "queued" as const,
      attempt: 1,
      capabilityGrantIds: ["grant-workspace"],
    };

    await Effect.runPromise(
      driver.startTask({ task, run, prompt: "读取文件", workspaceRoot: "C:/workspace" }),
    );
    await expect(
      Effect.runPromise(driver.cancelTask({ task, run, reason: "用户取消" })),
    ).rejects.toMatchObject({ code: "provider_turn_cancel_failed" });
    expect(cleanupCalls).toEqual([
      "configure:thread-cancel-cleanup",
      "stop:thread-cancel-cleanup",
      "clear:thread-cancel-cleanup",
      "revoke:provider-handshake-cancel",
    ]);
  });
});
