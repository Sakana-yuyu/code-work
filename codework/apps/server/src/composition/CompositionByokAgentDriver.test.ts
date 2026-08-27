import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@codework/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import type { CompositionAgentServiceShape } from "./CompositionAgentService.ts";
import { makeCompositionByokAgentDriver } from "./CompositionByokAgentDriver.ts";

const task = {
  taskId: "task-byok",
  projectId: "project-1",
  threadId: "thread-byok",
  assigneeKind: "agent" as const,
  assigneeId: "provider:byok",
  mode: "serial" as const,
  status: "queued" as const,
  promptDigest: "sha256:prompt",
  dependsOnTaskIds: [],
  createdAtUnixMs: 1,
  updatedAtUnixMs: 1,
};

const run = {
  runId: "run-byok",
  taskId: task.taskId,
  agentId: "provider:byok",
  runtimeId: "provider:byok",
  status: "queued" as const,
  attempt: 1,
  capabilityGrantIds: ["grant-read"],
};

const tools = [
  {
    canonicalToolName: "workspace.read_file",
    description: "读取文件",
    parameters: { type: "object" },
  },
];

const start = (driver: ReturnType<typeof makeCompositionByokAgentDriver>) =>
  driver.startTask({
    task,
    run,
    prompt: "检查工作区",
    workspaceRoot: "C:/workspace",
    model: "openai/gpt-5",
  });

