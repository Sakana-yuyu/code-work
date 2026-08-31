import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PersistenceSqlError } from "../persistence/Errors.ts";
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

layer("Composition Retry Run Start Projected Status", (it) => {
  it.effect("恢复 accepted receipt 时保留等待与审核状态", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;

      for (const status of ["waiting_approval", "waiting_input", "in_review"] as const) {
        const input = {
          taskId: `task-dispatching-${status}`,
          previousRunId: `run-dispatching-${status}-old`,
          runId: `run-dispatching-${status}-new`,
          agentId: `agent-dispatching-${status}`,
          runtimeId: `runtime-dispatching-${status}`,
          prompt: `保留 ${status} 投影`,
          workspaceRoot: `C:/workspace/dispatching-${status}`,
        };
        const seeded = yield* seedDispatchingStart({
          store,
          runStartStore,
          ...input,
          status,
          runtimeTaskId: `runtime-task-dispatching-${status}`,
        });
        const driverRegistry = makeCompositionAgentDriverRegistry();
        yield* driverRegistry.register({
          agentId: input.agentId,
          runtimeId: input.runtimeId,
          startRecoveryPolicy: {
            mode: "reconcile-only",
            after: "provider-sessions.reconcile",
            requiredReceipt: "runtime-task-and-handshake-when-granted",
          },
          startTask: () => Effect.die(`${status} 投影不得再次启动 Driver`),
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
        const intent = Option.getOrThrow(yield* runStartStore.getStart(input.runId));

        assert.equal(recovered.task.status, status);
        assert.equal(recovered.run.status, status);
        assert.equal(recovered.run.runtimeTaskId, `runtime-task-dispatching-${status}`);
        assert.equal(intent.state, "settled");
      }
    }),
  );

  it.effect("跨重启恢复 accepted receipt 时拒绝 blocked 投影", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-dispatching-blocked-race",
        previousRunId: "run-dispatching-blocked-race-old",
        runId: "run-dispatching-blocked-race-new",
        agentId: "agent-dispatching-blocked-race",
        runtimeId: "runtime-dispatching-blocked-race",
        prompt: "blocked 不得作为启动证明",
        workspaceRoot: "C:/workspace/dispatching-blocked-race",
      };
      const seeded = yield* seedDispatchingStart({ store, runStartStore, ...input });
      const claimId = seeded.dispatching.claimId;
      if (claimId === null) return yield* Effect.die("dispatching seed 缺少 claimId");
      yield* runStartStore.markAccepted({
        runId: input.runId,
        expectedRevision: seeded.dispatching.revision,
        claimId,
        runtimeTaskId: "runtime-task-dispatching-blocked-race",
        acceptedAtUnixMs: 12,
      });
      const task = Option.getOrThrow(yield* store.getTask(input.taskId));
      const run = Option.getOrThrow(yield* store.getRun(input.runId));
      yield* store.upsertTask({ ...task, status: "blocked" });
      yield* store.upsertRun({ ...run, status: "blocked" });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: {
          mode: "fail-closed",
          reasonCode: "runtime_start_replay_not_verified",
          requiredReceipt: "runtime-task",
        },
        startTask: () => Effect.die("accepted receipt 恢复不得再次启动 Driver"),
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
      const intent = Option.getOrThrow(yield* runStartStore.getStart(input.runId));
      const recoveredTask = Option.getOrThrow(yield* store.getTask(input.taskId));
      const recoveredRun = Option.getOrThrow(yield* store.getRun(input.runId));

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.instanceOf(result.failure, PersistenceSqlError);
      assert.equal(intent.state, "accepted");
      assert.equal(recoveredTask.status, "blocked");
      assert.equal(recoveredRun.status, "blocked");
      assert.equal(recoveredRun.runtimeTaskId, undefined);
    }),
  );
});
