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
} from "./CompositionOrchestratorRunStartTestSupport.ts";
import { seedDispatchingStart } from "./CompositionRetryRunStartDispatchRecoveryTestSupport.ts";

const layer = it.layer(compositionOrchestratorRunStartTestLayer);

layer("Composition Retry Run Start Concurrent Recovery", (it) => {
  it.effect("并发恢复者在另一实例已 settled 后采用同一持久赢家", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-concurrent-recovery-winner",
        previousRunId: "run-concurrent-recovery-winner-old",
        runId: "run-concurrent-recovery-winner-new",
        agentId: "agent-concurrent-recovery-winner",
        runtimeId: "runtime-concurrent-recovery-winner",
        prompt: "验证并发恢复采用已结算赢家",
        workspaceRoot: "C:/workspace/concurrent-recovery-winner",
      };
      const seeded = yield* seedDispatchingStart({ store, runStartStore, ...input });

      const firstStarted = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const releaseSecond = yield* Deferred.make<void>();
      let startCalls = 0;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: {
          mode: "idempotent-replay",
          capabilityGrantReplay: { mode: "verified" },
          requiredReceipt: "runtime-task",
        },
        startTask: () =>
          Effect.gen(function* () {
            startCalls += 1;
            const currentCall = startCalls;
            yield* Deferred.succeed(
              currentCall === 1 ? firstStarted : secondStarted,
              undefined,
            );
            yield* Deferred.await(currentCall === 1 ? releaseFirst : releaseSecond);
            return { runtimeTaskId: "runtime-task-concurrent-recovery-winner" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const inputStore = makeRunStartRecoveryInputStore(
        input.taskId,
        input.prompt,
        input.workspaceRoot,
      );
      const firstOrchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        inputStore,
        runStartStore,
      );
      const secondOrchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        inputStore,
        runStartStore,
      );

      const firstFiber = yield* firstOrchestrator
        .recoverRunStart(seeded.request)
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstStarted);
      const secondFiber = yield* Effect.result(
        secondOrchestrator.recoverRunStart(seeded.request),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(secondStarted);

      yield* Deferred.succeed(releaseFirst, undefined);
      const firstResult = yield* Fiber.join(firstFiber);
      assert.equal(firstResult.run.runtimeTaskId, "runtime-task-concurrent-recovery-winner");
      assert.equal(
        Option.getOrThrow(yield* runStartStore.getStart(input.runId)).state,
        "settled",
      );

      yield* Deferred.succeed(releaseSecond, undefined);
      const secondResult = yield* Fiber.join(secondFiber);
      assert.equal(secondResult._tag, "Success");
      if (secondResult._tag === "Success") {
        assert.equal(secondResult.success.task.status, "running");
        assert.equal(secondResult.success.run.status, "running");
        assert.equal(
          secondResult.success.run.runtimeTaskId,
          "runtime-task-concurrent-recovery-winner",
        );
      }
      assert.equal(startCalls, 2);
    }),
  );
});
