import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

import type { CompositionTask, CompositionTaskRun } from "@codework/contracts";
import {
  makeCompositionRuntimeToolBridge,
  type CompositionRuntimeToolBridgeDependencies,
} from "./CompositionRuntimeToolBridge.ts";
import type { ToolBrokerInput } from "./ToolBroker.ts";

const task: CompositionTask = {
  taskId: "task-tool-bridge",
  projectId: "project-1",
  assigneeKind: "agent",
  assigneeId: "agent-tool-bridge",
  mode: "serial",
  status: "running",
  promptDigest: "sha256:tool-bridge",
  dependsOnTaskIds: [],
  createdAtUnixMs: 1,
  updatedAtUnixMs: 1,
};

const run: CompositionTaskRun = {
  taskId: task.taskId,
  runId: "run-tool-bridge",
  agentId: task.assigneeId,
  runtimeId: "runtime-tool-bridge",
  capabilityHandshakeId: "handshake-tool-bridge",
  status: "running",
  attempt: 1,
  capabilityGrantIds: ["grant-tool-read"],
};

const input = {
  schemaVersion: 1 as const,
  runtimeId: run.runtimeId,
  taskId: task.taskId,
  runId: run.runId,
  agentId: run.agentId,
  capabilityHandshakeId: run.capabilityHandshakeId,
  toolCallId: "tool-call-1",
  canonicalToolName: "workspace.read_file",
  arguments: { cwd: "C:/workspace/tool-bridge", relativePath: "README.md" },
  idempotencyKey: "tool-idempotency-1",
  capabilityGrantIds: ["grant-tool-read"],
};

const makeDependencies = (
  overrides: Partial<CompositionRuntimeToolBridgeDependencies> = {},
): CompositionRuntimeToolBridgeDependencies => ({
  taskStore: {
    getTask: () => Effect.succeed(Option.some(task)),
    getRun: () => Effect.succeed(Option.some(run)),
  },
  inputStore: {
    get: () =>
      Effect.succeed(
        Option.some({
          taskId: task.taskId,
          prompt: "继续任务",
          workspaceRoot: "C:/workspace/tool-bridge",
        }),
      ),
  },
  toolBroker: {
    invoke: (request) =>
      Effect.succeed({
        invocationId: `invocation-${request.idempotencyKey}`,
        taskId: request.taskId,
        runId: request.runId,
        toolCallId: request.toolCallId,
        canonicalToolName: request.canonicalToolName,
        status: "succeeded" as const,
        result: { contents: "ok" },
      }),
    cancel: () => Effect.void,
  },
  ...overrides,
});

it.effect("通过 Code Work scope 校验后把请求转成 canonical ToolBroker result", () =>
  Effect.gen(function* () {
    const bridge = makeCompositionRuntimeToolBridge(makeDependencies());

    const result = yield* bridge.invoke(input);

    assert.equal(result.status, "succeeded");
    assert.equal(result.taskId, task.taskId);
    assert.equal(result.runId, run.runId);
  }),
);

it.effect("只把持久化 workspaceRoot 传给 ToolBroker", () =>
  Effect.gen(function* () {
    let captured: ToolBrokerInput | undefined;
    const bridge = makeCompositionRuntimeToolBridge(
      makeDependencies({
        toolBroker: {
          invoke: (request) => {
            captured = request;
            return Effect.succeed({
              invocationId: `invocation-${request.idempotencyKey}`,
              taskId: request.taskId,
              runId: request.runId,
              toolCallId: request.toolCallId,
              canonicalToolName: request.canonicalToolName,
              status: "succeeded" as const,
              result: { contents: "ok" },
            });
          },
          cancel: () => Effect.void,
        },
      }),
    );

    const result = yield* bridge.invoke({
      ...input,
      arguments: { cwd: "C:/runtime-controlled-path", relativePath: "README.md" },
      idempotencyKey: "tool-idempotency-trusted-workspace",
    });

    assert.equal(result.status, "succeeded");
    assert.deepEqual(captured?.arguments, {
      cwd: "C:/workspace/tool-bridge",
      relativePath: "README.md",
    });
    assert.equal(captured?.runtimeId, run.runtimeId);
    assert.equal(captured?.threadId, task.threadId);
  }),
);

