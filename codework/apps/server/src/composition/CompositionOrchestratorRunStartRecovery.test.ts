import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import {
  CompositionRunStartStore,
  type CompositionRunStartStoreShape,
} from "../persistence/Services/CompositionRunStartStore.ts";
import {
  CompositionTaskStore,
  type CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import { makeCompositionOrchestrator } from "./CompositionOrchestrator.ts";
import {
  compositionOrchestratorRunStartTestLayer,
  makeRunStartRecoveryInputStore,
  makeRunStartRetryRequest,
  seedFailedRunStart,
} from "./CompositionOrchestratorRunStartTestSupport.ts";

const layer = it.layer(compositionOrchestratorRunStartTestLayer);

const runtimeTaskPolicy = {
  mode: "idempotent-replay" as const,
  capabilityGrantReplay: { mode: "verified" as const },
  requiredReceipt: "runtime-task" as const,
};

layer("CompositionOrchestrator Run Start Recovery", (it) => {
  it.effect("启动前投影失败会回滚并允许同一 runId 安全重试", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const taskId = "task-run-start-projection-rollback";
      const previousRunId = "run-start-projection-rollback-old";
      const runId = "run-start-projection-rollback-new";
      const agentId = "agent-run-start-projection-rollback";
      const runtimeId = "runtime-run-start-projection-rollback";
      yield* seedFailedRunStart(store, { taskId, previousRunId, agentId, runtimeId });

      let startCalls = 0;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId,
        runtimeId,
        startRecoveryPolicy: runtimeTaskPolicy,
        startTask: () =>
          Effect.sync(() => {
            startCalls += 1;
            return { runtimeTaskId: "runtime-task-run-start-projection-rollback" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const inputStore = makeRunStartRecoveryInputStore(
        taskId,
        "继续执行投影回滚测试",
        "C:/workspace/run-start-projection-rollback",
      );
      let failQueuedRunProjection = true;
      const failingStore: CompositionTaskStoreShape = {
        ...store,
        upsertRun: (run) =>
          run.runId === runId && run.status === "queued" && failQueuedRunProjection
            ? Effect.sync(() => {
                failQueuedRunProjection = false;
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new PersistenceSqlError({
                      operation: "CompositionOrchestratorRunStartRecovery.test.upsertQueuedRun",
                      detail: "模拟 queued Task 已写入后 Run 投影失败",
                    }),
                  ),
                ),
              )
            : store.upsertRun(run),
      };
      const first = makeCompositionOrchestrator(
        failingStore,
        driverRegistry,
        undefined,
        inputStore,
        runStartStore,
      );
      const second = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        inputStore,
        runStartStore,
      );
      const request = makeRunStartRetryRequest(taskId, previousRunId, runId);

      const firstAttempt = yield* Effect.result(first.retryTask(request));
      const taskAfterFailure = Option.getOrThrow(yield* store.getTask(taskId));
      const runAfterFailure = yield* store.getRun(runId);
      const intentAfterFailure = Option.getOrThrow(yield* runStartStore.getStart(runId));
      const recovered = yield* second.retryTask(request);

      assert.equal(firstAttempt._tag, "Failure");
      assert.equal(taskAfterFailure.status, "failed");
      assert.isTrue(Option.isNone(runAfterFailure));
      assert.equal(intentAfterFailure.state, "prepared");
      assert.equal(intentAfterFailure.claimId, null);
      assert.equal(startCalls, 1);
      assert.equal(recovered.task.status, "running");
      assert.equal(recovered.run.status, "running");
      assert.equal(Option.getOrThrow(yield* runStartStore.getStart(runId)).state, "settled");
    }),
  );

  it.effect("Driver accepted 后投影失败时第二实例只补齐持久状态而不再次启动", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const taskId = "task-run-start-accepted";
      const previousRunId = "run-start-accepted-old";
      const runId = "run-start-accepted-new";
      const agentId = "agent-run-start-accepted";
      const runtimeId = "runtime-run-start-accepted";
      yield* seedFailedRunStart(store, { taskId, previousRunId, agentId, runtimeId });

      let startCalls = 0;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId,
        runtimeId,
        startRecoveryPolicy: runtimeTaskPolicy,
        startTask: () =>
          Effect.sync(() => {
            startCalls += 1;
            return {
              runtimeTaskId: "runtime-task-run-start-accepted",
              capabilityHandshakeId: "handshake-run-start-accepted",
            };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const inputStore = makeRunStartRecoveryInputStore(
        taskId,
        "继续执行 accepted 恢复测试",
        "C:/workspace/run-start-accepted",
      );
      let failRunningProjection = true;
      const failingStore: CompositionTaskStoreShape = {
        ...store,
        upsertTask: (task) =>
          task.status === "running" && failRunningProjection
            ? Effect.sync(() => {
                failRunningProjection = false;
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new PersistenceSqlError({
                      operation: "CompositionOrchestratorRunStartRecovery.test.persistStartedRun",
                      detail: "模拟 Driver accepted 后 running 投影失败",
                    }),
                  ),
                ),
              )
            : store.upsertTask(task),
      };
      const first = makeCompositionOrchestrator(
        failingStore,
        driverRegistry,
        undefined,
        inputStore,
        runStartStore,
      );
      const recoveryRegistry = makeCompositionAgentDriverRegistry();
      yield* recoveryRegistry.register({
        agentId,
        runtimeId,
        startRecoveryPolicy: runtimeTaskPolicy,
        startTask: () => Effect.die("accepted intent 恢复不得再次启动 Driver"),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const second = makeCompositionOrchestrator(
        store,
        recoveryRegistry,
        undefined,
        inputStore,
        runStartStore,
      );
      const request = makeRunStartRetryRequest(taskId, previousRunId, runId);

      const firstAttempt = yield* Effect.result(first.retryTask(request));
      const accepted = Option.getOrThrow(yield* runStartStore.getStart(runId));
      const recovered = yield* second.retryTask(request);

      assert.equal(firstAttempt._tag, "Failure");
      assert.equal(accepted.state, "accepted");
      assert.equal(accepted.runtimeTaskId, "runtime-task-run-start-accepted");
      assert.equal(startCalls, 1);
      assert.equal(recovered.task.status, "running");
      assert.equal(recovered.run.status, "running");
      assert.equal(recovered.run.runtimeTaskId, "runtime-task-run-start-accepted");
      assert.equal(recovered.run.capabilityHandshakeId, "handshake-run-start-accepted");
      assert.equal(Option.getOrThrow(yield* runStartStore.getStart(runId)).state, "settled");
    }),
  );

  it.effect("accepted receipt 未提交时标记未知并禁止再次启动 Driver", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const taskId = "task-run-start-accept-failed";
      const previousRunId = "run-start-accept-failed-old";
      const runId = "run-start-accept-failed-new";
      const agentId = "agent-run-start-accept-failed";
      const runtimeId = "runtime-run-start-accept-failed";
      yield* seedFailedRunStart(store, { taskId, previousRunId, agentId, runtimeId });

      let startCalls = 0;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId,
        runtimeId,
        startRecoveryPolicy: runtimeTaskPolicy,
        startTask: () =>
          Effect.sync(() => {
            startCalls += 1;
            return { runtimeTaskId: "runtime-task-run-start-accept-failed" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const failingRunStartStore: CompositionRunStartStoreShape = {
        ...runStartStore,
        markAccepted: () =>
          Effect.fail(
            new PersistenceSqlError({
              operation: "CompositionOrchestratorRunStartRecovery.test.markAccepted",
              detail: "模拟 accepted receipt 提交前失败",
            }),
          ),
      };
      const first = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        makeRunStartRecoveryInputStore(
          taskId,
          "继续执行 accepted receipt 失败测试",
          "C:/workspace/run-start-accept-failed",
        ),
        failingRunStartStore,
      );
      const second = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        undefined,
        runStartStore,
      );
      const request = makeRunStartRetryRequest(taskId, previousRunId, runId);

      const firstAttempt = yield* Effect.result(first.retryTask(request));
      const intent = Option.getOrThrow(yield* runStartStore.getStart(runId));
      const replay = yield* Effect.result(second.retryTask(request));

      assert.equal(firstAttempt._tag, "Failure");
      assert.equal(intent.state, "indeterminate");
      assert.equal(intent.outcomeCode, "driver_acceptance_receipt_persist_failed");
      assert.equal(replay._tag, "Failure");
      if (replay._tag === "Failure") {
        assert.equal(replay.failure._tag, "CompositionTaskRetryInvalidError");
        if (replay.failure._tag === "CompositionTaskRetryInvalidError") {
          assert.equal(
            replay.failure.reason,
            "run_start_indeterminate_driver_acceptance_receipt_persist_failed",
          );
        }
      }
      assert.equal(startCalls, 1);
    }),
  );

  it.effect("running 已投影但 settle 失败时恢复不会重复追加运行事件", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const taskId = "task-run-start-settle-recovery";
      const previousRunId = "run-start-settle-recovery-old";
      const runId = "run-start-settle-recovery-new";
      const agentId = "agent-run-start-settle-recovery";
      const runtimeId = "runtime-run-start-settle-recovery";
      yield* seedFailedRunStart(store, { taskId, previousRunId, agentId, runtimeId });

      let startCalls = 0;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId,
        runtimeId,
        startRecoveryPolicy: runtimeTaskPolicy,
        startTask: () =>
          Effect.sync(() => {
            startCalls += 1;
            return {
              runtimeTaskId: "runtime-task-run-start-settle-recovery",
              capabilityHandshakeId: "handshake-run-start-settle-recovery",
            };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const inputStore = makeRunStartRecoveryInputStore(
        taskId,
        "继续执行 settle 恢复测试",
        "C:/workspace/run-start-settle-recovery",
      );
      let failSettle = true;
      const failingRunStartStore: CompositionRunStartStoreShape = {
        ...runStartStore,
        settleStart: (input) =>
          failSettle
            ? Effect.sync(() => {
                failSettle = false;
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new PersistenceSqlError({
                      operation: "CompositionOrchestratorRunStartRecovery.test.settleStart",
                      detail: "模拟 running 投影提交后 settle 写入失败",
                    }),
                  ),
                ),
              )
            : runStartStore.settleStart(input),
      };
      const first = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        inputStore,
        failingRunStartStore,
      );
      const recoveryRegistry = makeCompositionAgentDriverRegistry();
      yield* recoveryRegistry.register({
        agentId,
        runtimeId,
        startRecoveryPolicy: runtimeTaskPolicy,
        startTask: () => Effect.die("accepted intent 恢复不得再次启动 Driver"),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const second = makeCompositionOrchestrator(
        store,
        recoveryRegistry,
        undefined,
        inputStore,
        runStartStore,
      );
      const request = makeRunStartRetryRequest(taskId, previousRunId, runId);

      const firstAttempt = yield* Effect.result(first.retryTask(request));
      const accepted = Option.getOrThrow(yield* runStartStore.getStart(runId));
      const recovered = yield* second.retryTask(request);
      const runningEvents = (yield* store.listEvents(taskId, runId)).filter(
        (event) => event.status === "running",
      );

      assert.equal(firstAttempt._tag, "Failure");
      assert.equal(accepted.state, "accepted");
      assert.equal(startCalls, 1);
      assert.equal(recovered.task.status, "running");
      assert.equal(recovered.run.status, "running");
      assert.equal(runningEvents.length, 1);
      assert.equal(Option.getOrThrow(yield* runStartStore.getStart(runId)).state, "settled");
    }),
  );
});
