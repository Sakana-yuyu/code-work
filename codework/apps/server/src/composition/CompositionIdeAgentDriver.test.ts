import { describe, expect, it } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import {
  EventId,
  ProviderDriverKind,
  RuntimeTaskId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@codework/contracts";

import {
  makeCompositionIdeAgentDriver,
  compositionIdeAgentId,
} from "./CompositionIdeAgentDriver.ts";
import { makeCompositionIdeSessionRegistry } from "./CompositionIdeSessionRegistry.ts";
import type { CompositionIdeAdapter } from "./CompositionIdeSessionRegistry.ts";

const task = {
  taskId: "task-ide-driver",
  projectId: "project-1",
  assigneeKind: "agent" as const,
  assigneeId: compositionIdeAgentId("vscode-session-1"),
  mode: "serial" as const,
  status: "queued" as const,
  promptDigest: "sha256:ide-driver",
  dependsOnTaskIds: [],
  createdAtUnixMs: 1,
  updatedAtUnixMs: 1,
};

const run = {
  runId: "run-ide-driver",
  taskId: task.taskId,
  agentId: task.assigneeId,
  runtimeId: "ide:vscode-session-1",
  status: "queued" as const,
  attempt: 1,
  capabilityGrantIds: ["grant-ide"],
};

const makeAdapter = (calls: string[]): CompositionIdeAdapter => ({
  sessionId: "vscode-session-1",
  profile: "vscode_ide",
  probe: () =>
    Effect.succeed({
      sessionId: "vscode-session-1",
      profile: "vscode_ide" as const,
      status: "ready" as const,
      verifiedOperations: ["task.start", "task.cancel", "task.events"],
    }),
  handshake: (input) => {
    calls.push("handshake");
    return Effect.succeed({
      sessionId: input.sessionId,
      taskId: input.taskId,
      runId: input.runId,
      agentId: input.agentId,
      profile: "vscode_ide" as const,
      status: "accepted" as const,
      handshakeId: "ide-task-handshake",
      acceptedGrantIds: [...input.capabilityGrantIds],
      verifiedOperations: [...input.requestedOperations],
    });
  },
  invoke: (input) => {
    calls.push(input.operation);
    if (input.operation === "task.start") {
      return Effect.succeed({ runtimeTaskId: "ide-runtime-task-1", status: "accepted" });
    }
    return Effect.succeed({ status: "cancelled", runtimeTaskId: "ide-runtime-task-1" });
  },
  streamEvents: () => Stream.empty,
});

describe("CompositionIdeAgentDriver", () => {
  it("IDE 每次握手和 task.start 都有外部副作用，因此启动恢复 fail-closed", () => {
    const registry = makeCompositionIdeSessionRegistry();
    const adapter = makeAdapter([]);
    const driver = makeCompositionIdeAgentDriver({
      registry,
      sessionId: "vscode-session-1",
      profile: "vscode_ide",
      agentId: compositionIdeAgentId("vscode-session-1"),
      eventStream: adapter.streamEvents,
    });

    expect(driver.startRecoveryPolicy).toEqual({
      mode: "fail-closed",
      reasonCode: "ide_start_replay_unsafe",
      requiredReceipt: "runtime-task-and-handshake",
    });
  });

  it("把已验证的 IDE task bridge operation 投影为可派发 Driver", async () => {
    const calls: string[] = [];
    const registry = makeCompositionIdeSessionRegistry();
    const adapter = makeAdapter(calls);
    await Effect.runPromise(registry.register(adapter));
    const driver = makeCompositionIdeAgentDriver({
      registry,
      sessionId: "vscode-session-1",
      profile: "vscode_ide",
      agentId: compositionIdeAgentId("vscode-session-1"),
      eventStream: adapter.streamEvents,
    });

    await expect(Effect.runPromise(driver.getProfile!())).resolves.toMatchObject({
      agentId: "ide:vscode-session-1",
      runtimeId: "ide:vscode-session-1",
      driverKind: "ide",
      status: "available",
      supportsIde: true,
      supportsToolBroker: false,
    });
  });

  it("先完成 capability handshake，再通过 IDE bridge 派发和取消任务", async () => {
    const calls: string[] = [];
    const registry = makeCompositionIdeSessionRegistry();
    const adapter = makeAdapter(calls);
    await Effect.runPromise(registry.register(adapter));
    const driver = makeCompositionIdeAgentDriver({
      registry,
      sessionId: "vscode-session-1",
      profile: "vscode_ide",
      agentId: compositionIdeAgentId("vscode-session-1"),
      eventStream: adapter.streamEvents,
    });

    const started = await Effect.runPromise(
      driver.startTask({
        task,
        run,
        prompt: "请检查当前编辑器任务",
        workspaceRoot: "C:/workspace",
      }),
    );
    expect(started).toEqual({
      runtimeTaskId: "ide-runtime-task-1",
      capabilityHandshakeId: "ide-task-handshake",
    });

    await expect(
      Effect.runPromise(
        driver.cancelTask({
          task,
          run: {
            ...run,
            status: "running",
            runtimeTaskId: started.runtimeTaskId,
            capabilityHandshakeId: started.capabilityHandshakeId,
          },
          reason: "用户取消",
        }),
      ),
    ).resolves.toEqual({ status: "cancelled" });
    expect(calls).toEqual(["handshake", "task.start", "task.cancel"]);
  });

  it("使用 session 的 cursor profile 发起 task handshake", async () => {
    const requestedProfiles: string[] = [];
    const registry = makeCompositionIdeSessionRegistry();
    const adapter: CompositionIdeAdapter = {
      sessionId: "cursor-session-1",
      profile: "cursor_ide",
      probe: () =>
        Effect.succeed({
          sessionId: "cursor-session-1",
          profile: "cursor_ide" as const,
          status: "ready" as const,
          verifiedOperations: ["task.start", "task.cancel", "task.events"],
        }),
      handshake: (input) => {
        requestedProfiles.push(input.requestedProfile);
        return Effect.succeed({
          sessionId: input.sessionId,
          taskId: input.taskId,
          runId: input.runId,
          agentId: input.agentId,
          profile: "cursor_ide" as const,
          status: "accepted" as const,
          handshakeId: "cursor-task-handshake",
          acceptedGrantIds: [...input.capabilityGrantIds],
          verifiedOperations: [...input.requestedOperations],
        });
      },
      invoke: () => Effect.succeed({ runtimeTaskId: "cursor-runtime-task-1", status: "accepted" }),
      streamEvents: () => Stream.empty,
    };
    await Effect.runPromise(registry.register(adapter));
    const driver = makeCompositionIdeAgentDriver({
      registry,
      sessionId: "cursor-session-1",
      profile: "cursor_ide",
      eventStream: adapter.streamEvents,
    });

    await Effect.runPromise(
      driver.startTask({
        task: {
          ...task,
          assigneeId: driver.agentId,
        },
        run: {
          ...run,
          agentId: driver.agentId,
          runtimeId: driver.runtimeId,
        },
        prompt: "通过 Cursor IDE 执行任务",
        workspaceRoot: "C:/workspace",
      }),
    );

    expect(requestedProfiles).toEqual(["cursor_ide"]);
  });

  it("在 task.start 响应前收到事件时等待 runtime 绑定后再交给投影器", async () => {
    const invokeStarted = await Effect.runPromise(Deferred.make<void>());
    const releaseStart = await Effect.runPromise(Deferred.make<void>());
    const callbackAttempted = await Effect.runPromise(Deferred.make<void>());
    const releaseCallback = await Effect.runPromise(Deferred.make<void>());
    const eventQueue = await Effect.runPromise(Queue.unbounded<ProviderRuntimeEvent>());
    const runtimeTaskId = RuntimeTaskId.make("ide-runtime-task-race");
    const event = {
      eventId: EventId.make("ide-event-race-1"),
      provider: ProviderDriverKind.make("ide"),
      threadId: ThreadId.make("ide:vscode-session-1"),
      createdAt: "2026-08-27T00:00:00.000Z",
      type: "task.completed",
      payload: {
        taskId: runtimeTaskId,
        status: "completed",
        summary: "IDE 任务已完成",
      },
      raw: {
        source: "ide.jsonrpc",
        method: "t3.ide.event",
        runtimeId: "ide:vscode-session-1",
        runtimeTaskId,
        payload: { sessionId: "vscode-session-1" },
      },
    } satisfies ProviderRuntimeEvent;
    const registry = makeCompositionIdeSessionRegistry();
    const adapter: CompositionIdeAdapter = {
      sessionId: "vscode-session-1",
      profile: "vscode_ide",
      probe: () =>
        Effect.succeed({
          sessionId: "vscode-session-1",
          profile: "vscode_ide" as const,
          status: "ready" as const,
          verifiedOperations: ["task.start", "task.cancel", "task.events"],
        }),
      handshake: (input) =>
        Effect.succeed({
          sessionId: input.sessionId,
          taskId: input.taskId,
          runId: input.runId,
          agentId: input.agentId,
          profile: "vscode_ide" as const,
          status: "accepted" as const,
          handshakeId: "ide-task-handshake-race",
          acceptedGrantIds: [...input.capabilityGrantIds],
          verifiedOperations: [...input.requestedOperations],
        }),
      invoke: (input) =>
        input.operation === "task.start"
          ? Effect.gen(function* () {
              yield* Deferred.succeed(invokeStarted, undefined);
              yield* Queue.offer(eventQueue, event);
              yield* Deferred.await(releaseStart);
              return { runtimeTaskId, status: "accepted" };
            })
          : Effect.succeed({ status: "cancelled" }),
      streamEvents: () => Stream.fromQueue(eventQueue),
    };
    await Effect.runPromise(registry.register(adapter));
    const driver = makeCompositionIdeAgentDriver({
      registry,
      sessionId: "vscode-session-1",
      profile: "vscode_ide",
      eventStream: adapter.streamEvents,
    });
    let resolved:
      | { readonly taskId: string; readonly runId: string; readonly runtimeTaskId?: string }
      | undefined;
    const consume = Effect.runPromise(
      driver.streamEvents!().pipe(
        Stream.take(1),
        Stream.runForEach((received) =>
          Effect.gen(function* () {
            resolved = driver.resolveRuntimeEvent!(received);
            yield* Deferred.succeed(callbackAttempted, undefined);
            yield* Deferred.await(releaseCallback);
          }),
        ),
      ),
    );
    const start = Effect.runPromise(
      driver.startTask({
        task,
        run,
        prompt: "验证事件乱序",
        workspaceRoot: "C:/workspace",
      }),
    );

    await Effect.runPromise(Deferred.await(invokeStarted));
    const callbackBeforeResponse = await Effect.runPromise(
      Deferred.await(callbackAttempted).pipe(Effect.timeoutOption("50 millis")),
    );
    expect(Option.isNone(callbackBeforeResponse)).toBe(true);
    await Effect.runPromise(Deferred.succeed(releaseStart, undefined));
    const started = await start;
    await Effect.runPromise(Deferred.succeed(releaseCallback, undefined));
    await consume;

    expect(started.runtimeTaskId).toBe(runtimeTaskId);
    expect(resolved).toEqual({
      taskId: task.taskId,
      runId: run.runId,
      runtimeTaskId,
    });
  });
});
