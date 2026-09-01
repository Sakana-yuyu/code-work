import type { CompositionTask, CompositionTaskRun } from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { CompositionRunStartStoreLive } from "../persistence/Layers/CompositionRunStartStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  CompositionRunStartStore,
  type CompositionRunStartIntent,
} from "../persistence/Services/CompositionRunStartStore.ts";
import type {
  CompositionTaskInputStoreShape,
  CompositionTaskRecoveryInput,
} from "../persistence/Services/CompositionTaskInputStore.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import { makeCompositionOrchestrator } from "./CompositionOrchestrator.ts";
import { makeCompositionRunStartDigests } from "./CompositionRunStartLifecycle.ts";
import { recoverCompositionRunStartRuntimeLease } from "./CompositionRunStartRecoveryResources.ts";
import type {
  CompositionRunStartRecoveryCandidate,
  CompositionRunStartRecoveryPlan,
} from "./CompositionRunStartRecoveryPolicy.ts";

const layer = it.layer(
  Layer.mergeAll(CompositionTaskStoreLive, CompositionRunStartStoreLive).pipe(
    Layer.provide(SqlitePersistenceMemory),
  ),
);

const makeInputStore = (input: CompositionTaskRecoveryInput): CompositionTaskInputStoreShape => ({
  save: () => Effect.void,
  get: (taskId) => Effect.succeed(taskId === input.taskId ? Option.some(input) : Option.none()),
  remove: () => Effect.void,
});

const makeFixture = (suffix: string) => {
  const task: CompositionTask = {
    taskId: `task-run-start-executor-${suffix}`,
    projectId: `project-run-start-executor-${suffix}`,
    assigneeKind: "agent",
    assigneeId: `agent-run-start-executor-${suffix}`,
    mode: "serial",
    status: "queued",
    promptDigest: `sha256:prompt-run-start-executor-${suffix}`,
    dependsOnTaskIds: [],
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
  };
  const run: CompositionTaskRun = {
    taskId: task.taskId,
    runId: `run-run-start-executor-${suffix}`,
    agentId: task.assigneeId,
    runtimeId: `runtime-run-start-executor-${suffix}`,
    status: "queued",
    attempt: 1,
    capabilityGrantIds: [],
  };
  const recoveryInput: CompositionTaskRecoveryInput = {
    taskId: task.taskId,
    prompt: `恢复 ${suffix}`,
    workspaceRoot: `C:/workspace/run-start-executor-${suffix}`,
    capabilityIds: [],
  };
  const externalTargetIdentity = {
    runtimeKind: "provider",
    providerInstanceId: `provider-run-start-executor-${suffix}`,
    adapterId: run.runtimeId,
    modelIdentity: null,
    configDigest: null,
    sessionMode: "test",
  };
  const digests = makeCompositionRunStartDigests({
    taskId: task.taskId,
    projectId: task.projectId,
    runId: run.runId,
    previousRunId: null,
    assigneeKind: task.assigneeKind,
    assigneeId: task.assigneeId,
    mode: task.mode,
    dependsOnTaskIds: task.dependsOnTaskIds,
    agentId: run.agentId,
    runtimeId: run.runtimeId,
    attempt: run.attempt,
    promptDigest: task.promptDigest,
    externalTargetIdentity,
    capabilityIds: [],
  });
  return { task, run, recoveryInput, externalTargetIdentity, digests };
};

const makeCandidate = (
  fixture: ReturnType<typeof makeFixture>,
  intent: CompositionRunStartIntent,
): CompositionRunStartRecoveryCandidate => ({
  task: fixture.task,
  run: fixture.run,
  intent,
  capabilityIds: [],
  workspaceRootDigest: null,
  model: null,
});

const makePlan = (
  fixture: ReturnType<typeof makeFixture>,
  action: CompositionRunStartRecoveryPlan["action"],
): CompositionRunStartRecoveryPlan => ({
  taskId: fixture.task.taskId,
  runId: fixture.run.runId,
  action,
});

const prepareFixture = Effect.fn("prepareRunStartRecoveryExecutorFixture")(function* (
  fixture: ReturnType<typeof makeFixture>,
) {
  const store = yield* CompositionTaskStore;
  const runStartStore = yield* CompositionRunStartStore;
  yield* store.upsertTask(fixture.task);
  yield* store.upsertRun(fixture.run);
  return yield* runStartStore.prepareStart({
    taskId: fixture.task.taskId,
    runId: fixture.run.runId,
    previousRunId: null,
    agentId: fixture.run.agentId,
    runtimeId: fixture.run.runtimeId,
    attempt: fixture.run.attempt,
    ...fixture.digests,
    createdAtUnixMs: 1,
  });
});

