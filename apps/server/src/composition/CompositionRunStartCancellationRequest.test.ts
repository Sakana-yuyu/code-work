import type { CompositionTask, CompositionTaskRun } from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CompositionRunStartStoreLive } from "../persistence/Layers/CompositionRunStartStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CompositionRunStartStore } from "../persistence/Services/CompositionRunStartStore.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { makeCompositionRunStartDigests } from "./CompositionRunStartLifecycle.ts";
import { requestCompositionRunStartCancellationBarrier } from "./CompositionRunStartCancellationRequest.ts";

const layer = it.layer(
  Layer.mergeAll(CompositionTaskStoreLive, CompositionRunStartStoreLive).pipe(
    Layer.provide(SqlitePersistenceMemory),
  ),
);

const makeFixture = (suffix: string) => {
  const task: CompositionTask = {
    taskId: `task-run-start-cancel-request-${suffix}`,
    projectId: `project-run-start-cancel-request-${suffix}`,
    assigneeKind: "agent",
    assigneeId: `agent-run-start-cancel-request-${suffix}`,
    mode: "serial",
    status: "queued",
    promptDigest: `sha256:prompt-run-start-cancel-request-${suffix}`,
    dependsOnTaskIds: [],
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
  };
  const run: CompositionTaskRun = {
    taskId: task.taskId,
    runId: `run-run-start-cancel-request-${suffix}`,
    agentId: task.assigneeId,
    runtimeId: `runtime-run-start-cancel-request-${suffix}`,
    status: "queued",
    attempt: 1,
    capabilityGrantIds: [],
  };
  return { task, run };
};

const seedAccepted = Effect.fn("seedAcceptedRunStartCancellationRequest")(function* (
  fixture: ReturnType<typeof makeFixture>,
) {
  const taskStore = yield* CompositionTaskStore;
  const runStartStore = yield* CompositionRunStartStore;
  yield* taskStore.upsertTask(fixture.task);
  yield* taskStore.upsertRun(fixture.run);
  const digests = makeCompositionRunStartDigests({
    taskId: fixture.task.taskId,
    projectId: fixture.task.projectId,
    runId: fixture.run.runId,
    previousRunId: null,
    assigneeKind: fixture.task.assigneeKind,
    assigneeId: fixture.task.assigneeId,
    mode: fixture.task.mode,
    dependsOnTaskIds: fixture.task.dependsOnTaskIds,
    agentId: fixture.run.agentId,
    runtimeId: fixture.run.runtimeId,
    attempt: fixture.run.attempt,
    promptDigest: fixture.task.promptDigest,
    externalTargetIdentity: null,
    capabilityIds: [],
  });
  const prepared = yield* runStartStore.prepareStart({
    taskId: fixture.task.taskId,
    runId: fixture.run.runId,
    previousRunId: null,
    agentId: fixture.run.agentId,
    runtimeId: fixture.run.runtimeId,
    attempt: fixture.run.attempt,
    ...digests,
    createdAtUnixMs: 1,
  });
  const preparing = yield* runStartStore.claimPrepared({
    runId: fixture.run.runId,
    expectedRevision: prepared.revision,
    claimId: `claim-${fixture.run.runId}`,
    claimedAtUnixMs: 2,
    leaseExpiresAtUnixMs: 100,
  });
  const dispatching = yield* runStartStore.markDispatching({
    runId: fixture.run.runId,
    expectedRevision: preparing.intent.revision,
    claimId: preparing.intent.claimId ?? "",
    ownerEpoch: preparing.intent.ownerEpoch,
    dispatchedAtUnixMs: 2,
  });
  return yield* runStartStore.recordAccepted({
    runId: fixture.run.runId,
    expectedRevision: dispatching.revision,
    claimId: dispatching.claimId ?? "",
    ownerEpoch: dispatching.ownerEpoch,
    runtimeTaskId: `runtime-task-${fixture.run.runId}`,
    capabilityHandshakeId: null,
    acceptedAtUnixMs: 3,
  });
});

layer("Composition Run Start 取消请求", (it) => {
  it.effect("accepted 旧取消字段会原子回填持久屏障", () =>
    Effect.gen(function* () {
      const fixture = makeFixture("accepted");
      const taskStore = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      yield* seedAccepted(fixture);
      const cancelledRun = { ...fixture.run, cancelRequestedAtUnixMs: 4 };
      yield* taskStore.upsertRun(cancelledRun);

      const result = yield* requestCompositionRunStartCancellationBarrier(
        taskStore,
        runStartStore,
        {
          task: fixture.task,
          run: cancelledRun,
          reason: "恢复旧取消请求。",
        },
      );

      assert.equal(result._tag, "Requested");
      if (result._tag === "Requested") {
        assert.equal(result.intent.state, "cancel_pending");
        assert.equal(result.intent.cancelSourceState, "accepted");
        assert.equal(result.intent.cancelStartOutcome, "accepted");
        assert.equal(result.intent.cancelRequestedAtUnixMs, 4);
      }
      assert.equal(
        Option.getOrThrow(yield* taskStore.getTask(fixture.task.taskId)).status,
        "queued",
      );
      assert.equal(Option.getOrThrow(yield* taskStore.getRun(fixture.run.runId)).status, "queued");
    }),
  );

  it.effect("存在更新 Run 时拒绝给旧启动身份回填取消屏障", () =>
    Effect.gen(function* () {
      const fixture = makeFixture("replaced");
      const taskStore = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const accepted = yield* seedAccepted(fixture);
      const cancelledRun = { ...fixture.run, cancelRequestedAtUnixMs: 4 };
      yield* taskStore.upsertRun(cancelledRun);
      yield* taskStore.upsertRun({
        ...fixture.run,
        runId: `${fixture.run.runId}-newer`,
        attempt: fixture.run.attempt + 1,
      });

      const result = yield* requestCompositionRunStartCancellationBarrier(
        taskStore,
        runStartStore,
        {
          task: fixture.task,
          run: cancelledRun,
          reason: "不得取消旧 Run。",
        },
      );

      assert.equal(result._tag, "Rejected");
      if (result._tag === "Rejected") {
        assert.equal(result.code, "run_start_cancellation_run_replaced");
      }
      assert.equal(
        Option.getOrThrow(yield* runStartStore.getStart(fixture.run.runId)).revision,
        accepted.revision,
      );
    }),
  );

  it.effect("Task/Run 已终态时拒绝回填取消屏障", () =>
    Effect.gen(function* () {
      const fixture = makeFixture("terminal");
      const taskStore = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const accepted = yield* seedAccepted(fixture);
      const terminalTask: CompositionTask = {
        ...fixture.task,
        status: "cancelled",
        updatedAtUnixMs: 4,
        finishedAtUnixMs: 4,
      };
      const terminalRun: CompositionTaskRun = {
        ...fixture.run,
        status: "cancelled",
        cancelRequestedAtUnixMs: 4,
        finishedAtUnixMs: 4,
      };
      yield* taskStore.upsertTask(terminalTask);
      yield* taskStore.upsertRun(terminalRun);

      const result = yield* requestCompositionRunStartCancellationBarrier(
        taskStore,
        runStartStore,
        {
          task: fixture.task,
          run: terminalRun,
          reason: "终态不得重开取消恢复。",
        },
      );

      assert.equal(result._tag, "Rejected");
      if (result._tag === "Rejected") {
        assert.equal(result.code, "run_start_cancellation_status_changed");
      }
      assert.equal(
        Option.getOrThrow(yield* runStartStore.getStart(fixture.run.runId)).revision,
        accepted.revision,
      );
    }),
  );
});