describe("CompositionByokAgentDriver", () => {
  it("把 BYOK Agent Loop 投影成真实 Driver，并将终态事件归属到同一个 run", async () => {
    const calls: Array<Parameters<CompositionAgentServiceShape["run"]>[0]> = [];
    const service: CompositionAgentServiceShape = {
      run: (input) => {
        calls.push(input);
        return Effect.succeed({ text: "完成", messages: [], rounds: 1 });
      },
    };
    const driver = makeCompositionByokAgentDriver({
      agentId: "provider:byok",
      runtimeId: "provider:byok",
      providerInstanceId: "byok",
      providerKind: "byok",
      agentService: service,
      listTools: () => Effect.succeed(tools),
    });

    const eventsFiber = Effect.runFork(Stream.runCollect(Stream.take(driver.streamEvents!(), 3)));
    await Effect.runPromise(start(driver));
    const events = await Effect.runPromise(Fiber.join(eventsFiber));

    expect(calls[0]).toMatchObject({
      providerInstanceId: "byok",
      runtimeId: "provider:byok",
      modelId: "openai/gpt-5",
      taskId: task.taskId,
      runId: run.runId,
      agentId: run.agentId,
      workspaceRoot: "C:/workspace",
      prompt: "检查工作区",
      capabilityGrantIds: run.capabilityGrantIds,
      tools,
    });
    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "content.delta",
      "turn.completed",
    ]);
    expect(driver.resolveRuntimeEvent?.(events[2]!)).toEqual({
      taskId: task.taskId,
      runId: run.runId,
      runtimeTaskId: "provider:byok:task:task-byok:run-byok",
    });
  });

  it("重建后的 BYOK Driver 仅凭本地关联元数据恢复持久化终态事件", async () => {
    const service: CompositionAgentServiceShape = {
      run: () => Effect.succeed({ text: "完成", messages: [], rounds: 1 }),
    };
    const options = {
      agentId: "provider:byok",
      runtimeId: "provider:byok",
      providerInstanceId: "byok",
      agentService: service,
      listTools: () => Effect.succeed(tools),
    };
    const driver = makeCompositionByokAgentDriver(options);
    const eventsFiber = Effect.runFork(Stream.runCollect(Stream.take(driver.streamEvents!(), 3)));
    await Effect.runPromise(start(driver));
    const events = await Effect.runPromise(Fiber.join(eventsFiber));
    const recoveredDriver = makeCompositionByokAgentDriver(options);

    expect(recoveredDriver.resolvePersistedRuntimeEvent?.(events[2]!)).toEqual({
      runtimeId: "provider:byok",
      runtimeTaskId: "provider:byok:task:task-byok:run-byok",
    });
    expect(events[2]?.raw).toEqual({
      source: "composition.byok.agent-loop",
      runtimeId: "provider:byok",
      runtimeTaskId: "provider:byok:task:task-byok:run-byok",
      payload: {},
    });
    expect(
      recoveredDriver.resolvePersistedRuntimeEvent?.({
        ...events[2]!,
        raw: {
          ...events[2]!.raw!,
          source: "ide.jsonrpc",
        },
      }),
    ).toBeUndefined();
    expect(
      recoveredDriver.resolvePersistedRuntimeEvent?.({
        ...events[2]!,
        raw: {
          ...events[2]!.raw!,
          runtimeId: "provider:other",
        },
      }),
    ).toBeUndefined();
    expect(
      recoveredDriver.resolvePersistedRuntimeEvent?.({
        ...events[2]!,
        provider: ProviderDriverKind.make("cursor"),
      }),
    ).toBeUndefined();
  });

  it("取消正在运行的 BYOK Loop，并发出 turn.aborted 而不是成功终态", async () => {
    const release = Effect.runSync(Deferred.make<void>());
    const started = Effect.runSync(Deferred.make<void>());
    let signal: AbortSignal | undefined;
    const service: CompositionAgentServiceShape = {
      run: (input) => {
        signal = input.signal;
        return Deferred.succeed(started, void 0).pipe(
          Effect.flatMap(() => Deferred.await(release)),
          Effect.as({ text: "不会完成", messages: [], rounds: 1 }),
        );
      },
    };
    const driver = makeCompositionByokAgentDriver({
      agentId: "provider:byok",
      runtimeId: "provider:byok",
      providerInstanceId: "byok",
      agentService: service,
      listTools: () => Effect.succeed(tools),
    });

    const eventsFiber = Effect.runFork(Stream.runCollect(Stream.take(driver.streamEvents!(), 2)));
    await Effect.runPromise(start(driver));
    await Effect.runPromise(Deferred.await(started));
    await expect(
      Effect.runPromise(
        driver.cancelTask({ task, run: { ...run, status: "running" }, reason: "用户取消" }),
      ),
    ).resolves.toEqual({ status: "cancelled" });
    expect(signal?.aborted).toBe(true);
    const events = await Effect.runPromise(Fiber.join(eventsFiber));

    expect(events.map((event) => event.type)).toEqual(["turn.started", "turn.aborted"]);
    expect(driver.resolveRuntimeEvent?.(events[1]!)).toEqual({
      taskId: task.taskId,
      runId: run.runId,
      runtimeTaskId: "provider:byok:task:task-byok:run-byok",
    });
  });

  it("没有 prompt 或 model 时拒绝启动，不创建后台执行", async () => {
    let called = false;
    const service: CompositionAgentServiceShape = {
      run: () =>
        Effect.sync(() => {
          called = true;
          return { text: "", messages: [], rounds: 1 };
        }),
    };
    const driver = makeCompositionByokAgentDriver({
      agentId: "provider:byok",
      runtimeId: "provider:byok",
      providerInstanceId: "byok",
      agentService: service,
      listTools: () => Effect.succeed(tools),
    });

    await expect(
      Effect.runPromise(driver.startTask({ task, run, prompt: "", workspaceRoot: "C:/workspace" })),
    ).rejects.toMatchObject({ code: "task_prompt_missing" });
    await expect(
      Effect.runPromise(
        driver.startTask({ task, run, prompt: "检查", workspaceRoot: "C:/workspace" }),
      ),
    ).rejects.toMatchObject({ code: "byok_model_missing" });
    expect(called).toBe(false);
  });

  it("暴露 BYOK 已验证的 ToolBroker 能力，但不伪造外部 handshake", async () => {
    const service: CompositionAgentServiceShape = {
      run: () => Effect.succeed({ text: "", messages: [], rounds: 1 }),
    };
    const driver = makeCompositionByokAgentDriver({
      agentId: "provider:byok",
      runtimeId: "provider:byok",
      providerInstanceId: "byok",
      providerKind: "byok",
      agentService: service,
      listTools: () => Effect.succeed(tools),
    });

    await expect(Effect.runPromise(driver.getProfile!())).resolves.toMatchObject({
      driverKind: "provider",
      providerKind: "byok",
      status: "available",
      supportsToolBroker: true,
      supportsCapabilityHandshake: false,
      supportsWorkspace: true,
      supportsProviderApi: true,
      supportsMcp: false,
    });
  });
});
