import type { CompositionTaskStatus } from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CompositionGoalLoopRetryStoreLive } from "../persistence/Layers/CompositionGoalLoopRetryStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CompositionGoalLoopRetryStore } from "../persistence/Services/CompositionGoalLoopRetryStore.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { goalLoopEventPrefix } from "./CompositionGoalLoopRunner.ts";
import { settleAndRedispatchInterruptedGoalLoop } from "./CompositionGoalLoopRedispatch.ts";

const layer = it.layer(
  Layer.mergeAll(CompositionTaskStoreLive, CompositionGoalLoopRetryStoreLive).pipe(
    Layer.provide(SqlitePersistenceMemory),
  ),
);

const terminalStatuses = ["failed", "cancelled", "timed_out"] as const satisfies ReadonlyArray<
  CompositionTaskStatus
>;

layer("Composition Goal Loop Redispatch Started Status", (it) => {
  for (const terminalStatus of terminalStatuses) {
    it.effect(`重派回调落 ${terminalStatus} 时不得视为已启动`, () =>
      Effect.gen(function* () {
        const store = yield* CompositionTaskStore;
        const retryStore = yield* CompositionGoalLoopRetryStore;
        const taskId = `task-goal-terminal-${terminalStatus}`;
        const previousRunId = `run-goal-terminal-${terminalStatus}-old`;
        const newRunId = `run-goal-terminal-${terminalStatus}-new`;
        yield* store.upsertTask({
          taskId,
          projectId: "project-goal-terminal",
          assigneeKind: "agent",
          assigneeId: "agent-goal-terminal",
          mode: "serial",
          status: "running",
          promptDigest: `sha256:goal-terminal-${terminalStatus}`,
          dependsOnTaskIds: [],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 2,
        });
        yield* store.upsertRun({
          taskId,
          runId: previousRunId,
          agentId: "agent-goal-terminal",
          runtimeId: "runtime-goal-terminal",
          status: "running",
          attempt: 1,
          capabilityGrantIds: [],
        });
        yield* store.appendEventIfNew({
          taskId,
          runId: previousRunId,
          agentId: "agent-goal-terminal",
          runtimeId: "runtime-goal-terminal",
          sourceEventId: `${goalLoopEventPrefix(taskId, previousRunId)}:start`,
          status: "running",
          sequence: 0,
          eventType: "status",
          summary: "目标循环开始",
        });
        yield* store.appendEventIfNew({
          taskId,
          runId: previousRunId,
          agentId: "agent-goal-terminal",
          runtimeId: "runtime-goal-terminal",
          sourceEventId: `${goalLoopEventPrefix(taskId, previousRunId)}:round:1`,
          status: "running",
          sequence: 0,
          eventType: "status",
          summary: "第 1 轮",
        });

        const result = yield* Effect.result(
          settleAndRedispatchInterruptedGoalLoop({
            taskId,
            runId: previousRunId,
            newRunId,
            agentId: "agent-goal-terminal",
            runtimeId: "runtime-goal-terminal",
            store,
            retryStore,
            nowUnixMs: 5_000,
            redispatch: () =>
              store.upsertRun({
                taskId,
                runId: newRunId,
                agentId: "agent-goal-terminal",
                runtimeId: "runtime-goal-terminal",
                status: terminalStatus,
                attempt: 2,
                capabilityGrantIds: [],
                finishedAtUnixMs: 5_001,
                ...(terminalStatus === "cancelled"
                  ? {}
                  : { failureCode: `test_${terminalStatus}` }),
              }).pipe(Effect.asVoid),
          }),
        );

        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(result.failure._tag, "CompositionGoalLoopRedispatchError");
          if (result.failure._tag === "CompositionGoalLoopRedispatchError") {
            assert.equal(result.failure.code, "goal_loop_redispatch_run_not_started");
          }
        }
        assert.equal(
          Option.getOrThrow(yield* retryStore.getIntent(previousRunId)).phase,
          "settled",
        );
      }),
    );
  }
});