it.effect("拒绝 runtime、handshake 或 grant 与 Run 不匹配的请求", () =>
  Effect.gen(function* () {
    const bridge = makeCompositionRuntimeToolBridge(makeDependencies());

    const runtimeMismatch = yield* bridge.invoke({
      ...input,
      runtimeId: "runtime-other",
      idempotencyKey: "tool-idempotency-runtime-mismatch",
    });
    const handshakeMismatch = yield* bridge.invoke({
      ...input,
      capabilityHandshakeId: "handshake-other",
      idempotencyKey: "tool-idempotency-handshake-mismatch",
    });
    const grantMismatch = yield* bridge.invoke({
      ...input,
      capabilityGrantIds: ["grant-other"],
      idempotencyKey: "tool-idempotency-grant-mismatch",
    });

    assert.deepEqual(
      [runtimeMismatch.errorCode, handshakeMismatch.errorCode, grantMismatch.errorCode],
      ["runtime_scope_mismatch", "capability_handshake_mismatch", "capability_scope_mismatch"],
    );
    assert.isTrue(
      [runtimeMismatch, handshakeMismatch, grantMismatch].every(
        (result) => result.status === "denied",
      ),
    );
  }),
);

it.effect("缺少持久化 workspaceRoot 时拒绝调用而不信任外部路径", () =>
  Effect.gen(function* () {
    const bridge = makeCompositionRuntimeToolBridge(
      makeDependencies({ inputStore: { get: () => Effect.succeed(Option.none()) } }),
    );

    const result = yield* bridge.invoke(input);

    assert.deepEqual(result, {
      invocationId: "invocation-tool-idempotency-1",
      taskId: task.taskId,
      runId: run.runId,
      toolCallId: input.toolCallId,
      canonicalToolName: input.canonicalToolName,
      status: "denied",
      errorCode: "workspace_input_missing",
    });
  }),
);

it.effect("未知 invocation 的取消请求不会污染 ToolBroker 全局 key", () =>
  Effect.gen(function* () {
    const bridge = makeCompositionRuntimeToolBridge(makeDependencies());

    const result = yield* bridge.cancel({ ...input, idempotencyKey: "tool-cancel-1" });

    assert.deepEqual(result, {
      invocationId: "invocation-tool-cancel-1",
      taskId: task.taskId,
      runId: run.runId,
      toolCallId: input.toolCallId,
      canonicalToolName: input.canonicalToolName,
      status: "denied",
      errorCode: "tool_invocation_not_found",
    });
  }),
);

it.effect("取消同一 scope 的在途 invocation 会中断 ToolBroker 调用", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const bridge = makeCompositionRuntimeToolBridge(
      makeDependencies({
        toolBroker: {
          invoke: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return {
                invocationId: `invocation-${input.idempotencyKey}`,
                taskId: task.taskId,
                runId: run.runId,
                toolCallId: input.toolCallId,
                canonicalToolName: input.canonicalToolName,
                status: "succeeded" as const,
              };
            }),
          cancel: () => Effect.die("不应绕过 Bridge 的 scope 取消"),
        },
      }),
    );

    const fiber = yield* Effect.forkChild(bridge.invoke(input));
    yield* Deferred.await(entered);

    const cancelResult = yield* bridge.cancel(input);
    assert.equal(cancelResult.status, "cancelled");
    const invokeResult = yield* Fiber.join(fiber);
    assert.equal(invokeResult.status, "cancelled");
  }),
);

