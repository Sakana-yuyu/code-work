import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CompositionRunStartStore } from "../persistence/Services/CompositionRunStartStore.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import { makeCompositionOrchestrator } from "./CompositionOrchestrator.ts";
import {
  compositionOrchestratorRunStartTestLayer,
  makeRunStartRecoveryInputStore,
  makeRunStartRetryRequest,
  seedFailedRunStart,
} from "./CompositionOrchestratorRunStartTestSupport.ts";
import { seedDispatchingStart } from "./CompositionRetryRunStartDispatchRecoveryTestSupport.ts";
import { makeCompositionRunStartDigests } from "./CompositionRunStartLifecycle.ts";

const layer = it.layer(compositionOrchestratorRunStartTestLayer);

const runtimeTaskPolicy = {
  mode: "idempotent-replay" as const,
  capabilityGrantReplay: { mode: "verified" as const },
  requiredReceipt: "runtime-task" as const,
};

layer("Composition Retry Run Start Recover Only", (it) => {
  it.effect("无持久 intent 时稳定失败且不读取恢复输入或产生业务副作用", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-recover-only-missing-intent",
        previousRunId: "run-recover-only-missing-intent-old",
        runId: "run-recover-only-missing-intent-new",
        agentId: "agent-recover-only-missing-intent",
        runtimeId: "runtime-recover-only-missing-intent",
        prompt: "缺少 intent 不得启动恢复",
        workspaceRoot: "C:/workspace/recover-only-missing-intent",
      };
      yield* seedFailedRunStart(store, input);
      const taskBefore = Option.getOrThrow(yield* store.getTask(input.taskId));
      const previousRunBefore = Option.getOrThrow(yield* store.getRun(input.previousRunId));
      let inputReads = 0;
      let startCalls = 0;
      const recoveryInputStore = makeRunStartRecoveryInputStore(
        input.taskId,
        input.prompt,
        input.workspaceRoot,
      );
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: runtimeTaskPolicy,
        startTask: () =>
          Effect.sync(() => {
            startCalls += 1;
            return { runtimeTaskId: "runtime-task-recover-only-missing-intent" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        {
          ...recoveryInputStore,
          get: (taskId) =>
            Effect.sync(() => {
              inputReads += 1;
            }).pipe(Effect.andThen(recoveryInputStore.get(taskId))),
        },
        runStartStore,
      );

      const result = yield* Effect.result(
        orchestrator.recoverRunStart(
          makeRunStartRetryRequest(input.taskId, input.previousRunId, input.runId),
        ),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "CompositionTaskRetryInvalidError");
        if (result.failure._tag === "CompositionTaskRetryInvalidError") {
          assert.equal(result.failure.reason, "run_start_recovery_intent_missing");
        }
      }
      assert.equal(inputReads, 0);
      assert.equal(startCalls, 0);
      assert.deepEqual(Option.getOrThrow(yield* store.getTask(input.taskId)), taskBefore);
      assert.deepEqual(
        Option.getOrThrow(yield* store.getRun(input.previousRunId)),
        previousRunBefore,
      );
      assert.isTrue(Option.isNone(yield* store.getRun(input.runId)));
      assert.isTrue(Option.isNone(yield* runStartStore.getStart(input.runId)));
    }),
  );

  it.effect("prepared intent 允许 claim 并完成一次启动", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-recover-only-prepared",
        previousRunId: "run-recover-only-prepared-old",
        runId: "run-recover-only-prepared-new",
        agentId: "agent-recover-only-prepared",
        runtimeId: "runtime-recover-only-prepared",
        prompt: "prepared intent 可以继续",
        workspaceRoot: "C:/workspace/recover-only-prepared",
      };
      yield* seedFailedRunStart(store, input);
      const request = makeRunStartRetryRequest(input.taskId, input.previousRunId, input.runId);
      const digests = makeCompositionRunStartDigests({
        prompt: input.prompt,
        workspaceRoot: input.workspaceRoot,
        capabilityIds: request.capabilityIds,
      });
      yield* runStartStore.prepareStart({
        runId: input.runId,
        taskId: input.taskId,
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        attempt: 2,
        payloadDigest: digests.payloadDigest,
        capabilityDigest: digests.capabilityDigest,
        createdAtUnixMs: 10,
      });
      let startCalls = 0;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: runtimeTaskPolicy,
        startTask: () =>
          Effect.sync(() => {
            startCalls += 1;
            return { runtimeTaskId: "runtime-task-recover-only-prepared" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        makeRunStartRecoveryInputStore(input.taskId, input.prompt, input.workspaceRoot),
        runStartStore,
      );

      const recovered = yield* orchestrator.recoverRunStart(request);

      assert.equal(startCalls, 1);
      assert.equal(recovered.task.status, "running");
      assert.equal(recovered.run.runtimeTaskId, "runtime-task-recover-only-prepared");
      assert.equal(Option.getOrThrow(yield* runStartStore.getStart(input.runId)).state, "settled");
    }),
  );

  it.effect("accepted intent 只补齐投影而不再次启动 Driver", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-recover-only-accepted",
        previousRunId: "run-recover-only-accepted-old",
        runId: "run-recover-only-accepted-new",
        agentId: "agent-recover-only-accepted",
        runtimeId: "runtime-recover-only-accepted",
        prompt: "accepted intent 只恢复投影",
        workspaceRoot: "C:/workspace/recover-only-accepted",
      };
      const seeded = yield* seedDispatchingStart({ store, runStartStore, ...input });
      const claimId = seeded.dispatching.claimId;
      if (claimId === null) return yield* Effect.die("dispatching seed 缺少 claimId");
      yield* runStartStore.markAccepted({
        runId: input.runId,
        expectedRevision: seeded.dispatching.revision,
        claimId,
        runtimeTaskId: "runtime-task-recover-only-accepted",
        acceptedAtUnixMs: 12,
      });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: runtimeTaskPolicy,
        startTask: () => Effect.die("accepted intent 不得再次启动 Driver"),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        makeRunStartRecoveryInputStore(input.taskId, input.prompt, input.workspaceRoot),
        runStartStore,
      );

      const recovered = yield* orchestrator.recoverRunStart(seeded.request);

      assert.equal(recovered.task.status, "running");
      assert.equal(recovered.run.runtimeTaskId, "runtime-task-recover-only-accepted");
      assert.equal(Option.getOrThrow(yield* runStartStore.getStart(input.runId)).state, "settled");
    }),
  );

  it.effect("settled intent 只读取已完成投影而不再次启动 Driver", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-recover-only-settled",
        previousRunId: "run-recover-only-settled-old",
        runId: "run-recover-only-settled-new",
        agentId: "agent-recover-only-settled",
        runtimeId: "runtime-recover-only-settled",
        prompt: "settled intent 只读恢复",
        workspaceRoot: "C:/workspace/recover-only-settled",
      };
      const seeded = yield* seedDispatchingStart({
        store,
        runStartStore,
        ...input,
        status: "running",
        runtimeTaskId: "runtime-task-recover-only-settled",
      });
      const claimId = seeded.dispatching.claimId;
      if (claimId === null) return yield* Effect.die("dispatching seed 缺少 claimId");
      const accepted = yield* runStartStore.markAccepted({
        runId: input.runId,
        expectedRevision: seeded.dispatching.revision,
        claimId,
        runtimeTaskId: "runtime-task-recover-only-settled",
        acceptedAtUnixMs: 12,
      });
      yield* runStartStore.settleStart({
        runId: input.runId,
        expectedRevision: accepted.revision,
        claimId,
        settledAtUnixMs: 13,
      });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: runtimeTaskPolicy,
        startTask: () => Effect.die("settled intent 不得再次启动 Driver"),
        cancelTask: () => Effect.succeed({ status: "already_terminal" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        makeRunStartRecoveryInputStore(input.taskId, input.prompt, input.workspaceRoot),
        runStartStore,
      );

      const recovered = yield* orchestrator.recoverRunStart(seeded.request);

      assert.equal(recovered.task.status, "running");
      assert.equal(recovered.run.runtimeTaskId, "runtime-task-recover-only-settled");
      assert.equal(Option.getOrThrow(yield* runStartStore.getStart(input.runId)).state, "settled");
    }),
  );

  it.effect("dispatching intent 按幂等策略恢复且只启动一次", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-recover-only-dispatching",
        previousRunId: "run-recover-only-dispatching-old",
        runId: "run-recover-only-dispatching-new",
        agentId: "agent-recover-only-dispatching",
        runtimeId: "runtime-recover-only-dispatching",
        prompt: "dispatching intent 幂等恢复",
        workspaceRoot: "C:/workspace/recover-only-dispatching",
      };
      const seeded = yield* seedDispatchingStart({ store, runStartStore, ...input });
      let startCalls = 0;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: runtimeTaskPolicy,
        startTask: () =>
          Effect.sync(() => {
            startCalls += 1;
            return { runtimeTaskId: "runtime-task-recover-only-dispatching" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        makeRunStartRecoveryInputStore(input.taskId, input.prompt, input.workspaceRoot),
        runStartStore,
      );

      const recovered = yield* orchestrator.recoverRunStart(seeded.request);

      assert.equal(startCalls, 1);
      assert.equal(recovered.task.status, "running");
      assert.equal(recovered.run.runtimeTaskId, "runtime-task-recover-only-dispatching");
      assert.equal(Option.getOrThrow(yield* runStartStore.getStart(input.runId)).state, "settled");
    }),
  );

  it.effect("indeterminate intent 稳定失败且不得再次启动 Driver", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-recover-only-indeterminate",
        previousRunId: "run-recover-only-indeterminate-old",
        runId: "run-recover-only-indeterminate-new",
        agentId: "agent-recover-only-indeterminate",
        runtimeId: "runtime-recover-only-indeterminate",
        prompt: "未知启动结果保持关闭",
        workspaceRoot: "C:/workspace/recover-only-indeterminate",
      };
      const seeded = yield* seedDispatchingStart({ store, runStartStore, ...input });
      const indeterminate = yield* runStartStore.markIndeterminate({
        runId: input.runId,
        expectedRevision: seeded.dispatching.revision,
        claimId: seeded.dispatching.claimId ?? "missing-claim",
        outcomeCode: "test_quarantine",
        indeterminateAtUnixMs: 12,
      });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: runtimeTaskPolicy,
        startTask: () => Effect.die("indeterminate intent 不得再次启动 Driver"),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        makeRunStartRecoveryInputStore(input.taskId, input.prompt, input.workspaceRoot),
        runStartStore,
      );

      const result = yield* Effect.result(orchestrator.recoverRunStart(seeded.request));

      assert.equal(indeterminate.state, "indeterminate");
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "CompositionTaskRetryInvalidError");
        if (result.failure._tag === "CompositionTaskRetryInvalidError") {
          assert.equal(result.failure.reason, "run_start_indeterminate_test_quarantine");
        }
      }
    }),
  );
});
