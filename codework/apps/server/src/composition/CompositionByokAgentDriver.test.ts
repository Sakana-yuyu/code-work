import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  ProviderDriverKind,
  type CompositionTaskEvent,
  type ProviderRuntimeEvent,
} from "@codework/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import {
  CompositionAgentServiceError,
  type CompositionAgentServiceInput,
  type CompositionAgentServiceShape,
} from "./CompositionAgentService.ts";
import { makeCompositionByokAgentDriver } from "./CompositionByokAgentDriver.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import type { CompositionTaskStoreShape } from "../persistence/Services/CompositionTaskStore.ts";

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

const makeCheckpointLedger = (actions: string[] = []) => {
  const events = new Map<string, CompositionTaskEvent>();
  const store = {
    appendEventIfNew: (event) =>
      Effect.sync(() => {
        const key = `${event.taskId}:${event.runId}:${event.sourceEventId}`;
        actions.push(`persist:${event.sourceEventId}`);
        if (events.has(key)) return false;
        events.set(key, event);
        return true;
      }),
  } satisfies Pick<CompositionTaskStoreShape, "appendEventIfNew">;
  return { events, store };
};

const persistCheckpoint = (
  input: CompositionAgentServiceInput,
  checkpoint: Parameters<NonNullable<CompositionAgentServiceInput["onTextCheckpoint"]>>[0],
) =>
  input.onTextCheckpoint!(checkpoint).pipe(
    Effect.mapError(
      (error) =>
        new CompositionAgentServiceError({
          code: error.code,
          detail: error.detail,
        }),
    ),
  );

const start = (driver: ReturnType<typeof makeCompositionByokAgentDriver>) =>
  driver.startTask({
    task,
    run,
    prompt: "检查工作区",
    workspaceRoot: "C:/workspace",
    model: "openai/gpt-5",
  });

const collectUntilTerminal = (driver: ReturnType<typeof makeCompositionByokAgentDriver>) =>
  driver.streamEvents!().pipe(
    Stream.takeUntil((event) => event.type === "turn.completed" || event.type === "turn.aborted"),
    Stream.runCollect,
  );