const recordAcceptedFixture = Effect.fn("recordAcceptedRunStartRecoveryExecutorFixture")(function* (
  fixture: ReturnType<typeof makeFixture>,
  leaseExpiresAtUnixMs = 2,
) {
  const runStartStore = yield* CompositionRunStartStore;
  const prepared = yield* prepareFixture(fixture);
  const preparing = yield* runStartStore.claimPrepared({
    runId: fixture.run.runId,
    expectedRevision: prepared.revision,
    claimId: `claim-accepted-${fixture.run.runId}`,
    claimedAtUnixMs: 0,
    leaseExpiresAtUnixMs,
  });
  const dispatching = yield* runStartStore.markDispatching({
    runId: fixture.run.runId,
    expectedRevision: preparing.intent.revision,
    claimId: preparing.intent.claimId ?? "",
    ownerEpoch: preparing.intent.ownerEpoch,
    dispatchedAtUnixMs: 1,
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

const attachExpiredRuntimeLease = Effect.fn("attachExpiredRunStartRuntimeLease")(function* (
  fixture: ReturnType<typeof makeFixture>,
) {
  const store = yield* CompositionTaskStore;
  const workspaceRootDigest = `sha256:workspace-lease-${fixture.run.runId}`;
  const leaseId = `lease-expired-${fixture.run.runId}`;
  const claimed = yield* store.claimLease({
    lease: {
      leaseId,
      runtimeId: fixture.run.runtimeId,
      taskId: fixture.task.taskId,
      workspaceRootDigest,
      heartbeatAtUnixMs: 1,
      expiresAtUnixMs: 5,
      state: "active",
    },
    nowUnixMs: 1,
  });
  assert.isTrue(Option.isSome(claimed));
  const run = { ...fixture.run, leaseId };
  yield* store.upsertRun(run);
  return {
    leaseId,
    run,
    workspaceRootDigest,
    recoveryInput: { ...fixture.recoveryInput, workspaceRootDigest },
  };
});

type ExpiredRuntimeLeaseFixture = {
  readonly leaseId: string;
  readonly run: CompositionTaskRun;
  readonly workspaceRootDigest: string;
  readonly recoveryInput: CompositionTaskRecoveryInput;
};

const makeLeasedCandidate = (
  fixture: ReturnType<typeof makeFixture>,
  intent: CompositionRunStartIntent,
  lease: ExpiredRuntimeLeaseFixture,
): CompositionRunStartRecoveryCandidate => ({
  ...makeCandidate(fixture, intent),
  run: lease.run,
  workspaceRootDigest: lease.workspaceRootDigest,
});

const makeRuntime = Effect.fn("makeRunStartRecoveryExecutorRuntime")(function* (
  fixture: ReturnType<typeof makeFixture>,
) {
  const store = yield* CompositionTaskStore;
  const runStartStore = yield* CompositionRunStartStore;
  const driverRegistry = makeCompositionAgentDriverRegistry();
  let starts = 0;
  yield* driverRegistry.register({
    agentId: fixture.run.agentId,
    runtimeId: fixture.run.runtimeId,
    getStartIdentity: () => fixture.externalTargetIdentity,
    startRecoveryPolicy: {
      mode: "idempotent-replay",
      requiredReceipt: "runtime-task",
      capabilityGrantReplay: { mode: "none" },
    },
    startTask: () =>
      Effect.sync(() => {
        starts += 1;
        return { runtimeTaskId: `runtime-task-${fixture.run.runId}` };
      }),
    cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
  });
  const inputStore = makeInputStore(fixture.recoveryInput);
  return {
    orchestrator: makeCompositionOrchestrator(
      store,
      driverRegistry,
      undefined,
      inputStore,
      runStartStore,
    ),
    get starts() {
      return starts;
    },
  };
});

layer("Composition Run Start 恢复执行器", (it) => {
  it.effect("prepared 恢复只启动一次并把 receipt 原子结算", () =>
    Effect.gen(function* () {
      const fixture = makeFixture("prepared");
      const runStartStore = yield* CompositionRunStartStore;
      const prepared = yield* prepareFixture(fixture);
      const runtime = yield* makeRuntime(fixture);
      yield* TestClock.adjust("10 millis");

      const first = yield* runtime.orchestrator.recoverPersistedRunStart({
        candidate: makeCandidate(fixture, prepared),
        recoveryInput: fixture.recoveryInput,
        plan: makePlan(fixture, "start"),
      });
      const second = yield* runtime.orchestrator.recoverPersistedRunStart({
        candidate: makeCandidate(fixture, prepared),
        recoveryInput: fixture.recoveryInput,
        plan: makePlan(fixture, "start"),
      });

      assert.equal(first.action, "start");
      assert.equal(second.action, "defer");
      assert.equal(runtime.starts, 1);
      assert.equal(
        Option.getOrThrow(yield* runStartStore.getStart(fixture.run.runId)).state,
        "settled",
      );
      assert.equal(
        Option.getOrThrow(yield* (yield* CompositionTaskStore).getRun(fixture.run.runId)).status,
        "running",
      );
    }),
  );

  it.effect("两个 Orchestrator 并发恢复同一 prepared 意图只允许一次外部启动", () =>
    Effect.gen(function* () {
      const fixture = makeFixture("prepared-concurrent");
      const runStartStore = yield* CompositionRunStartStore;
      const prepared = yield* prepareFixture(fixture);
      const firstRuntime = yield* makeRuntime(fixture);
      const secondRuntime = yield* makeRuntime(fixture);
      yield* TestClock.adjust("10 millis");

      const outcomes = yield* Effect.all(
        [
          firstRuntime.orchestrator.recoverPersistedRunStart({
            candidate: makeCandidate(fixture, prepared),
            recoveryInput: fixture.recoveryInput,
            plan: makePlan(fixture, "start"),
          }),
          secondRuntime.orchestrator.recoverPersistedRunStart({
            candidate: makeCandidate(fixture, prepared),
            recoveryInput: fixture.recoveryInput,
            plan: makePlan(fixture, "start"),
          }),
        ],
        { concurrency: "unbounded" },
      );

      assert.equal(firstRuntime.starts + secondRuntime.starts, 1);
      assert.deepEqual(outcomes.map((outcome) => outcome.action).toSorted(), ["defer", "start"]);
      assert.equal(
        Option.getOrThrow(yield* runStartStore.getStart(fixture.run.runId)).state,
        "settled",
      );
    }),
  );

  it.effect("两个 Orchestrator 并发收口同一 accepted receipt 只写一个 running 事件", () =>
    Effect.gen(function* () {
      const fixture = makeFixture("accepted-concurrent");
      const taskStore = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const accepted = yield* recordAcceptedFixture(fixture);
      const firstRuntime = yield* makeRuntime(fixture);
      const secondRuntime = yield* makeRuntime(fixture);
      const plan = {
        ...makePlan(fixture, "accept"),
        ...(accepted.runtimeTaskId === null ? {} : { runtimeTaskId: accepted.runtimeTaskId }),
        capabilityHandshakeId: accepted.capabilityHandshakeId,
      };

      const outcomes = yield* Effect.all(
        [
          firstRuntime.orchestrator.recoverPersistedRunStart({
            candidate: makeCandidate(fixture, accepted),
            recoveryInput: fixture.recoveryInput,
            plan,
          }),
          secondRuntime.orchestrator.recoverPersistedRunStart({
            candidate: makeCandidate(fixture, accepted),
            recoveryInput: fixture.recoveryInput,
            plan,
          }),
        ],
        { concurrency: "unbounded" },
      );

      const events = yield* taskStore.listEvents(fixture.task.taskId, fixture.run.runId);
      assert.equal(firstRuntime.starts + secondRuntime.starts, 0);
      assert.deepEqual(outcomes.map((outcome) => outcome.action).toSorted(), ["accept", "defer"]);
      assert.equal(events.filter((event) => event.status === "running").length, 1);
      assert.equal(
        Option.getOrThrow(yield* runStartStore.getStart(fixture.run.runId)).state,
        "settled",
      );
      assert.equal(Option.getOrThrow(yield* taskStore.getRun(fixture.run.runId)).status, "running");
    }),
  );

  it.effect("accepted 活跃 owner 必须 defer 到 lease 到期且不得投影", () =>
    Effect.gen(function* () {
      const fixture = makeFixture("accepted-active-owner");
      const runStartStore = yield* CompositionRunStartStore;
      const accepted = yield* recordAcceptedFixture(fixture, 100);
      const runtime = yield* makeRuntime(fixture);
      const plan = {
        ...makePlan(fixture, "accept"),
        ...(accepted.runtimeTaskId === null ? {} : { runtimeTaskId: accepted.runtimeTaskId }),
        capabilityHandshakeId: accepted.capabilityHandshakeId,
      };

      const outcome = yield* runtime.orchestrator.recoverPersistedRunStart({
        candidate: makeCandidate(fixture, accepted),
        recoveryInput: fixture.recoveryInput,
        plan,
      });

      assert.equal(outcome.action, "defer");
      assert.equal(outcome.retryAtUnixMs, 100);
      assert.equal(runtime.starts, 0);
      assert.equal(
        Option.getOrThrow(yield* runStartStore.getStart(fixture.run.runId)).state,
        "accepted",
      );
    }),
  );

  it.effect("accepted 恢复允许早到 waiting_input 且不回退投影 running", () =>
    Effect.gen(function* () {
      const fixture = makeFixture("accepted-waiting-input");
      const taskStore = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const accepted = yield* recordAcceptedFixture(fixture);
      const waitingTask: CompositionTask = {
        ...fixture.task,
        status: "waiting_input",
        updatedAtUnixMs: 4,
      };
      const waitingRun: CompositionTaskRun = { ...fixture.run, status: "waiting_input" };
      yield* taskStore.upsertTask(waitingTask);
      yield* taskStore.upsertRun(waitingRun);
      const runtime = yield* makeRuntime(fixture);

      const outcome = yield* runtime.orchestrator.recoverPersistedRunStart({
        candidate: { ...makeCandidate(fixture, accepted), task: waitingTask, run: waitingRun },
        recoveryInput: fixture.recoveryInput,
        plan: makePlan(fixture, "accept"),
      });

      const events = yield* taskStore.listEvents(fixture.task.taskId, fixture.run.runId);
      assert.equal(outcome.action, "accept");
      assert.equal(
        Option.getOrThrow(yield* taskStore.getTask(fixture.task.taskId)).status,
        "waiting_input",
      );
      assert.equal(
        Option.getOrThrow(yield* taskStore.getRun(fixture.run.runId)).status,
        "waiting_input",
      );
      assert.equal(events.filter((event) => event.status === "running").length, 0);
      assert.equal(
        Option.getOrThrow(yield* runStartStore.getStart(fixture.run.runId)).state,
        "settled",
      );
    }),
  );

  it.effect("accepted 恢复遇到旧取消请求时回填持久屏障且不得投影", () =>
    Effect.gen(function* () {
      const fixture = makeFixture("accepted-cancel-requested");
      const taskStore = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const accepted = yield* recordAcceptedFixture(fixture);
      const cancelledRun: CompositionTaskRun = {
        ...fixture.run,
        cancelRequestedAtUnixMs: 4,
      };
      yield* taskStore.upsertRun(cancelledRun);
      const runtime = yield* makeRuntime(fixture);

      const outcome = yield* runtime.orchestrator.recoverPersistedRunStart({
        candidate: { ...makeCandidate(fixture, accepted), run: cancelledRun },
        recoveryInput: fixture.recoveryInput,
        plan: makePlan(fixture, "accept"),
      });

      assert.equal(outcome.action, "defer");
      assert.equal(outcome.code, "run_start_cancellation_pending");
      assert.equal(
        Option.getOrThrow(yield* taskStore.getTask(fixture.task.taskId)).status,
        "queued",
      );
      const persistedRun = Option.getOrThrow(yield* taskStore.getRun(fixture.run.runId));
      assert.equal(persistedRun.status, "queued");
      assert.equal(persistedRun.cancelRequestedAtUnixMs, 4);
      const persistedStart = Option.getOrThrow(yield* runStartStore.getStart(fixture.run.runId));
      assert.equal(persistedStart.state, "cancel_pending");
      assert.equal(persistedStart.cancelSourceState, "accepted");
      assert.equal(persistedStart.cancelStartOutcome, "accepted");
    }),
  );

  it.effect("accepted 恢复遇到更新 Run 时转入稳定人工态且不得复活旧 Run", () =>
    Effect.gen(function* () {
      const fixture = makeFixture("accepted-run-replaced");
      const taskStore = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const accepted = yield* recordAcceptedFixture(fixture);
      yield* taskStore.upsertRun({
        ...fixture.run,
        runId: `${fixture.run.runId}-newer`,
        attempt: fixture.run.attempt + 1,
      });
      const runtime = yield* makeRuntime(fixture);

      const outcome = yield* runtime.orchestrator.recoverPersistedRunStart({
        candidate: makeCandidate(fixture, accepted),
        recoveryInput: fixture.recoveryInput,
        plan: makePlan(fixture, "accept"),
      });

      assert.equal(outcome.action, "manual");
      assert.equal(outcome.code, "run_start_recovery_preflight_run_replaced");
      assert.equal(Option.getOrThrow(yield* taskStore.getRun(fixture.run.runId)).status, "queued");
      assert.equal(
        Option.getOrThrow(yield* runStartStore.getStart(fixture.run.runId)).state,
        "manual_pending",
      );
    }),
  );

  it.effect("未到期 preparing owner 返回精确唤醒时间且不提前启动", () =>
    Effect.gen(function* () {
      const fixture = makeFixture("preparing-active");
      const runStartStore = yield* CompositionRunStartStore;
      const prepared = yield* prepareFixture(fixture);
      const preparing = yield* runStartStore.claimPrepared({
        runId: fixture.run.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-preparing-active",
        claimedAtUnixMs: 5,
        leaseExpiresAtUnixMs: 100,
      });
      const runtime = yield* makeRuntime(fixture);
      yield* TestClock.adjust("50 millis");

      const outcome = yield* runtime.orchestrator.recoverPersistedRunStart({
        candidate: makeCandidate(fixture, preparing.intent),
        recoveryInput: fixture.recoveryInput,
        plan: makePlan(fixture, "start"),
      });

      assert.equal(outcome.action, "defer");
      assert.equal(outcome.retryAtUnixMs, 100);
      assert.equal(runtime.starts, 0);
      assert.equal(
        Option.getOrThrow(yield* runStartStore.getStart(fixture.run.runId)).state,
        "preparing",
      );
    }),
  );

  it.effect("到期 preparing owner 被安全重置并由新 owner 启动一次", () =>
    Effect.gen(function* () {
      const fixture = makeFixture("preparing-expired");
      const runStartStore = yield* CompositionRunStartStore;
      const prepared = yield* prepareFixture(fixture);
      const preparing = yield* runStartStore.claimPrepared({
        runId: fixture.run.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-preparing-expired",
        claimedAtUnixMs: 5,
        leaseExpiresAtUnixMs: 10,
      });
      const runtime = yield* makeRuntime(fixture);
      yield* TestClock.adjust("11 millis");

      const outcome = yield* runtime.orchestrator.recoverPersistedRunStart({
        candidate: makeCandidate(fixture, preparing.intent),
        recoveryInput: fixture.recoveryInput,
        plan: makePlan(fixture, "start"),
      });

      assert.equal(outcome.action, "start");
      assert.equal(runtime.starts, 1);
      const settled = Option.getOrThrow(yield* runStartStore.getStart(fixture.run.runId));
      assert.equal(settled.state, "settled");
      assert.equal(settled.ownerEpoch, 2);
    }),
  );

  it.effect("未到期 dispatching owner 返回 lease 唤醒时间且不重放", () =>
    Effect.gen(function* () {
      const fixture = makeFixture("dispatching-active");
      const runStartStore = yield* CompositionRunStartStore;
      const prepared = yield* prepareFixture(fixture);
      const preparing = yield* runStartStore.claimPrepared({
        runId: fixture.run.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-dispatching-active",
        claimedAtUnixMs: 5,
        leaseExpiresAtUnixMs: 10_000,
      });
      const dispatching = yield* runStartStore.markDispatching({
        runId: fixture.run.runId,
        expectedRevision: preparing.intent.revision,
        claimId: preparing.intent.claimId ?? "",
        ownerEpoch: preparing.intent.ownerEpoch,
        dispatchedAtUnixMs: 6,
      });
      const runtime = yield* makeRuntime(fixture);
      yield* TestClock.adjust("50 millis");

      const outcome = yield* runtime.orchestrator.recoverPersistedRunStart({
        candidate: makeCandidate(fixture, dispatching),
        recoveryInput: fixture.recoveryInput,
        plan: makePlan(fixture, "replay"),
      });

      assert.equal(outcome.action, "defer");
      assert.equal(outcome.retryAtUnixMs, 10_000);
      assert.equal(runtime.starts, 0);
      assert.equal(
        Option.getOrThrow(yield* runStartStore.getStart(fixture.run.runId)).state,
        "dispatching",
      );
    }),
  );

  it.effect("规划后取消请求先落库时不得启动旧候选", () =>
    Effect.gen(function* () {
      const fixture = makeFixture("preflight-cancel-requested");
      const taskStore = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const prepared = yield* prepareFixture(fixture);
      const runtime = yield* makeRuntime(fixture);
      yield* taskStore.upsertRun({
        ...fixture.run,
        cancelRequestedAtUnixMs: 2,
      });

      const outcome = yield* runtime.orchestrator.recoverPersistedRunStart({
        candidate: makeCandidate(fixture, prepared),
        recoveryInput: fixture.recoveryInput,
        plan: makePlan(fixture, "start"),
      });

      assert.equal(outcome.action, "quarantine");
      assert.equal(outcome.code, "run_start_recovery_preflight_cancel_requested");
      assert.equal(runtime.starts, 0);
      const intent = Option.getOrThrow(yield* runStartStore.getStart(fixture.run.runId));
      assert.equal(intent.state, "quarantined");
      assert.equal(intent.outcomeCode, "run_start_recovery_preflight_cancel_requested");
    }),
  );

  it.effect("规划后终态先落库时不得启动旧候选", () =>
    Effect.gen(function* () {
      const fixture = makeFixture("preflight-terminal");
      const taskStore = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const prepared = yield* prepareFixture(fixture);
      const runtime = yield* makeRuntime(fixture);
      yield* taskStore.upsertTask({
        ...fixture.task,
        status: "cancelled",
        updatedAtUnixMs: 2,
        finishedAtUnixMs: 2,
      });
      yield* taskStore.upsertRun({
        ...fixture.run,
        status: "cancelled",
        finishedAtUnixMs: 2,
      });

      const outcome = yield* runtime.orchestrator.recoverPersistedRunStart({
        candidate: makeCandidate(fixture, prepared),
        recoveryInput: fixture.recoveryInput,
        plan: makePlan(fixture, "start"),
      });

      assert.equal(outcome.action, "quarantine");
      assert.equal(outcome.code, "run_start_recovery_preflight_status_changed");
      assert.equal(runtime.starts, 0);
      const intent = Option.getOrThrow(yield* runStartStore.getStart(fixture.run.runId));
      assert.equal(intent.state, "quarantined");
      assert.equal(intent.outcomeCode, "run_start_recovery_preflight_status_changed");
    }),
  );

  it.effect("规划后出现更新 Run 时不得启动旧候选", () =>
    Effect.gen(function* () {
      const fixture = makeFixture("preflight-latest-run");
      const taskStore = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const prepared = yield* prepareFixture(fixture);
      const runtime = yield* makeRuntime(fixture);
      yield* taskStore.upsertRun({
        ...fixture.run,
        runId: `${fixture.run.runId}-newer`,
        attempt: fixture.run.attempt + 1,
      });

      const outcome = yield* runtime.orchestrator.recoverPersistedRunStart({
        candidate: makeCandidate(fixture, prepared),
        recoveryInput: fixture.recoveryInput,
        plan: makePlan(fixture, "start"),
      });

      assert.equal(outcome.action, "quarantine");
      assert.equal(outcome.code, "run_start_recovery_preflight_run_replaced");
      assert.equal(runtime.starts, 0);
      const intent = Option.getOrThrow(yield* runStartStore.getStart(fixture.run.runId));
      assert.equal(intent.state, "quarantined");
      assert.equal(intent.outcomeCode, "run_start_recovery_preflight_run_replaced");
    }),
  );

  it.effect("prepared 恢复会重获过期 workspace lease 后再启动", () =>
    Effect.gen(function* () {
      const fixture = makeFixture("prepared-expired-runtime-lease");
      const taskStore = yield* CompositionTaskStore;
      const prepared = yield* prepareFixture(fixture);
      const lease = yield* attachExpiredRuntimeLease(fixture);
      const runtime = yield* makeRuntime(fixture);
      yield* TestClock.adjust("10 millis");

      const outcome = yield* runtime.orchestrator.recoverPersistedRunStart({
        candidate: makeLeasedCandidate(fixture, prepared, lease),
        recoveryInput: lease.recoveryInput,
        plan: makePlan(fixture, "start"),
      });

      const run = Option.getOrThrow(yield* taskStore.getRun(fixture.run.runId));
      assert.equal(outcome.action, "start");
      assert.equal(runtime.starts, 1);
      assert.notEqual(run.leaseId, lease.leaseId);
      assert.equal(Option.getOrThrow(yield* taskStore.getLease(run.leaseId ?? "")).state, "active");
    }),
  );

  it.effect("租约恢复不得用旧 Run 快照擦除已落库的取消请求", () =>
    Effect.gen(function* () {
      const fixture = makeFixture("runtime-lease-stale-cancel");
      const taskStore = yield* CompositionTaskStore;
      yield* taskStore.upsertTask(fixture.task);
      yield* taskStore.upsertRun(fixture.run);
      yield* taskStore.upsertRun({
        ...fixture.run,
        cancelRequestedAtUnixMs: 5,
      });

      const recovered = yield* recoverCompositionRunStartRuntimeLease(taskStore, {
        task: fixture.task,
        run: fixture.run,
        workspaceRootDigest: `sha256:workspace-${fixture.run.runId}`,
      });

      const persisted = Option.getOrThrow(yield* taskStore.getRun(fixture.run.runId));
      assert.equal(recovered._tag, "Deferred");
      assert.equal(persisted.cancelRequestedAtUnixMs, 5);
      assert.isUndefined(persisted.leaseId);
      assert.isTrue(
        Option.isNone(yield* taskStore.getLease(`composition-runtime-lease:${fixture.run.runId}`)),
      );
    }),
  );

  it.effect("dispatching replay 会重获过期 workspace lease 后再重放", () =>
    Effect.gen(function* () {
      const fixture = makeFixture("replay-expired-runtime-lease");
      const taskStore = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const prepared = yield* prepareFixture(fixture);
      const lease = yield* attachExpiredRuntimeLease(fixture);
      const preparing = yield* runStartStore.claimPrepared({
        runId: fixture.run.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-replay-expired-runtime-lease",
        claimedAtUnixMs: 2,
        leaseExpiresAtUnixMs: 5,
      });
      const dispatching = yield* runStartStore.markDispatching({
        runId: fixture.run.runId,
        expectedRevision: preparing.intent.revision,
        claimId: preparing.intent.claimId ?? "",
        ownerEpoch: preparing.intent.ownerEpoch,
        dispatchedAtUnixMs: 3,
      });
      const runtime = yield* makeRuntime(fixture);
      yield* TestClock.adjust("10 millis");

      const outcome = yield* runtime.orchestrator.recoverPersistedRunStart({
        candidate: makeLeasedCandidate(fixture, dispatching, lease),
        recoveryInput: lease.recoveryInput,
        plan: makePlan(fixture, "replay"),
      });

      const run = Option.getOrThrow(yield* taskStore.getRun(fixture.run.runId));
      assert.equal(outcome.action, "replay");
      assert.equal(runtime.starts, 1);
      assert.notEqual(run.leaseId, lease.leaseId);
      assert.equal(Option.getOrThrow(yield* taskStore.getLease(run.leaseId ?? "")).state, "active");
    }),
  );

  it.effect("accepted receipt 只有重获过期 workspace lease 后才投影 running", () =>
    Effect.gen(function* () {
      const fixture = makeFixture("accepted-expired-runtime-lease");
      const taskStore = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const prepared = yield* prepareFixture(fixture);
      const lease = yield* attachExpiredRuntimeLease(fixture);
      const preparing = yield* runStartStore.claimPrepared({
        runId: fixture.run.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-accepted-expired-runtime-lease",
        claimedAtUnixMs: 2,
        leaseExpiresAtUnixMs: 5,
      });
      const dispatching = yield* runStartStore.markDispatching({
        runId: fixture.run.runId,
        expectedRevision: preparing.intent.revision,
        claimId: preparing.intent.claimId ?? "",
        ownerEpoch: preparing.intent.ownerEpoch,
        dispatchedAtUnixMs: 3,
      });
      const accepted = yield* runStartStore.recordAccepted({
        runId: fixture.run.runId,
        expectedRevision: dispatching.revision,
        claimId: dispatching.claimId ?? "",
        ownerEpoch: dispatching.ownerEpoch,
        runtimeTaskId: `runtime-task-${fixture.run.runId}`,
        capabilityHandshakeId: null,
        acceptedAtUnixMs: 4,
      });
      const runtime = yield* makeRuntime(fixture);
      yield* TestClock.adjust("10 millis");

      const outcome = yield* runtime.orchestrator.recoverPersistedRunStart({
        candidate: makeLeasedCandidate(fixture, accepted, lease),
        recoveryInput: lease.recoveryInput,
        plan: {
          ...makePlan(fixture, "accept"),
          ...(accepted.runtimeTaskId === null ? {} : { runtimeTaskId: accepted.runtimeTaskId }),
          capabilityHandshakeId: accepted.capabilityHandshakeId,
        },
      });

      const run = Option.getOrThrow(yield* taskStore.getRun(fixture.run.runId));
      assert.equal(outcome.action, "accept");
      assert.equal(run.status, "running");
      assert.notEqual(run.leaseId, lease.leaseId);
      assert.equal(Option.getOrThrow(yield* taskStore.getLease(run.leaseId ?? "")).state, "active");
    }),
  );

  it.effect("workspace 已被其他 Run 占用时恢复必须 defer 且不得外部启动", () =>
    Effect.gen(function* () {
      const fixture = makeFixture("runtime-lease-conflict");
      const taskStore = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const prepared = yield* prepareFixture(fixture);
      const lease = yield* attachExpiredRuntimeLease(fixture);
      const preparing = yield* runStartStore.claimPrepared({
        runId: fixture.run.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-runtime-lease-conflict",
        claimedAtUnixMs: 2,
        leaseExpiresAtUnixMs: 5,
      });
      const dispatching = yield* runStartStore.markDispatching({
        runId: fixture.run.runId,
        expectedRevision: preparing.intent.revision,
        claimId: preparing.intent.claimId ?? "",
        ownerEpoch: preparing.intent.ownerEpoch,
        dispatchedAtUnixMs: 3,
      });
      yield* TestClock.adjust("10 millis");
      const nowUnixMs = yield* Clock.currentTimeMillis;
      const competing = yield* taskStore.claimLease({
        lease: {
          leaseId: `lease-competing-${fixture.run.runId}`,
          runtimeId: "runtime-competing",
          taskId: "task-competing",
          workspaceRootDigest: lease.workspaceRootDigest,
          heartbeatAtUnixMs: nowUnixMs,
          expiresAtUnixMs: nowUnixMs + 100,
          state: "active",
        },
        nowUnixMs,
      });
      assert.isTrue(Option.isSome(competing));
      const runtime = yield* makeRuntime(fixture);

      const outcome = yield* runtime.orchestrator.recoverPersistedRunStart({
        candidate: makeLeasedCandidate(fixture, dispatching, lease),
        recoveryInput: lease.recoveryInput,
        plan: makePlan(fixture, "replay"),
      });

      assert.equal(outcome.action, "defer");
      assert.equal(outcome.code, "run_start_runtime_lease_unavailable");
      assert.equal(runtime.starts, 0);
      const claimedIntent = Option.getOrThrow(yield* runStartStore.getStart(fixture.run.runId));
      assert.equal(claimedIntent.state, "dispatching");
      assert.isNotNull(claimedIntent.claimId);
      assert.equal(outcome.retryAtUnixMs, claimedIntent.ownerLeaseExpiresAtUnixMs);
      assert.equal(
        Option.getOrThrow(yield* taskStore.getRun(fixture.run.runId)).leaseId,
        lease.leaseId,
      );

      const repeated = yield* runtime.orchestrator.recoverPersistedRunStart({
        candidate: makeLeasedCandidate(fixture, dispatching, lease),
        recoveryInput: lease.recoveryInput,
        plan: makePlan(fixture, "replay"),
      });
      assert.equal(repeated.action, "defer");
      assert.equal(runtime.starts, 0);
    }),
  );

  it.effect("accepted workspace lease 被竞争 Run 占用时释放 claim 并稳定 defer", () =>
    Effect.gen(function* () {
      const fixture = makeFixture("accepted-runtime-lease-conflict");
      const taskStore = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const prepared = yield* prepareFixture(fixture);
      const lease = yield* attachExpiredRuntimeLease(fixture);
      const preparing = yield* runStartStore.claimPrepared({
        runId: fixture.run.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-accepted-runtime-lease-conflict",
        claimedAtUnixMs: 2,
        leaseExpiresAtUnixMs: 5,
      });
      const dispatching = yield* runStartStore.markDispatching({
        runId: fixture.run.runId,
        expectedRevision: preparing.intent.revision,
        claimId: preparing.intent.claimId ?? "",
        ownerEpoch: preparing.intent.ownerEpoch,
        dispatchedAtUnixMs: 3,
      });
      const accepted = yield* runStartStore.recordAccepted({
        runId: fixture.run.runId,
        expectedRevision: dispatching.revision,
        claimId: dispatching.claimId ?? "",
        ownerEpoch: dispatching.ownerEpoch,
        runtimeTaskId: `runtime-task-${fixture.run.runId}`,
        capabilityHandshakeId: null,
        acceptedAtUnixMs: 4,
      });
      yield* TestClock.adjust("10 millis");
      const nowUnixMs = yield* Clock.currentTimeMillis;
      const competing = yield* taskStore.claimLease({
        lease: {
          leaseId: `lease-competing-${fixture.run.runId}`,
          runtimeId: "runtime-competing",
          taskId: "task-competing",
          workspaceRootDigest: lease.workspaceRootDigest,
          heartbeatAtUnixMs: nowUnixMs,
          expiresAtUnixMs: nowUnixMs + 100,
          state: "active",
        },
        nowUnixMs,
      });
      assert.isTrue(Option.isSome(competing));
      const runtime = yield* makeRuntime(fixture);
      const plan = {
        ...makePlan(fixture, "accept"),
        ...(accepted.runtimeTaskId === null ? {} : { runtimeTaskId: accepted.runtimeTaskId }),
        capabilityHandshakeId: accepted.capabilityHandshakeId,
      };

      const first = yield* runtime.orchestrator.recoverPersistedRunStart({
        candidate: makeLeasedCandidate(fixture, accepted, lease),
        recoveryInput: lease.recoveryInput,
        plan,
      });
      const afterFirst = Option.getOrThrow(yield* runStartStore.getStart(fixture.run.runId));
      const second = yield* runtime.orchestrator.recoverPersistedRunStart({
        candidate: makeLeasedCandidate(fixture, afterFirst, lease),
        recoveryInput: lease.recoveryInput,
        plan,
      });

      assert.equal(first.action, "defer");
      assert.equal(first.code, "run_start_runtime_lease_unavailable");
      assert.equal(second.action, "defer");
      assert.equal(second.code, "run_start_runtime_lease_unavailable");
      assert.equal(runtime.starts, 0);
      const currentIntent = Option.getOrThrow(yield* runStartStore.getStart(fixture.run.runId));
      assert.equal(currentIntent.state, "accepted");
      assert.isNull(currentIntent.claimId);
      assert.isNull(currentIntent.ownerLeaseExpiresAtUnixMs);
      assert.equal(Option.getOrThrow(yield* taskStore.getRun(fixture.run.runId)).status, "queued");
      const events = yield* taskStore.listEvents(fixture.task.taskId, fixture.run.runId);
      assert.equal(events.filter((event) => event.status === "running").length, 0);
    }),
  );
});