it.effect("同 scope 同幂等键的第二次调用不替换原取消所有权", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let invocations = 0;
    const bridge = makeCompositionRuntimeToolBridge(
      makeDependencies({
        toolBroker: {
          invoke: () => {
            invocations += 1;
            if (invocations > 1) {
              return Effect.succeed({
                invocationId: `invocation-${input.idempotencyKey}`,
                taskId: task.taskId,
                runId: run.runId,
                toolCallId: input.toolCallId,
                canonicalToolName: input.canonicalToolName,
                status: "succeeded" as const,
              });
            }
            return Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              return yield* Effect.never;
            });
          },
          cancel: () => Effect.die("Bridge 不应绕过 scope 所有权直接取消 Broker"),
        },
      }),
    );

    const first = yield* Effect.forkChild(bridge.invoke(input));
    yield* Deferred.await(entered);

    const duplicate = yield* bridge.invoke(input);
    assert.equal(duplicate.status, "failed");
    assert.equal(duplicate.errorCode, "tool_invocation_in_progress");
    assert.equal(invocations, 1);

    const cancelResult = yield* bridge.cancel(input);
    assert.equal(cancelResult.status, "cancelled");
    const firstResult = yield* Fiber.join(first);
    assert.equal(firstResult.status, "cancelled");

    const replayed = yield* bridge.invoke(input);
    assert.equal(replayed.status, "succeeded");
    assert.equal(invocations, 2);
  }),
);

it.effect("workspace 查询期间被中断不会泄漏 active invocation", () =>
  Effect.gen(function* () {
    const inputLookupEntered = yield* Deferred.make<void>();
    let inputLookups = 0;
    const bridge = makeCompositionRuntimeToolBridge(
      makeDependencies({
        inputStore: {
          get: () => {
            inputLookups += 1;
            if (inputLookups === 1) {
              return Effect.gen(function* () {
                yield* Deferred.succeed(inputLookupEntered, undefined);
                return yield* Effect.never;
              });
            }
            return Effect.succeed(
              Option.some({
                taskId: task.taskId,
                prompt: "继续任务",
                workspaceRoot: "C:/workspace/tool-bridge",
              }),
            );
          },
        },
      }),
    );

    const interrupted = yield* Effect.forkChild(bridge.invoke(input));
    yield* Deferred.await(inputLookupEntered);
    yield* Fiber.interrupt(interrupted);

    const replayed = yield* bridge.invoke(input);
    assert.equal(replayed.status, "succeeded");
    assert.equal(inputLookups, 2);
  }),
);

it.effect("workspace 查询阶段取消会中断查询且不启动 ToolBroker", () =>
  Effect.gen(function* () {
    const inputLookupEntered = yield* Deferred.make<void>();
    const inputLookupCleanupStarted = yield* Deferred.make<void>();
    const releaseInputLookupCleanup = yield* Deferred.make<void>();
    const cancellationCompleted = yield* Deferred.make<void>();
    let brokerInvocations = 0;
    const bridge = makeCompositionRuntimeToolBridge(
      makeDependencies({
        inputStore: {
          get: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(inputLookupEntered, undefined);
              return yield* Effect.never;
            }).pipe(
              Effect.onInterrupt(() =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(inputLookupCleanupStarted, undefined);
                  yield* Deferred.await(releaseInputLookupCleanup);
                }),
              ),
            ),
        },
        toolBroker: {
          invoke: () => {
            brokerInvocations += 1;
            return Effect.succeed({
              invocationId: `invocation-${input.idempotencyKey}`,
              taskId: task.taskId,
              runId: run.runId,
              toolCallId: input.toolCallId,
              canonicalToolName: input.canonicalToolName,
              status: "succeeded" as const,
            });
          },
          cancel: () => Effect.die("Bridge 不应绕过 scope 所有权直接取消 Broker"),
        },
      }),
    );

    const invoked = yield* Effect.forkChild(bridge.invoke(input));
    yield* Deferred.await(inputLookupEntered);
    const cancellation = yield* Effect.forkChild(
      bridge
        .cancel(input)
        .pipe(
          Effect.ensuring(Deferred.succeed(cancellationCompleted, undefined).pipe(Effect.asVoid)),
        ),
    );
    yield* Deferred.await(inputLookupCleanupStarted);

    assert.isTrue(Option.isNone(yield* Deferred.poll(cancellationCompleted)));
    assert.equal(brokerInvocations, 0);

    yield* Deferred.succeed(releaseInputLookupCleanup, undefined);

    const cancelResult = yield* Fiber.join(cancellation);
    const invokeResult = yield* Fiber.join(invoked);
    assert.deepEqual(cancelResult, invokeResult);
    assert.equal(cancelResult.status, "cancelled");
    assert.equal(brokerInvocations, 0);
  }),
);

