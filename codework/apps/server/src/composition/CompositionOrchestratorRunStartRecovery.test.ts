import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import { makeCompositionOrchestrator } from "./CompositionOrchestrator.ts";
import { CompositionRunStartStoreLive } from "../persistence/Layers/CompositionRunStartStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import {
  CompositionRunStartStore,
  type CompositionRunStartStoreShape,
} from "../persistence/Services/CompositionRunStartStore.ts";
import type { CompositionTaskInputStoreShape } from "../persistence/Services/CompositionTaskInputStore.ts";
import {
  CompositionTaskStore,
  type CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";

const layer = it.layer(
  Layer.mergeAll(CompositionTaskStoreLive, CompositionRunStartStoreLive).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const ids = (suffix: string) => ({
  taskId: `task-run-start-${suffix}`,
  previousRunId: `run-start-${suffix}-old`,
  runId: `run-start-${suffix}-new`,
  agentId: `agent-run-start-${suffix}`,
  runtimeId: `runtime-run-start-${suffix}`,
});

const seedQueuedRetry = (store: CompositionTaskStoreShape, suffix: string) =>
  Effect.gen(function* () {
    const identity = ids(suffix);
    yield* store.upsertTask({
      taskId: identity.taskId,
      projectId: "project-run-start-recovery",
      assigneeKind: "agent",
      assigneeId: identity.agentId,
      mode: "serial",
      status: "queued",
      promptDigest: `sha256:${suffix}`,
      dependsOnTaskIds: [],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 3,
    });
    yield* store.upsertRun({
      taskId: identity.taskId,
      runId: identity.previousRunId,
      agentId: identity.agentId,
      runtimeId: identity.runtimeId,
      status: "failed",
      attempt: 1,
      capabilityGrantIds: [`grant-${suffix}-old`],
    });
    yield* store.upsertRun({
      taskId: identity.taskId,
      runId: identity.runId,
      agentId: identity.agentId,
      runtimeId: identity.runtimeId,
      status: "queued",
      attempt: 2,
      capabilityGrantIds: [`grant-${suffix}-new`],
    });
    return identity;
  });

const inputStore = (taskId: string): CompositionTaskInputStoreShape => ({
  save: () => Effect.void,
  get: (requestedTaskId) =>
    Effect.succeed(
      requestedTaskId === taskId
        ? Option.some({
            taskId,
            prompt: `恢复 ${taskId}`,
            workspaceRoot: `C:/workspace/${taskId}`,
          })
        : Option.none(),
    ),
  remove: () => Effect.void,
});

const retryInput = (identity: ReturnType<typeof ids>) => ({
  taskId: identity.taskId,
  previousRunId: identity.previousRunId,
  runId: identity.runId,
  reason: "恢复已排队的重试 Run",
  capabilityIds: ["t3.workspace.read_file"],
});

const prepareStartIntent = (
  store: CompositionRunStartStoreShape,
  identity: ReturnType<typeof ids>,
  replayPolicy: "idempotent" | "fail_closed",
) =>
  store.prepareStart({
    runId: identity.runId,
    taskId: identity.taskId,
    agentId: identity.agentId,
    runtimeId: identity.runtimeId,
    attempt: 2,
    replayPolicy,
    createdAtUnixMs: 100,
  });

const prepareAndClaim = (
  store: CompositionRunStartStoreShape,
  identity: ReturnType<typeof ids>,
  replayPolicy: "idempotent" | "fail_closed",
) =>
  Effect.gen(function* () {
    yield* prepareStartIntent(store, identity, replayPolicy);
    yield* store.claimStart({
      runId: identity.runId,
      claimId: `claim-${identity.runId}`,
      claimedAtUnixMs: 110,
    });
  });

layer("CompositionOrchestrator Run Start 恢复", (it) => {
  it.effect("两个 Orchestrator 共享持久 claim 时只有一个 Driver 启动赢家", () =>
    Effect.gen(function* () {
      const taskStore = yield* CompositionTaskStore;
      const startStore = yield* CompositionRunStartStore;
      const identity = yield* seedQueuedRetry(taskStore, "cross-instance");
      yield* prepareStartIntent(startStore, identity, "fail_closed");
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      let startCalls = 0;
      const registry = makeCompositionAgentDriverRegistry();
      yield* registry.register({
        agentId: identity.agentId,
        runtimeId: identity.runtimeId,
        startTask: () =>
          Effect.gen(function* () {
            startCalls += 1;
            if (startCalls === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
            }
            return { runtimeTaskId: `runtime-task-${startCalls}` };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const inputs = inputStore(identity.taskId);
      const firstOrchestrator = makeCompositionOrchestrator(
        taskStore,
        registry,
        undefined,
        inputs,
        startStore,
      );
      const secondOrchestrator = makeCompositionOrchestrator(
        taskStore,
        registry,
        undefined,
        inputs,
        startStore,
      );

      const first = yield* Effect.forkChild(firstOrchestrator.retryTask(retryInput(identity)));
      yield* Deferred.await(firstStarted);
      const concurrent = yield* Effect.result(secondOrchestrator.retryTask(retryInput(identity)));
      assert.equal(concurrent._tag, "Failure");
      if (concurrent._tag === "Failure") {
        assert.equal(concurrent.failure._tag, "CompositionTaskRetryInvalidError");
        if (concurrent.failure._tag === "CompositionTaskRetryInvalidError") {
          assert.equal(concurrent.failure.reason, "retry_dispatch_in_progress");
        }
      }
      assert.equal(Option.getOrThrow(yield* taskStore.getTask(identity.taskId)).status, "queued");
      assert.equal(Option.getOrThrow(yield* taskStore.getRun(identity.runId)).status, "queued");

      yield* Deferred.succeed(releaseFirst, undefined);
      const completed = yield* Fiber.join(first);
      assert.equal(completed.run.status, "running");
      assert.equal(startCalls, 1);
    }),
  );

  it.effect("Driver accepted 后 receipt 落库失败时保留 queued 与 dispatching claim", () =>
    Effect.gen(function* () {
      const taskStore = yield* CompositionTaskStore;
      const realStartStore = yield* CompositionRunStartStore;
      const identity = yield* seedQueuedRetry(taskStore, "accepted-persist-failure");
      yield* prepareStartIntent(realStartStore, identity, "fail_closed");
      let startCalls = 0;
      const registry = makeCompositionAgentDriverRegistry();
      yield* registry.register({
        agentId: identity.agentId,
        runtimeId: identity.runtimeId,
        startTask: () =>
          Effect.sync(() => {
            startCalls += 1;
            return { runtimeTaskId: "runtime-task-accepted-persist-failure" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const failingStartStore: CompositionRunStartStoreShape = {
        ...realStartStore,
        markAccepted: () =>
          Effect.fail(
            new PersistenceSqlError({
              operation: "CompositionRunStartStore.markAccepted:test",
              detail: "模拟 accepted receipt 持久化失败",
            }),
          ),
      };
      const orchestrator = makeCompositionOrchestrator(
        taskStore,
        registry,
        undefined,
        inputStore(identity.taskId),
        failingStartStore,
      );

      const result = yield* Effect.result(orchestrator.retryTask(retryInput(identity)));

      assert.equal(result._tag, "Failure");
      assert.equal(startCalls, 1);
      assert.equal(Option.getOrThrow(yield* taskStore.getTask(identity.taskId)).status, "queued");
      assert.equal(Option.getOrThrow(yield* taskStore.getRun(identity.runId)).status, "queued");
      assert.equal(Option.getOrThrow(yield* realStartStore.getStart(identity.runId)).state, "dispatching");
    }),
  );

  it.effect("默认非幂等 Driver 遇到缺失 start intent 的旧 queued Run 时 fail-closed", () =>
    Effect.gen(function* () {
      const taskStore = yield* CompositionTaskStore;
      const startStore = yield* CompositionRunStartStore;
      const identity = yield* seedQueuedRetry(taskStore, "legacy-missing-intent");
      let startCalls = 0;
      const registry = makeCompositionAgentDriverRegistry();
      yield* registry.register({
        agentId: identity.agentId,
        runtimeId: identity.runtimeId,
        startTask: () =>
          Effect.sync(() => {
            startCalls += 1;
            return { runtimeTaskId: "must-not-start" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        taskStore,
        registry,
        undefined,
        inputStore(identity.taskId),
        startStore,
      );

      const result = yield* Effect.result(orchestrator.retryTask(retryInput(identity)));

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "CompositionTaskRetryInvalidError");
        if (result.failure._tag === "CompositionTaskRetryInvalidError") {
          assert.equal(result.failure.reason, "start_result_indeterminate");
        }
      }
      assert.equal(startCalls, 0);
      assert.isTrue(Option.isNone(yield* startStore.getStart(identity.runId)));
      assert.equal(Option.getOrThrow(yield* taskStore.getRun(identity.runId)).status, "queued");
    }),
  );

  it.effect("非幂等 Driver 的遗留 claim 恢复为 indeterminate 并拒绝再次启动", () =>
    Effect.gen(function* () {
      const taskStore = yield* CompositionTaskStore;
      const startStore = yield* CompositionRunStartStore;
      const identity = yield* seedQueuedRetry(taskStore, "fail-closed");
      yield* prepareAndClaim(startStore, identity, "fail_closed");
      yield* startStore.recoverInterruptedStarts({ recoveredAtUnixMs: 200 });
      let startCalls = 0;
      const registry = makeCompositionAgentDriverRegistry();
      yield* registry.register({
        agentId: identity.agentId,
        runtimeId: identity.runtimeId,
        startTask: () =>
          Effect.sync(() => {
            startCalls += 1;
            return { runtimeTaskId: "must-not-start" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        taskStore,
        registry,
        undefined,
        inputStore(identity.taskId),
        startStore,
      );

      const result = yield* Effect.result(orchestrator.retryTask(retryInput(identity)));

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "CompositionTaskRetryInvalidError");
        if (result.failure._tag === "CompositionTaskRetryInvalidError") {
          assert.equal(result.failure.reason, "start_result_indeterminate");
        }
      }
      assert.equal(startCalls, 0);
      assert.equal(Option.getOrThrow(yield* taskStore.getRun(identity.runId)).status, "queued");
    }),
  );

  it.effect("已有 accepted receipt 时完成 running 投影且不再次调用 Driver", () =>
    Effect.gen(function* () {
      const taskStore = yield* CompositionTaskStore;
      const startStore = yield* CompositionRunStartStore;
      const identity = yield* seedQueuedRetry(taskStore, "accepted-receipt");
      yield* prepareAndClaim(startStore, identity, "fail_closed");
      yield* startStore.markAccepted({
        runId: identity.runId,
        claimId: `claim-${identity.runId}`,
        runtimeTaskId: "runtime-task-from-receipt",
        capabilityHandshakeId: "handshake-from-receipt",
        acceptedAtUnixMs: 120,
      });
      let startCalls = 0;
      const registry = makeCompositionAgentDriverRegistry();
      yield* registry.register({
        agentId: identity.agentId,
        runtimeId: identity.runtimeId,
        startTask: () =>
          Effect.sync(() => {
            startCalls += 1;
            return { runtimeTaskId: "must-not-restart" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        taskStore,
        registry,
        undefined,
        inputStore(identity.taskId),
        startStore,
      );

      const result = yield* orchestrator.retryTask(retryInput(identity));

      assert.equal(result.run.status, "running");
      assert.equal(result.run.runtimeTaskId, "runtime-task-from-receipt");
      assert.equal(result.run.capabilityHandshakeId, "handshake-from-receipt");
      assert.equal(startCalls, 0);
      assert.equal(Option.getOrThrow(yield* startStore.getStart(identity.runId)).state, "completed");
    }),
  );

  it.effect("明确幂等 Driver 的遗留 claim 恢复后使用同一 Run 重放", () =>
    Effect.gen(function* () {
      const taskStore = yield* CompositionTaskStore;
      const startStore = yield* CompositionRunStartStore;
      const identity = yield* seedQueuedRetry(taskStore, "idempotent-replay");
      yield* prepareAndClaim(startStore, identity, "idempotent");
      yield* startStore.recoverInterruptedStarts({ recoveredAtUnixMs: 200 });
      let startCalls = 0;
      const registry = makeCompositionAgentDriverRegistry();
      yield* registry.register({
        agentId: identity.agentId,
        runtimeId: identity.runtimeId,
        startReplayPolicy: "idempotent",
        startTask: () =>
          Effect.sync(() => {
            startCalls += 1;
            return { runtimeTaskId: "runtime-task-idempotent-replay" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        taskStore,
        registry,
        undefined,
        inputStore(identity.taskId),
        startStore,
      );

      const result = yield* orchestrator.retryTask(retryInput(identity));

      assert.equal(result.run.status, "running");
      assert.equal(result.run.runtimeTaskId, "runtime-task-idempotent-replay");
      assert.equal(startCalls, 1);
      assert.equal(Option.getOrThrow(yield* startStore.getStart(identity.runId)).state, "completed");
    }),
  );
});
