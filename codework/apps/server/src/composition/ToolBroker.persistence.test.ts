import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import { CompositionToolInvocationStoreLive } from "../persistence/Layers/CompositionToolInvocationStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  CompositionToolInvocationStore,
  type CompositionToolInvocation,
} from "../persistence/Services/CompositionToolInvocationStore.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as CapabilityPolicy from "./CapabilityPolicy.ts";
import * as CapabilityRegistry from "./CapabilityRegistry.ts";
import {
  CompositionToolInvocationCoordinator,
  CompositionToolInvocationCoordinatorError,
  makeCompositionToolInvocationCoordinator,
} from "./CompositionToolInvocationCoordinator.ts";
import {
  CompositionToolInvocationStartupRecovery,
  CompositionToolInvocationStartupRecoveryError,
} from "./CompositionToolInvocationStartupRecovery.ts";
import * as ToolBroker from "./ToolBroker.ts";

const workspaceRoot = "E:/tool-broker-persistence-test";

const inputFor = (idempotencyKey: string): ToolBroker.ToolBrokerInput => ({
  taskId: "task-persistence",
  runId: "run-persistence",
  agentId: "agent-persistence",
  toolCallId: `tool-call-${idempotencyKey}`,
  canonicalToolName: "workspace.read_file",
  arguments: { cwd: workspaceRoot, relativePath: "README.md" },
  idempotencyKey,
  capabilityGrantIds: ["t3.workspace.read_file"],
  workspaceRoot,
});

const readResult = {
  relativePath: "README.md",
  contents: "persisted tool result",
  byteLength: new TextEncoder().encode("persisted tool result").byteLength,
  truncated: false,
};

const successRecovery = CompositionToolInvocationStartupRecovery.of({
  awaitRecovered: Effect.succeed({
    type: "composition.tool_invocations.recovered" as const,
    recoveredAtUnixMs: 100,
    outcomeCode: "process_restarted_result_indeterminate",
    recoveredCount: 0,
    invocations: [],
  }),
});

const invocationFor = (
  input: ToolBroker.ToolBrokerInput,
  status: CompositionToolInvocation["status"],
  outcomeCode: string | null = null,
): CompositionToolInvocation => ({
  idempotencyKey: input.idempotencyKey,
  taskId: input.taskId,
  runId: input.runId,
  agentId: input.agentId,
  toolCallId: input.toolCallId,
  canonicalToolName: input.canonicalToolName,
  operation: "read",
  argumentsDigest: "sha256:arguments",
  scopeDigest: "sha256:scope",
  status,
  revision: status === "prepared" ? 1 : status === "executing" ? 2 : 3,
  outcomeCode,
  createdAtUnixMs: 100,
  updatedAtUnixMs: status === "prepared" ? 100 : status === "executing" ? 110 : 120,
  claimedAtUnixMs: status === "prepared" ? null : 110,
  finishedAtUnixMs: status === "prepared" || status === "executing" ? null : 120,
});

const makeBrokerLayer = <CoordinatorError, RecoveryError>(options: {
  readonly workspaceFileSystem: WorkspaceFileSystem.WorkspaceFileSystem["Service"];
  readonly coordinatorLayer: Layer.Layer<CompositionToolInvocationCoordinator, CoordinatorError>;
  readonly recoveryLayer: Layer.Layer<CompositionToolInvocationStartupRecovery, RecoveryError>;
}) => {
  const capabilityRegistry = CapabilityRegistry.makeCompositionCapabilityRegistry();
  const registryLayer = Layer.succeed(CapabilityRegistry.CapabilityRegistry, capabilityRegistry);
  const policyLayer = Layer.succeed(
    CapabilityPolicy.CapabilityPolicy,
    CapabilityPolicy.makeCompositionCapabilityPolicy({ capabilityRegistry }),
  );
  const workspaceLayer = Layer.succeed(
    WorkspaceFileSystem.WorkspaceFileSystem,
    options.workspaceFileSystem,
  );

  return ToolBroker.persistentLayer.pipe(
    Layer.provide(options.recoveryLayer),
    Layer.provide(options.coordinatorLayer),
    Layer.provide(policyLayer),
    Layer.provide(registryLayer),
    Layer.provide(workspaceLayer),
  );
};

const makeWorkspaceFileSystem = (
  readFile: WorkspaceFileSystem.WorkspaceFileSystem["Service"]["readFile"],
) =>
  WorkspaceFileSystem.WorkspaceFileSystem.of({
    readFile,
    writeFile: () => Effect.die("unused"),
  });