it.effect("非中断缺陷会原样传播并释放同 key 的 active invocation", () =>
  Effect.gen(function* () {
    let brokerInvocations = 0;
    const bridge = makeCompositionRuntimeToolBridge(
      makeDependencies({
        toolBroker: {
          invoke: (request) => {
            brokerInvocations += 1;
            if (brokerInvocations === 1) return Effect.die("tool-broker-defect");
            return Effect.succeed({
              invocationId: `invocation-${request.idempotencyKey}`,
              taskId: request.taskId,
              runId: request.runId,
              toolCallId: request.toolCallId,
              canonicalToolName: request.canonicalToolName,
              status: "succeeded" as const,
            });
          },
          cancel: () => Effect.die("Bridge 不应绕过 scope 所有权直接取消 Broker"),
        },
      }),
    );

    const first = yield* Effect.exit(bridge.invoke(input));
    assert.equal(first._tag, "Failure");

    const replayed = yield* bridge.invoke(input);
    assert.equal(replayed.status, "succeeded");
    assert.equal(brokerInvocations, 2);
  }),
);

it.effect("cancel 等待 Broker 中断清理并与 invoke 共享终态", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const cleanupStarted = yield* Deferred.make<void>();
    const releaseCleanup = yield* Deferred.make<void>();
    const cancellationCompleted = yield* Deferred.make<void>();
    const bridge = makeCompositionRuntimeToolBridge(
      makeDependencies({
        toolBroker: {
          invoke: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              return yield* Effect.never;
            }).pipe(
              Effect.onInterrupt(() =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(cleanupStarted, undefined);
                  yield* Deferred.await(releaseCleanup);
                }),
              ),
            ),
          cancel: () => Effect.die("Bridge 不应绕过 scope 所有权直接取消 Broker"),
        },
      }),
    );

    const invoked = yield* Effect.forkChild(bridge.invoke(input));
    yield* Deferred.await(entered);
    const cancellation = yield* Effect.forkChild(
      bridge
        .cancel(input)
        .pipe(
          Effect.ensuring(Deferred.succeed(cancellationCompleted, undefined).pipe(Effect.asVoid)),
        ),
    );
    yield* Deferred.await(cleanupStarted);

    assert.isTrue(Option.isNone(yield* Deferred.poll(cancellationCompleted)));

    yield* Deferred.succeed(releaseCleanup, undefined);
    const cancelResult = yield* Fiber.join(cancellation);
    const invokeResult = yield* Fiber.join(invoked);
    assert.deepEqual(cancelResult, invokeResult);
    assert.equal(cancelResult.status, "cancelled");
  }),
);

it.effect("不同 scope 不能取消另一个 Agent 的在途 invocation", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const bridge = makeCompositionRuntimeToolBridge(
      makeDependencies({
        taskStore: {
          getTask: () => Effect.succeed(Option.some(task)),
          getRun: (runId) => Effect.succeed(Option.some({ ...run, runId })),
        },
        toolBroker: {
          invoke: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              return yield* Effect.never.pipe(
                Effect.as({
                  invocationId: `invocation-${input.idempotencyKey}`,
                  taskId: task.taskId,
                  runId: run.runId,
                  toolCallId: input.toolCallId,
                  canonicalToolName: input.canonicalToolName,
                  status: "succeeded" as const,
                }),
              );
            }),
          cancel: () => Effect.die("不应调用 ToolBroker.cancel"),
        },
      }),
    );

    const fiber = yield* Effect.forkChild(bridge.invoke(input));
    yield* Deferred.await(entered);
    const result = yield* bridge.cancel({ ...input, runId: "run-other" });
    assert.equal(result.status, "denied");
    assert.equal(result.errorCode, "tool_invocation_scope_mismatch");
    yield* Fiber.interrupt(fiber);
  }),
);