describe("CompositionByokAgentDriver", () => {
  it("BYOK 进程内 activeRuns 丢失后保持启动恢复 fail-closed", () => {
    const checkpointLedger = makeCheckpointLedger();
    const driver = makeCompositionByokAgentDriver({
      agentId: "provider:byok-recovery-policy",
      runtimeId: "provider:byok-recovery-policy",
      providerInstanceId: "byok-recovery-policy",
      providerKind: "byok",
      agentService: {
        run: () => Effect.die("恢复策略测试不应启动 Agent Loop"),
      },
      checkpointStore: checkpointLedger.store,
      listTools: () => Effect.succeed(tools),
    });

    expect(driver.startRecoveryPolicy).toEqual({
      mode: "fail-closed",
      reasonCode: "byok_start_replay_unsafe",
      requiredReceipt: "runtime-task",
    });
  });

  it("把 BYOK Agent Loop 投影成真实 Driver，并将终态事件归属到同一个 run", async () => {
    const calls: Array<Parameters<CompositionAgentServiceShape["run"]>[0]> = [];
    const service: CompositionAgentServiceShape = {
      run: (input) => {
        calls.push(input);
        return Effect.succeed({ text: "完成", messages: [], rounds: 1 });
      },
    };
    const checkpointLedger = makeCheckpointLedger();
    const driver = makeCompositionByokAgentDriver({
      agentId: "provider:byok",
      runtimeId: "provider:byok",
      providerInstanceId: "byok",
      providerKind: "byok",
      agentService: service,
      checkpointStore: checkpointLedger.store,
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
      checkpointStore: makeCheckpointLedger().store,
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
    const checkpointLedger = makeCheckpointLedger();
    const driver = makeCompositionByokAgentDriver({
      agentId: "provider:byok",
      runtimeId: "provider:byok",
      providerInstanceId: "byok",
      agentService: service,
      checkpointStore: checkpointLedger.store,
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

  effectIt.effect("完成已认领终态后，迟到取消返回 already_terminal 且不再发 aborted", () =>
    Effect.gen(function* () {
      const terminal = yield* Deferred.make<void>();
      const observed = new Array<ProviderRuntimeEvent>();
      let cancelResult:
        | { readonly status: "cancelled" | "cancel_requested" | "already_terminal" }
        | undefined;
      const service: CompositionAgentServiceShape = {
        run: () => Effect.succeed({ text: "完成", messages: [], rounds: 1 }),
      };
      const checkpointLedger = makeCheckpointLedger();
      const driver = makeCompositionByokAgentDriver({
        agentId: "provider:byok",
        runtimeId: "provider:byok",
        providerInstanceId: "byok",
        agentService: service,
        checkpointStore: checkpointLedger.store,
        listTools: () => Effect.succeed(tools),
      });
      const eventsFiber = yield* Stream.runForEach(driver.streamEvents!(), (event) =>
        Effect.gen(function* () {
          observed.push(event);
          if (event.type === "content.delta") {
            cancelResult = yield* driver.cancelTask({
              task,
              run: { ...run, status: "running" },
              reason: "迟到取消",
            });
          }
          if (event.type === "turn.completed" || event.type === "turn.aborted") {
            yield* Deferred.succeed(terminal, void 0);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* start(driver);
      yield* Deferred.await(terminal);
      yield* Fiber.interrupt(eventsFiber);

      expect(cancelResult).toEqual({ status: "already_terminal" });
      expect(observed.map((event) => event.type)).toEqual([
        "turn.started",
        "content.delta",
        "turn.completed",
      ]);
    }),
  );

  it("没有 prompt 或 model 时拒绝启动，不创建后台执行", async () => {
    let called = false;
    const service: CompositionAgentServiceShape = {
      run: () =>
        Effect.sync(() => {
          called = true;
          return { text: "", messages: [], rounds: 1 };
        }),
    };
    const checkpointLedger = makeCheckpointLedger();
    const driver = makeCompositionByokAgentDriver({
      agentId: "provider:byok",
      runtimeId: "provider:byok",
      providerInstanceId: "byok",
      agentService: service,
      checkpointStore: checkpointLedger.store,
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
    const checkpointLedger = makeCheckpointLedger();
    const driver = makeCompositionByokAgentDriver({
      agentId: "provider:byok",
      runtimeId: "provider:byok",
      providerInstanceId: "byok",
      providerKind: "byok",
      agentService: service,
      checkpointStore: checkpointLedger.store,
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

  effectIt.effect("文本 checkpoint 先落盘再发布，成功结果只补发尚未保存的后缀", () =>
    Effect.gen(function* () {
      const actions: string[] = [];
      const checkpointLedger = makeCheckpointLedger(actions);
      const service: CompositionAgentServiceShape = {
        run: (input) =>
          Effect.gen(function* () {
            yield* persistCheckpoint(input, {
              turn: 1,
              chunkIndex: 0,
              delta: "部",
              cumulativeUtf8Bytes: 3,
            });
            return { text: "部分", messages: [], rounds: 1 };
          }),
      };
      const driver = makeCompositionByokAgentDriver({
        agentId: "provider:byok",
        runtimeId: "provider:byok",
        providerInstanceId: "byok",
        agentService: service,
        checkpointStore: checkpointLedger.store,
        listTools: () => Effect.succeed(tools),
      });
      const eventsFiber = yield* driver.streamEvents!().pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            if (event.type === "content.delta") {
              actions.push(`publish:${event.eventId}`);
            }
          }),
        ),
        Stream.takeUntil(
          (event) => event.type === "turn.completed" || event.type === "turn.aborted",
        ),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* start(driver);
      const events = yield* Fiber.join(eventsFiber);
      const contentEvents = events.filter((event) => event.type === "content.delta");

      expect(contentEvents.map((event) => event.payload.delta)).toEqual(["部", "分"]);
      expect([...checkpointLedger.events.values()].map((event) => event.outputDelta)).toEqual([
        "部",
        "分",
      ]);
      for (const event of contentEvents) {
        expect(actions.indexOf(`persist:${event.eventId}`)).toBeLessThan(
          actions.indexOf(`publish:${event.eventId}`),
        );
      }
    }),
  );

  effectIt.effect("同一文本 checkpoint 重放时只保存并发布一次", () =>
    Effect.gen(function* () {
      const checkpointLedger = makeCheckpointLedger();
      const checkpoint = {
        turn: 1,
        chunkIndex: 0,
        delta: "部分输出",
        cumulativeUtf8Bytes: 12,
      } as const;
      const service: CompositionAgentServiceShape = {
        run: (input) =>
          Effect.gen(function* () {
            yield* persistCheckpoint(input, checkpoint);
            yield* persistCheckpoint(input, checkpoint);
            return { text: checkpoint.delta, messages: [], rounds: 1 };
          }),
      };
      const driver = makeCompositionByokAgentDriver({
        agentId: "provider:byok",
        runtimeId: "provider:byok",
        providerInstanceId: "byok",
        agentService: service,
        checkpointStore: checkpointLedger.store,
        listTools: () => Effect.succeed(tools),
      });
      const eventsFiber = yield* collectUntilTerminal(driver).pipe(Effect.forkChild);

      yield* start(driver);
      const events = yield* Fiber.join(eventsFiber);

      expect(events.map((event) => event.type)).toEqual([
        "turn.started",
        "content.delta",
        "turn.completed",
      ]);
      expect(checkpointLedger.events.size).toBe(1);
    }),
  );

  effectIt.effect("截断前的正文可由共享账本恢复，重建 Driver 后不重复发布 checkpoint", () =>
    Effect.gen(function* () {
      const checkpointLedger = makeCheckpointLedger();
      const service: CompositionAgentServiceShape = {
        run: (input) =>
          Effect.gen(function* () {
            yield* persistCheckpoint(input, {
              turn: 1,
              chunkIndex: 0,
              delta: "部分",
              cumulativeUtf8Bytes: 6,
            });
            yield* persistCheckpoint(input, {
              turn: 1,
              chunkIndex: 1,
              delta: "输出",
              cumulativeUtf8Bytes: 12,
            });
            return yield* new CompositionAgentServiceError({
              code: "output_truncated",
              detail: "模型输出被截断",
            });
          }),
      };
      const options = {
        agentId: "provider:byok",
        runtimeId: "provider:byok",
        providerInstanceId: "byok",
        agentService: service,
        checkpointStore: checkpointLedger.store,
        listTools: () => Effect.succeed(tools),
      };
      const driver = makeCompositionByokAgentDriver(options);
      const firstEventsFiber = yield* collectUntilTerminal(driver).pipe(Effect.forkChild);

      yield* start(driver);
      const firstEvents = yield* Fiber.join(firstEventsFiber);
      const recoveredDriver = makeCompositionByokAgentDriver(options);
      const recoveredEventsFiber = yield* collectUntilTerminal(recoveredDriver).pipe(
        Effect.forkChild,
      );
      yield* start(recoveredDriver);
      const recoveredEvents = yield* Fiber.join(recoveredEventsFiber);

      expect(firstEvents.filter((event) => event.type === "content.delta")).toHaveLength(2);
      expect(firstEvents.at(-1)).toMatchObject({
        type: "turn.completed",
        payload: { state: "failed" },
      });
      expect(firstEvents).not.toContainEqual(
        expect.objectContaining({ type: "turn.completed", payload: { state: "completed" } }),
      );
      expect([...checkpointLedger.events.values()].map((event) => event.outputDelta).join("")).toBe(
        "部分输出",
      );
      expect(recoveredEvents.map((event) => event.type)).toEqual([
        "turn.started",
        "runtime.error",
        "turn.completed",
      ]);
    }),
  );

  effectIt.effect("把稳定失败码和错误类别写入 runtime.error", () =>
    Effect.gen(function* () {
      const checkpointLedger = makeCheckpointLedger();
      const driver = makeCompositionByokAgentDriver({
        agentId: "provider:byok",
        runtimeId: "provider:byok",
        providerInstanceId: "byok",
        agentService: {
          run: () =>
            Effect.fail(
              new CompositionAgentServiceError({
                code: "temporary_model_failure",
                detail: "Provider 暂时不可用",
              }),
            ),
        },
        checkpointStore: checkpointLedger.store,
        listTools: () => Effect.succeed(tools),
      });
      const eventsFiber = yield* collectUntilTerminal(driver).pipe(Effect.forkChild);

      yield* start(driver);
      const events = yield* Fiber.join(eventsFiber);

      expect(events.find((event) => event.type === "runtime.error")).toMatchObject({
        type: "runtime.error",
        payload: {
          class: "transport_error",
          detail: { failureCode: "temporary_model_failure" },
        },
      });
    }),
  );

  effectIt.effect("checkpoint 持久化失败时显式失败且不发布未落盘正文", () =>
    Effect.gen(function* () {
      const service: CompositionAgentServiceShape = {
        run: (input) =>
          persistCheckpoint(input, {
            turn: 1,
            chunkIndex: 0,
            delta: "不能丢失",
            cumulativeUtf8Bytes: 12,
          }).pipe(Effect.as({ text: "不能丢失", messages: [], rounds: 1 })),
      };
      const driver = makeCompositionByokAgentDriver({
        agentId: "provider:byok",
        runtimeId: "provider:byok",
        providerInstanceId: "byok",
        agentService: service,
        checkpointStore: {
          appendEventIfNew: () =>
            Effect.fail(
              new PersistenceSqlError({
                operation: "CompositionTaskStore.appendEventIfNew",
                detail: "测试持久化失败",
              }),
            ),
        },
        listTools: () => Effect.succeed(tools),
      });
      const eventsFiber = yield* collectUntilTerminal(driver).pipe(Effect.forkChild);

      yield* start(driver);
      const events = yield* Fiber.join(eventsFiber);

      expect(events.map((event) => event.type)).toEqual([
        "turn.started",
        "runtime.error",
        "turn.completed",
      ]);
      expect(events.at(-1)).toMatchObject({
        type: "turn.completed",
        payload: {
          state: "failed",
          errorMessage: expect.stringContaining("byok_checkpoint_persistence_failed"),
        },
      });
    }),
  );
});