it.effect("同一幂等键并发仅执行一次 handler，完成后重放不重复副作用", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let executions = 0;
    const workspaceFileSystem = makeWorkspaceFileSystem(() =>
      Effect.gen(function* () {
        executions += 1;
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        return readResult;
      }),
    );
    const storeLayer = CompositionToolInvocationStoreLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
    );
    const recoveryLayer = CompositionToolInvocationStartupRecovery.layer.pipe(
      Layer.provide(storeLayer),
    );
    const coordinatorLayer = CompositionToolInvocationCoordinator.layer.pipe(
      Layer.provide(storeLayer),
    );
    const layer = Layer.mergeAll(
      makeBrokerLayer({ workspaceFileSystem, coordinatorLayer, recoveryLayer }),
      storeLayer,
    );
    const input = inputFor("persistent-concurrent");

    yield* Effect.gen(function* () {
      const broker = yield* ToolBroker.ToolBroker;
      const store = yield* CompositionToolInvocationStore;
      const winner = yield* Effect.forkChild(broker.invoke(input));
      yield* Deferred.await(entered);

      const loser = yield* broker.invoke(input);
      assert.equal(loser.status, "failed");
      assert.equal(loser.errorCode, "tool_invocation_in_progress");

      yield* Deferred.succeed(release, undefined);
      const completed = yield* Fiber.join(winner);
      assert.equal(completed.status, "succeeded");

      const replayed = yield* broker.invoke(input);
      assert.equal(replayed.status, "denied");
      assert.equal(replayed.errorCode, "tool_invocation_succeeded_result_unavailable");
      assert.equal(executions, 1);

      const stored = Option.getOrThrow(yield* store.getInvocation(input.idempotencyKey));
      assert.equal(stored.status, "succeeded");
      assert.equal(stored.revision, 3);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("授权拒绝发生在 CAS 之前且不会创建调用记录", () =>
  Effect.gen(function* () {
    let executions = 0;
    const workspaceFileSystem = makeWorkspaceFileSystem(() =>
      Effect.sync(() => {
        executions += 1;
        return readResult;
      }),
    );
    const storeLayer = CompositionToolInvocationStoreLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
    );
    const recoveryLayer = CompositionToolInvocationStartupRecovery.layer.pipe(
      Layer.provide(storeLayer),
    );
    const coordinatorLayer = CompositionToolInvocationCoordinator.layer.pipe(
      Layer.provide(storeLayer),
    );
    const layer = Layer.mergeAll(
      makeBrokerLayer({ workspaceFileSystem, coordinatorLayer, recoveryLayer }),
      storeLayer,
    );
    const input = { ...inputFor("persistent-denied"), capabilityGrantIds: [] };

    yield* Effect.gen(function* () {
      const broker = yield* ToolBroker.ToolBroker;
      const store = yield* CompositionToolInvocationStore;
      const result = yield* broker.invoke(input);

      assert.equal(result.status, "denied");
      assert.equal(result.errorCode, "capability_not_granted");
      assert.equal(executions, 0);
      assert.isTrue(Option.isNone(yield* store.getInvocation(input.idempotencyKey)));
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("恢复或 begin 失败时保持 fail-closed 且不执行 handler", () =>
  Effect.gen(function* () {
    let executions = 0;
    let beginCalls = 0;
    const workspaceFileSystem = makeWorkspaceFileSystem(() =>
      Effect.sync(() => {
        executions += 1;
        return readResult;
      }),
    );
    const storeUnavailable = new PersistenceSqlError({
      operation: "ToolBroker.persistence.test",
      detail: "database unavailable",
    });
    const recoveryFailure = new CompositionToolInvocationStartupRecoveryError({
      cause: storeUnavailable,
    });
    const coordinator = CompositionToolInvocationCoordinator.of({
      begin: () => {
        beginCalls += 1;
        return Effect.fail(
          new CompositionToolInvocationCoordinatorError({
            code: "tool_invocation_store_unavailable",
            phase: "begin",
            cause: storeUnavailable,
          }),
        );
      },
      finish: () => Effect.die("unused"),
    });
    const coordinatorLayer = Layer.succeed(CompositionToolInvocationCoordinator, coordinator);
    const failedRecoveryLayer = Layer.succeed(
      CompositionToolInvocationStartupRecovery,
      CompositionToolInvocationStartupRecovery.of({
        awaitRecovered: Effect.fail(recoveryFailure),
      }),
    );
    const successfulRecoveryLayer = Layer.succeed(
      CompositionToolInvocationStartupRecovery,
      successRecovery,
    );

    const recoveryResult = yield* Effect.gen(function* () {
      const broker = yield* ToolBroker.ToolBroker;
      return yield* broker.invoke(inputFor("persistent-recovery-down"));
    }).pipe(
      Effect.provide(
        makeBrokerLayer({
          workspaceFileSystem,
          coordinatorLayer,
          recoveryLayer: failedRecoveryLayer,
        }),
      ),
    );
    assert.equal(recoveryResult.status, "failed");
    assert.equal(recoveryResult.errorCode, "tool_invocation_store_unavailable");
    assert.equal(beginCalls, 0);
    assert.equal(executions, 0);

    const beginResult = yield* Effect.gen(function* () {
      const broker = yield* ToolBroker.ToolBroker;
      return yield* broker.invoke(inputFor("persistent-begin-down"));
    }).pipe(
      Effect.provide(
        makeBrokerLayer({
          workspaceFileSystem,
          coordinatorLayer,
          recoveryLayer: successfulRecoveryLayer,
        }),
      ),
    );
    assert.equal(beginResult.status, "failed");
    assert.equal(beginResult.errorCode, "tool_invocation_store_unavailable");
    assert.equal(beginCalls, 1);
    assert.equal(executions, 0);
  }),
);

it.effect("handler 已执行但终态保存失败时返回 outcome unknown", () =>
  Effect.gen(function* () {
    let executions = 0;
    const input = inputFor("persistent-finish-down");
    const workspaceFileSystem = makeWorkspaceFileSystem(() =>
      Effect.sync(() => {
        executions += 1;
        return readResult;
      }),
    );
    const storeUnavailable = new PersistenceSqlError({
      operation: "ToolBroker.persistence.test.finish",
      detail: "database unavailable",
    });
    const coordinator = CompositionToolInvocationCoordinator.of({
      begin: () => Effect.succeed({ claimed: true, invocation: invocationFor(input, "executing") }),
      finish: () =>
        Effect.fail(
          new CompositionToolInvocationCoordinatorError({
            code: "tool_invocation_store_unavailable",
            phase: "finish",
            cause: storeUnavailable,
          }),
        ),
    });
    const layer = makeBrokerLayer({
      workspaceFileSystem,
      coordinatorLayer: Layer.succeed(CompositionToolInvocationCoordinator, coordinator),
      recoveryLayer: Layer.succeed(CompositionToolInvocationStartupRecovery, successRecovery),
    });

    const result = yield* Effect.gen(function* () {
      const broker = yield* ToolBroker.ToolBroker;
      return yield* broker.invoke(input);
    }).pipe(Effect.provide(layer));

    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "tool_invocation_outcome_unknown");
    assert.equal(executions, 1);
  }),
);

it.effect("handler 被中断后以 CAS 保存 cancelled 终态", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let executions = 0;
    const workspaceFileSystem = makeWorkspaceFileSystem(() =>
      Effect.gen(function* () {
        executions += 1;
        yield* Deferred.succeed(entered, undefined);
        return yield* Effect.never;
      }),
    );
    const storeLayer = CompositionToolInvocationStoreLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
    );
    const recoveryLayer = CompositionToolInvocationStartupRecovery.layer.pipe(
      Layer.provide(storeLayer),
    );
    const coordinatorLayer = CompositionToolInvocationCoordinator.layer.pipe(
      Layer.provide(storeLayer),
    );
    const layer = Layer.mergeAll(
      makeBrokerLayer({ workspaceFileSystem, coordinatorLayer, recoveryLayer }),
      storeLayer,
    );
    const input = inputFor("persistent-interrupted");

    yield* Effect.gen(function* () {
      const broker = yield* ToolBroker.ToolBroker;
      const store = yield* CompositionToolInvocationStore;
      const fiber = yield* Effect.forkChild(broker.invoke(input));
      yield* Deferred.await(entered);

      yield* Fiber.interrupt(fiber);

      const stored = Option.getOrThrow(yield* store.getInvocation(input.idempotencyKey));
      assert.equal(stored.status, "cancelled");
      assert.equal(stored.outcomeCode, "tool_cancelled");
      assert.equal(stored.revision, 3);
      assert.equal(executions, 1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("handler 已完成时成功终态保存不被随后取消中断", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const releaseHandler = yield* Deferred.make<void>();
    const finishEntered = yield* Deferred.make<void>();
    const releaseFinish = yield* Deferred.make<void>();
    const interruptionStarted = yield* Deferred.make<void>();
    const workspaceFileSystem = makeWorkspaceFileSystem(() =>
      Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(releaseHandler);
        return readResult;
      }),
    );
    const storeLayer = CompositionToolInvocationStoreLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
    );
    const input = inputFor("persistent-success-owns-terminal");

    yield* Effect.gen(function* () {
      const store = yield* CompositionToolInvocationStore;
      const coordinator = yield* makeCompositionToolInvocationCoordinator(store);
      const gatedCoordinator = CompositionToolInvocationCoordinator.of({
        begin: coordinator.begin,
        finish: (finishInput) =>
          finishInput.status !== "succeeded"
            ? coordinator.finish(finishInput)
            : Effect.gen(function* () {
                yield* Deferred.succeed(finishEntered, undefined);
                yield* Deferred.await(releaseFinish);
                return yield* coordinator.finish(finishInput);
              }),
      });
      const layer = makeBrokerLayer({
        workspaceFileSystem,
        coordinatorLayer: Layer.succeed(CompositionToolInvocationCoordinator, gatedCoordinator),
        recoveryLayer: Layer.succeed(CompositionToolInvocationStartupRecovery, successRecovery),
      });

      yield* Effect.gen(function* () {
        const broker = yield* ToolBroker.ToolBroker;
        const fiber = yield* Effect.forkChild(broker.invoke(input));
        yield* Deferred.await(entered);
        yield* Deferred.succeed(releaseHandler, undefined);
        yield* Deferred.await(finishEntered);

        const interruption = yield* Effect.forkChild(
          Deferred.succeed(interruptionStarted, undefined).pipe(
            Effect.andThen(Fiber.interrupt(fiber)),
          ),
        );
        yield* Deferred.await(interruptionStarted);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseFinish, undefined);
        yield* Fiber.join(interruption);

        const stored = Option.getOrThrow(yield* store.getInvocation(input.idempotencyKey));
        assert.equal(stored.status, "succeeded");
        assert.isNull(stored.outcomeCode);
        assert.equal(stored.revision, 3);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(storeLayer));
  }),
);

it.effect("未领取的持久化状态映射稳定且绝不重新执行 handler", () =>
  Effect.gen(function* () {
    let executions = 0;
    const workspaceFileSystem = makeWorkspaceFileSystem(() =>
      Effect.sync(() => {
        executions += 1;
        return readResult;
      }),
    );
    const expected = {
      prepared: ["failed", "tool_invocation_in_progress"],
      executing: ["failed", "tool_invocation_in_progress"],
      succeeded: ["denied", "tool_invocation_succeeded_result_unavailable"],
      failed: ["failed", "persisted_failure"],
      cancelled: ["cancelled", "tool_cancelled"],
      unknown: ["failed", "tool_invocation_outcome_unknown"],
    } as const;
    const coordinator = CompositionToolInvocationCoordinator.of({
      begin: (input) => {
        const status = input.idempotencyKey.replace(
          "persistent-status-",
          "",
        ) as keyof typeof expected;
        return Effect.succeed({
          claimed: false,
          invocation: invocationFor(
            inputFor(input.idempotencyKey),
            status,
            status === "failed" ? "persisted_failure" : null,
          ),
        });
      },
      finish: () => Effect.die("unused"),
    });
    const layer = makeBrokerLayer({
      workspaceFileSystem,
      coordinatorLayer: Layer.succeed(CompositionToolInvocationCoordinator, coordinator),
      recoveryLayer: Layer.succeed(CompositionToolInvocationStartupRecovery, successRecovery),
    });

    yield* Effect.gen(function* () {
      const broker = yield* ToolBroker.ToolBroker;
      for (const [status, [expectedStatus, expectedCode]] of Object.entries(expected)) {
        const result = yield* broker.invoke(inputFor(`persistent-status-${status}`));
        assert.equal(result.status, expectedStatus);
        assert.equal(result.errorCode, expectedCode);
      }
    }).pipe(Effect.provide(layer));

    assert.equal(executions, 0);
  }),
);
