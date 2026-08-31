import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
import { makeCompositionRunStartDigests } from "./CompositionRunStartLifecycle.ts";

const layer = it.layer(compositionOrchestratorRunStartTestLayer);

const runtimeTaskPolicy = {
  mode: "idempotent-replay" as const,
  capabilityGrantReplay: { mode: "verified" as const },
  requiredReceipt: "runtime-task" as const,
};

layer("CompositionOrchestrator Run Start Ownership", (it) => {
  it.effect("两个 Orchestrator 共享 SQLite 时只有持久 claim 赢家启动 Driver", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const taskId = "task-run-start-owner";
      const previousRunId = "run-start-owner-old";
      const runId = "run-start-owner-new";
      const agentId = "agent-run-start-owner";
      const runtimeId = "runtime-run-start-owner";
      const prompt = "继续执行唯一启动测试";
      const workspaceRoot = "C:/workspace/run-start-owner";
      yield* seedFailedRunStart(store, { taskId, previousRunId, agentId, runtimeId });

      let startCalls = 0;
      const startEntered = yield* Deferred.make<void>();
      const allowStartReturn = yield* Deferred.make<void>();
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId,
        runtimeId,
        startRecoveryPolicy: runtimeTaskPolicy,
        startTask: () =>
          Effect.gen(function* () {
            startCalls += 1;
            yield* Deferred.succeed(startEntered, undefined);
            yield* Deferred.await(allowStartReturn);
            return { runtimeTaskId: "runtime-task-run-start-owner" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const inputStore = makeRunStartRecoveryInputStore(taskId, prompt, workspaceRoot);
      const first = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        inputStore,
        runStartStore,
      );
      const second = makeCompositionOrchestrator(
        store,
        makeCompositionAgentDriverRegistry(),
        undefined,
        undefined,
        runStartStore,
      );
      const request = makeRunStartRetryRequest(taskId, previousRunId, runId);

      const firstFiber = yield* first.retryTask(request).pipe(Effect.forkChild);
      yield* Deferred.await(startEntered);
      const competing = yield* Effect.result(second.retryTask(request));
      yield* Deferred.succeed(allowStartReturn, undefined);
      const winner = yield* Fiber.join(firstFiber);

      assert.equal(startCalls, 1);
      assert.equal(winner.run.runId, runId);
      assert.equal(competing._tag, "Failure");
      if (competing._tag === "Failure") {
        assert.equal(competing.failure._tag, "CompositionTaskRetryInvalidError");
        if (competing.failure._tag === "CompositionTaskRetryInvalidError") {
          assert.equal(competing.failure.reason, "run_start_dispatching_recovery_forbidden");
        }
      }
      assert.equal(Option.getOrThrow(yield* runStartStore.getStart(runId)).state, "settled");
    }),
  );

  it.effect("遗留 dispatching 对默认 fail-closed Driver 禁止重放", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const taskId = "task-run-start-fail-closed";
      const previousRunId = "run-start-fail-closed-old";
      const runId = "run-start-fail-closed-new";
      const agentId = "agent-run-start-fail-closed";
      const runtimeId = "runtime-run-start-fail-closed";
      const prompt = "不得重放未知 Driver 启动";
      const workspaceRoot = "C:/workspace/run-start-fail-closed";
      const capabilityIds = ["t3.workspace.read_file"];
      const startDigests = makeCompositionRunStartDigests({
        prompt,
        workspaceRoot,
        capabilityIds,
      });
      yield* seedFailedRunStart(store, { taskId, previousRunId, agentId, runtimeId });
      const prepared = yield* runStartStore.prepareStart({
        runId,
        taskId,
        agentId,
        runtimeId,
        attempt: 2,
        payloadDigest: startDigests.payloadDigest,
        capabilityDigest: startDigests.capabilityDigest,
        createdAtUnixMs: 10,
      });
      yield* runStartStore.claimStart({
        runId,
        expectedRevision: prepared.revision,
        claimId: "legacy-process-claim",
        claimedAtUnixMs: 11,
      });

      let startCalls = 0;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId,
        runtimeId,
        startTask: () =>
          Effect.sync(() => {
            startCalls += 1;
            return { runtimeTaskId: "must-not-replay" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        makeRunStartRecoveryInputStore(taskId, prompt, workspaceRoot),
        runStartStore,
      );

      const failure = yield* orchestrator
        .retryTask({
          ...makeRunStartRetryRequest(taskId, previousRunId, runId),
          capabilityIds,
        })
        .pipe(Effect.flip);

      assert.equal(failure._tag, "CompositionTaskRetryInvalidError");
      if (failure._tag === "CompositionTaskRetryInvalidError") {
        assert.equal(failure.reason, "run_start_dispatching_recovery_forbidden");
      }
      assert.equal(startCalls, 0);
      assert.equal(Option.getOrThrow(yield* runStartStore.getStart(runId)).state, "dispatching");
    }),
  );
});
