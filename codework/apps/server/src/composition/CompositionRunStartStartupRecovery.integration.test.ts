import * as NodeServices from "@effect/platform-node/NodeServices";
import type { CompositionTask, CompositionTaskRun } from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { CompositionRunStartStoreLive } from "../persistence/Layers/CompositionRunStartStore.ts";
import { CompositionTaskInputStoreLive } from "../persistence/Layers/CompositionTaskInputStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import {
  CompositionRunStartStore,
  type CompositionRunStartStoreShape,
} from "../persistence/Services/CompositionRunStartStore.ts";
import {
  CompositionTaskInputStore,
  type CompositionTaskRecoveryInput,
  type CompositionTaskInputStoreShape,
} from "../persistence/Services/CompositionTaskInputStore.ts";
import {
  CompositionTaskStore,
  type CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import {
  makeCompositionAgentDriverRegistry,
  type CompositionAgentDriverRegistry,
} from "./CompositionAgentDriverRegistry.ts";
import {
  makeSqliteCapabilityGrantRegistry,
  type CapabilityGrantRegistryShape,
} from "./CapabilityGrantRegistry.ts";
import { makeCompositionCapabilityRegistry } from "./CapabilityRegistry.ts";
import {
  CompositionAgentDriverFailure,
  makeCompositionOrchestrator,
  type CompositionAgentDriver,
  type CompositionOrchestrator,
} from "./CompositionOrchestrator.ts";
import { makeCompositionRunStartDigests } from "./CompositionRunStartLifecycle.ts";
import { runCompositionRunStartRecoveryScheduler } from "./CompositionRunStartRecoveryScheduler.ts";
import { recoverCompositionRunStarts } from "./CompositionRunStartStartupRecovery.ts";

const reconciled = new Set(["provider-sessions", "ide-sessions", "runtime-adapters"] as const);

const makePersistentRecoveryLayer = (dbPath: string, baseDir: string) => {
  const persistence = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));
  const secretStore = ServerSecretStore.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provide(NodeServices.layer),
  );
  return Layer.mergeAll(
    CompositionTaskStoreLive,
    CompositionRunStartStoreLive,
    CompositionTaskInputStoreLive,
  ).pipe(Layer.provideMerge(persistence), Layer.provideMerge(secretStore));
};

const makeFixture = (suffix: string, capabilityIds: ReadonlyArray<string> = []) => {
  const task: CompositionTask = {
    taskId: `task-run-start-restart-${suffix}`,
    projectId: `project-run-start-restart-${suffix}`,
    assigneeKind: "agent",
    assigneeId: `agent-run-start-restart-${suffix}`,
    mode: "serial",
    status: "queued",
    promptDigest: `sha256:prompt-run-start-restart-${suffix}`,
    dependsOnTaskIds: [],
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
  };
  const run: CompositionTaskRun = {
    taskId: task.taskId,
    runId: `run-run-start-restart-${suffix}`,
    agentId: task.assigneeId,
    runtimeId: `runtime-run-start-restart-${suffix}`,
    status: "queued",
    attempt: 1,
    capabilityGrantIds: [],
  };
  const workspaceRootDigest = `sha256:workspace-run-start-restart-${suffix}`;
  const model = `model-run-start-restart-${suffix}`;
  const externalTargetIdentity = {
    runtimeKind: "provider",
    providerInstanceId: `provider-run-start-restart-${suffix}`,
    adapterId: run.runtimeId,
    modelIdentity: model,
    configDigest: null,
    sessionMode: "test",
  };
  const recoveryInput: CompositionTaskRecoveryInput = {
    taskId: task.taskId,
    prompt: `跨重启恢复 ${suffix}`,
    workspaceRoot: `C:/workspace/run-start-restart-${suffix}`,
    workspaceRootDigest,
    model,
    capabilityIds,
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
    workspaceRootDigest,
    model,
    externalTargetIdentity,
    capabilityIds,
  });
  return {
    task,
    run,
    capabilityIds,
    workspaceRootDigest,
    model,
    externalTargetIdentity,
    recoveryInput,
    digests,
    dispatchInput: {
      taskId: task.taskId,
      runId: run.runId,
      projectId: task.projectId,
      assigneeKind: task.assigneeKind,
      assigneeId: task.assigneeId,
      mode: task.mode,
      promptDigest: task.promptDigest,
      dependsOnTaskIds: task.dependsOnTaskIds,
      workspaceRoot: recoveryInput.workspaceRoot,
      workspaceRootDigest,
      prompt: recoveryInput.prompt,
      model,
      capabilityIds,
    },
  };
};

type FreshRuntime = {
  readonly taskStore: CompositionTaskStoreShape;
  readonly runStartStore: CompositionRunStartStoreShape;
  readonly inputStore: CompositionTaskInputStoreShape;
  readonly driverRegistry: CompositionAgentDriverRegistry;
  readonly grantRegistry: CapabilityGrantRegistryShape;
  readonly sql: SqlClient.SqlClient;
  readonly orchestrator: CompositionOrchestrator;
};

const withFreshRuntime = <A, E, R>(
  dbPath: string,
  baseDir: string,
  use: (runtime: FreshRuntime) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(makePersistentRecoveryLayer(dbPath, baseDir));
      const taskStore = Context.get(context, CompositionTaskStore);
      const runStartStore = Context.get(context, CompositionRunStartStore);
      const inputStore = Context.get(context, CompositionTaskInputStore);
      const sql = Context.get(context, SqlClient.SqlClient);
      const driverRegistry = makeCompositionAgentDriverRegistry();
      const grantRegistry = makeSqliteCapabilityGrantRegistry({
        capabilityRegistry: makeCompositionCapabilityRegistry(),
        sql,
      });
      const orchestrator = makeCompositionOrchestrator(
        taskStore,
        driverRegistry,
        grantRegistry,
        inputStore,
        runStartStore,
      );
      return yield* use({
        taskStore,
        runStartStore,
        inputStore,
        driverRegistry,
        grantRegistry,
        sql,
        orchestrator,
      });
    }),
  );

const registerRecoveryDriver = (
  runtime: FreshRuntime,
  fixture: ReturnType<typeof makeFixture>,
  startTask: CompositionAgentDriver["startTask"],
) =>
  runtime.driverRegistry.register({
    agentId: fixture.run.agentId,
    runtimeId: fixture.run.runtimeId,
    getStartIdentity: () => fixture.externalTargetIdentity,
    startRecoveryPolicy: {
      mode: "idempotent-replay",
      requiredReceipt: "runtime-task",
      capabilityGrantReplay: { mode: "none" },
    },
    startTask,
    cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
  });

const failAfterMarkDispatching = (
  store: CompositionRunStartStoreShape,
): CompositionRunStartStoreShape => ({
  ...store,
  markDispatching: (input) =>
    store.markDispatching(input).pipe(
      Effect.flatMap(() =>
        Effect.fail(
          new PersistenceSqlError({
            operation: "CompositionRunStartStartupRecovery.integration.setup",
            detail: "测试注入：markDispatching 已执行后回滚 setup 事务。",
          }),
        ),
      ),
    ),
});

const interruptDispatchWithFreshRuntime = (
  dbPath: string,
  baseDir: string,
  fixture: ReturnType<typeof makeFixture>,
  options?: { readonly persistAcceptedReceipt?: boolean; readonly saveLegacyInput?: boolean },
) => {
  let starts = 0;
  return withFreshRuntime(dbPath, baseDir, (runtime) =>
    Effect.gen(function* () {
      const startEntered = yield* Deferred.make<void>();
      yield* registerRecoveryDriver(runtime, fixture, () =>
        Effect.gen(function* () {
          starts += 1;
          yield* Deferred.succeed(startEntered, undefined);
          return yield* Effect.never;
        }),
      );
      yield* runtime.orchestrator.dispatchTask(fixture.dispatchInput).pipe(Effect.forkScoped);
      yield* Deferred.await(startEntered);

      const dispatching = Option.getOrThrow(
        yield* runtime.runStartStore.getStart(fixture.run.runId),
      );
      assert.equal(dispatching.state, "dispatching");
      assert.equal(
        Option.getOrThrow(yield* runtime.taskStore.getTask(fixture.task.taskId)).status,
        "queued",
      );
      assert.equal(
        Option.getOrThrow(yield* runtime.taskStore.getRun(fixture.run.runId)).status,
        "queued",
      );

      if (options?.saveLegacyInput === true) {
        yield* runtime.inputStore.save({
          taskId: fixture.recoveryInput.taskId,
          prompt: fixture.recoveryInput.prompt,
          workspaceRoot: fixture.recoveryInput.workspaceRoot,
          workspaceRootDigest: fixture.workspaceRootDigest,
          model: fixture.model,
        });
        assert.isUndefined(
          Option.getOrThrow(yield* runtime.inputStore.get(fixture.recoveryInput.taskId))
            .capabilityIds,
        );
      }
      if (options?.persistAcceptedReceipt === true) {
        const accepted = yield* runtime.runStartStore.recordAccepted({
          runId: dispatching.runId,
          expectedRevision: dispatching.revision,
          claimId: dispatching.claimId ?? "",
          ownerEpoch: dispatching.ownerEpoch,
          runtimeTaskId: `runtime-task-${fixture.run.runId}`,
          capabilityHandshakeId: null,
          acceptedAtUnixMs: dispatching.updatedAtUnixMs + 1,
        });
        assert.equal(accepted.state, "accepted");
      }

      return starts;
    }),
  );
};

const persistInterruptedDispatch = (
  layer: ReturnType<typeof makePersistentRecoveryLayer>,
  fixture: ReturnType<typeof makeFixture>,
  recoveryInput: CompositionTaskRecoveryInput,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer);
      const taskStore = Context.get(context, CompositionTaskStore);
      const runStartStore = Context.get(context, CompositionRunStartStore);
      const inputStore = Context.get(context, CompositionTaskInputStore);
      yield* taskStore.upsertTask(fixture.task);
      yield* taskStore.upsertRun(fixture.run);
      yield* inputStore.save(recoveryInput);
      const prepared = yield* runStartStore.prepareStart({
        taskId: fixture.task.taskId,
        runId: fixture.run.runId,
        previousRunId: null,
        agentId: fixture.run.agentId,
        runtimeId: fixture.run.runtimeId,
        attempt: fixture.run.attempt,
        ...fixture.digests,
        createdAtUnixMs: 1,
      });
      const claimed = yield* runStartStore.claimPrepared({
        runId: fixture.run.runId,
        expectedRevision: prepared.revision,
        claimId: `claim-run-start-restart-${fixture.run.runId}`,
        claimedAtUnixMs: 2,
        leaseExpiresAtUnixMs: 10,
      });
      yield* runStartStore.markDispatching({
        runId: fixture.run.runId,
        expectedRevision: claimed.intent.revision,
        claimId: claimed.intent.claimId ?? "",
        ownerEpoch: claimed.intent.ownerEpoch,
        dispatchedAtUnixMs: 3,
      });
    }),
  );

const recoverWithFreshRuntime = (
  dbPath: string,
  baseDir: string,
  fixture: ReturnType<typeof makeFixture>,
  starts: { value: number },
  startTask: CompositionAgentDriver["startTask"] = () =>
    Effect.sync(() => {
      starts.value += 1;
      return { runtimeTaskId: `runtime-task-${fixture.run.runId}` };
    }),
) => {
  return withFreshRuntime(dbPath, baseDir, (runtime) =>
    Effect.gen(function* () {
      yield* registerRecoveryDriver(runtime, fixture, startTask);
      const recover = () =>
        recoverCompositionRunStarts({
          runStartStore: runtime.runStartStore,
          taskStore: runtime.taskStore,
          inputStore: runtime.inputStore,
          driverRegistry: runtime.driverRegistry,
          reconciled,
          executor: {
            execute: runtime.orchestrator.recoverPersistedRunStart,
            recordUnrecoverable: runtime.orchestrator.recordPersistedRunStartRecoveryProblem,
          },
        });
      const recovery = yield* recover();
      return {
        recovery,
        intent: Option.getOrThrow(yield* runtime.runStartStore.getStart(fixture.run.runId)),
        task: Option.getOrThrow(yield* runtime.taskStore.getTask(fixture.task.taskId)),
        run: Option.getOrThrow(yield* runtime.taskStore.getRun(fixture.run.runId)),
        events: yield* runtime.taskStore.listEvents(fixture.task.taskId, fixture.run.runId),
        manualRecoveries: yield* runtime.runStartStore.listManualRecoveries({ limit: 10 }),
      };
    }),
  );
};

it.effect("setup 中途失败跨重启后，Task 到 grant 要么全部提交要么全部不存在", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "codework-run-start-atomic-" });
      const dbPath = path.join(tempDir, "state.sqlite");
      const capabilityIds = ["t3.workspace.read_file"];
      const committedFixture = makeFixture("setup-committed", capabilityIds);
      const rolledBackFixture = makeFixture("setup-rolled-back", capabilityIds);

      yield* withFreshRuntime(dbPath, tempDir, (runtime) =>
        Effect.gen(function* () {
          const committedStartEntered = yield* Deferred.make<void>();
          yield* registerRecoveryDriver(runtime, committedFixture, () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(committedStartEntered, undefined);
              return yield* Effect.never;
            }),
          );
          yield* runtime.orchestrator
            .dispatchTask(committedFixture.dispatchInput)
            .pipe(Effect.forkScoped);
          yield* Deferred.await(committedStartEntered);

          let rolledBackStarts = 0;
          yield* registerRecoveryDriver(runtime, rolledBackFixture, () =>
            Effect.sync(() => {
              rolledBackStarts += 1;
              return { runtimeTaskId: "unexpected-setup-rollback-start" };
            }),
          );
          const failingOrchestrator = makeCompositionOrchestrator(
            runtime.taskStore,
            runtime.driverRegistry,
            runtime.grantRegistry,
            runtime.inputStore,
            failAfterMarkDispatching(runtime.runStartStore),
          );
          const failed = yield* Effect.result(
            failingOrchestrator.dispatchTask(rolledBackFixture.dispatchInput),
          );

          assert.equal(failed._tag, "Failure");
          assert.equal(rolledBackStarts, 0);
        }),
      );

      yield* withFreshRuntime(dbPath, tempDir, (runtime) =>
        Effect.gen(function* () {
          const committedTask = Option.getOrThrow(
            yield* runtime.taskStore.getTask(committedFixture.task.taskId),
          );
          const committedRun = Option.getOrThrow(
            yield* runtime.taskStore.getRun(committedFixture.run.runId),
          );
          const committedInput = Option.getOrThrow(
            yield* runtime.inputStore.get(committedFixture.task.taskId),
          );
          const committedIntent = Option.getOrThrow(
            yield* runtime.runStartStore.getStart(committedFixture.run.runId),
          );
          const committedEvents = yield* runtime.taskStore.listEvents(
            committedFixture.task.taskId,
            committedFixture.run.runId,
          );
          const committedLease = yield* runtime.taskStore.getLease(committedRun.leaseId ?? "");
          const [committedGrantCount] = yield* runtime.sql<{ readonly count: number }>`
            SELECT COUNT(*) AS "count"
            FROM composition_capability_grants
            WHERE task_id = ${committedFixture.task.taskId}
          `;

          assert.equal(committedTask.status, "queued");
          assert.equal(committedRun.status, "queued");
          assert.deepEqual(committedInput.capabilityIds, capabilityIds);
          assert.equal(committedIntent.state, "dispatching");
          assert.equal(committedEvents.length, 2);
          assert.isTrue(Option.isSome(committedLease));
          assert.equal(committedRun.capabilityGrantIds?.length, 1);
          assert.equal(committedGrantCount?.count ?? 0, 1);

          assert.isTrue(
            Option.isNone(yield* runtime.taskStore.getTask(rolledBackFixture.task.taskId)),
          );
          assert.isTrue(
            Option.isNone(yield* runtime.taskStore.getRun(rolledBackFixture.run.runId)),
          );
          assert.isTrue(
            Option.isNone(yield* runtime.inputStore.get(rolledBackFixture.task.taskId)),
          );
          assert.isTrue(
            Option.isNone(yield* runtime.runStartStore.getStart(rolledBackFixture.run.runId)),
          );
          assert.deepEqual(
            yield* runtime.taskStore.listEvents(
              rolledBackFixture.task.taskId,
              rolledBackFixture.run.runId,
            ),
            [],
          );
          const [rolledBackLeaseCount] = yield* runtime.sql<{ readonly count: number }>`
            SELECT COUNT(*) AS "count"
            FROM composition_runtime_leases
            WHERE task_id = ${rolledBackFixture.task.taskId}
          `;
          const [rolledBackGrantCount] = yield* runtime.sql<{ readonly count: number }>`
            SELECT COUNT(*) AS "count"
            FROM composition_capability_grants
            WHERE task_id = ${rolledBackFixture.task.taskId}
          `;
          assert.equal(rolledBackLeaseCount?.count ?? 0, 0);
          assert.equal(rolledBackGrantCount?.count ?? 0, 0);
        }),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("第一套 Runtime 在真实 dispatch 中断后，后续全新 Runtime 只重放一次", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "codework-run-start-runtime-" });
      const dbPath = path.join(tempDir, "state.sqlite");
      const fixture = makeFixture("replay-once");
      const replayStarts = { value: 0 };

      const firstRuntimeStarts = yield* interruptDispatchWithFreshRuntime(dbPath, tempDir, fixture);
      assert.equal(firstRuntimeStarts, 1);

      yield* TestClock.adjust("60001 millis");
      const recovered = yield* recoverWithFreshRuntime(dbPath, tempDir, fixture, replayStarts);
      const rescanned = yield* recoverWithFreshRuntime(dbPath, tempDir, fixture, replayStarts);

      assert.equal(recovered.recovery.plans[0]?.action, "replay");
      assert.deepEqual(rescanned.recovery.plans, []);
      assert.equal(replayStarts.value, 1);
      assert.equal(recovered.intent.state, "settled");
      assert.equal(recovered.task.status, "running");
      assert.equal(recovered.run.status, "running");
      assert.equal(rescanned.intent.state, "settled");
      assert.equal(
        recovered.events.filter((event) => event.summary === "服务启动后已恢复 Run Start").length,
        1,
      );
      assert.equal(
        rescanned.events.filter((event) => event.summary === "服务启动后已恢复 Run Start").length,
        1,
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("Driver 恢复失败的 failed 事件跨重启只写入一次", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "codework-run-start-failed-" });
      const dbPath = path.join(tempDir, "state.sqlite");
      const fixture = makeFixture("failed-event-once");
      const recoveryStarts = { value: 0 };

      yield* interruptDispatchWithFreshRuntime(dbPath, tempDir, fixture);
      yield* TestClock.adjust("60001 millis");
      const failStart: CompositionAgentDriver["startTask"] = () =>
        Effect.sync(() => {
          recoveryStarts.value += 1;
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new CompositionAgentDriverFailure({
                code: "restart_driver_failed",
                detail: "跨重启 Driver 恢复失败。",
              }),
            ),
          ),
        );
      const recovered = yield* recoverWithFreshRuntime(
        dbPath,
        tempDir,
        fixture,
        recoveryStarts,
        failStart,
      );
      const rescanned = yield* recoverWithFreshRuntime(
        dbPath,
        tempDir,
        fixture,
        recoveryStarts,
        failStart,
      );

      assert.equal(recoveryStarts.value, 1);
      assert.equal(recovered.intent.state, "settled");
      assert.equal(recovered.intent.outcomeCode, "restart_driver_failed");
      assert.equal(recovered.task.status, "failed");
      assert.equal(recovered.run.status, "failed");
      assert.deepEqual(rescanned.recovery.plans, []);
      assert.equal(
        recovered.events.filter((event) => event.summary === "服务启动恢复 Run Start 失败").length,
        1,
      );
      assert.equal(
        rescanned.events.filter((event) => event.summary === "服务启动恢复 Run Start 失败").length,
        1,
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("离线 Driver 候选不会阻断同批健康 Driver 跨重启恢复", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "codework-run-start-batch-" });
      const dbPath = path.join(tempDir, "state.sqlite");
      const offlineFixture = makeFixture("a-offline-driver");
      const healthyFixture = makeFixture("b-healthy-driver");

      yield* interruptDispatchWithFreshRuntime(dbPath, tempDir, offlineFixture);
      yield* interruptDispatchWithFreshRuntime(dbPath, tempDir, healthyFixture);
      yield* TestClock.adjust("60001 millis");

      let healthyStarts = 0;
      const recovered = yield* withFreshRuntime(dbPath, tempDir, (runtime) =>
        Effect.gen(function* () {
          yield* registerRecoveryDriver(runtime, healthyFixture, () =>
            Effect.sync(() => {
              healthyStarts += 1;
              return { runtimeTaskId: `runtime-task-${healthyFixture.run.runId}` };
            }),
          );
          const receipt = yield* recoverCompositionRunStarts({
            runStartStore: runtime.runStartStore,
            taskStore: runtime.taskStore,
            inputStore: runtime.inputStore,
            driverRegistry: runtime.driverRegistry,
            reconciled,
            executor: {
              execute: runtime.orchestrator.recoverPersistedRunStart,
              recordUnrecoverable: runtime.orchestrator.recordPersistedRunStartRecoveryProblem,
            },
          });
          return {
            receipt,
            offlineIntent: Option.getOrThrow(
              yield* runtime.runStartStore.getStart(offlineFixture.run.runId),
            ),
            healthyIntent: Option.getOrThrow(
              yield* runtime.runStartStore.getStart(healthyFixture.run.runId),
            ),
            healthyRun: Option.getOrThrow(
              yield* runtime.taskStore.getRun(healthyFixture.run.runId),
            ),
          };
        }),
      );

      const offlinePlan = recovered.receipt.plans.find(
        (plan) => plan.runId === offlineFixture.run.runId,
      );
      const healthyPlan = recovered.receipt.plans.find(
        (plan) => plan.runId === healthyFixture.run.runId,
      );
      assert.equal(offlinePlan?.action, "defer");
      assert.equal(offlinePlan?.code, "run_start_agent_driver_unavailable");
      assert.equal(healthyPlan?.action, "replay");
      assert.equal(healthyStarts, 1);
      assert.equal(recovered.offlineIntent.state, "dispatching");
      assert.equal(recovered.healthyIntent.state, "settled");
      assert.equal(recovered.healthyRun.status, "running");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("空扫描进入 idle 后会发现另一 SQLite 连接写入的 dispatching 意图", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "codework-run-start-idle-" });
      const dbPath = path.join(tempDir, "state.sqlite");
      const writerLayer = makePersistentRecoveryLayer(dbPath, tempDir);
      const fixture = makeFixture("idle-external-write");
      const initialReceipt = yield* withFreshRuntime(dbPath, tempDir, (runtime) =>
        recoverCompositionRunStarts({
          runStartStore: runtime.runStartStore,
          taskStore: runtime.taskStore,
          inputStore: runtime.inputStore,
          driverRegistry: runtime.driverRegistry,
          reconciled,
          executor: {
            execute: runtime.orchestrator.recoverPersistedRunStart,
            recordUnrecoverable: runtime.orchestrator.recordPersistedRunStartRecoveryProblem,
          },
        }),
      );
      assert.deepEqual(initialReceipt.plans, []);
      assert.isUndefined(initialReceipt.nextRecoveryAtUnixMs);

      yield* persistInterruptedDispatch(writerLayer, fixture, fixture.recoveryInput);

      const scheduled = yield* withFreshRuntime(dbPath, tempDir, (runtime) =>
        Effect.gen(function* () {
          let starts = 0;
          yield* registerRecoveryDriver(runtime, fixture, () =>
            Effect.sync(() => {
              starts += 1;
              return { runtimeTaskId: `runtime-task-${fixture.run.runId}` };
            }),
          );
          const recover = () =>
            recoverCompositionRunStarts({
              runStartStore: runtime.runStartStore,
              taskStore: runtime.taskStore,
              inputStore: runtime.inputStore,
              driverRegistry: runtime.driverRegistry,
              reconciled,
              executor: {
                execute: runtime.orchestrator.recoverPersistedRunStart,
                recordUnrecoverable: runtime.orchestrator.recordPersistedRunStartRecoveryProblem,
              },
            });
          const changes = yield* Queue.sliding<void>(1);
          const idleSweepCompleted = yield* Deferred.make<void>();
          let scheduledScans = 0;
          yield* runCompositionRunStartRecoveryScheduler({
            initialReceipt,
            changes,
            recover: Effect.sync(() => {
              scheduledScans += 1;
            }).pipe(
              Effect.andThen(recover()),
              Effect.tap(() => Deferred.succeed(idleSweepCompleted, undefined)),
            ),
          }).pipe(Effect.forkScoped);
          yield* Effect.yieldNow;

          yield* TestClock.adjust("29999 millis");
          assert.equal(scheduledScans, 0);
          assert.equal(starts, 0);
          assert.isFalse(yield* Deferred.isDone(idleSweepCompleted));
          assert.equal(
            Option.getOrThrow(yield* runtime.runStartStore.getStart(fixture.run.runId)).state,
            "dispatching",
          );

          yield* TestClock.adjust("1 millis");
          yield* Deferred.await(idleSweepCompleted);
          return {
            scheduledScans,
            starts,
            intent: Option.getOrThrow(yield* runtime.runStartStore.getStart(fixture.run.runId)),
          };
        }),
      );

      assert.equal(scheduled.scheduledScans, 1);
      assert.equal(scheduled.starts, 1);
      assert.equal(scheduled.intent.state, "settled");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("accepted receipt 遇旧密文缺 capabilityIds 时跨重启进入 manual_pending", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "codework-run-start-legacy-" });
      const dbPath = path.join(tempDir, "state.sqlite");
      const fixture = makeFixture("legacy-capabilities");
      const recoveryStarts = { value: 0 };

      const firstRuntimeStarts = yield* interruptDispatchWithFreshRuntime(
        dbPath,
        tempDir,
        fixture,
        { persistAcceptedReceipt: true, saveLegacyInput: true },
      );
      assert.equal(firstRuntimeStarts, 1);

      yield* TestClock.adjust("60001 millis");
      const recovered = yield* recoverWithFreshRuntime(dbPath, tempDir, fixture, recoveryStarts);
      const rescanned = yield* recoverWithFreshRuntime(dbPath, tempDir, fixture, recoveryStarts);

      assert.equal(recoveryStarts.value, 0);
      assert.equal(
        recovered.recovery.plans[0]?.code,
        "run_start_legacy_input_capabilities_unknown",
      );
      assert.equal(recovered.intent.state, "manual_pending");
      assert.equal(recovered.intent.runtimeTaskId, `runtime-task-${fixture.run.runId}`);
      assert.equal(recovered.intent.outcomeCode, "run_start_legacy_input_capabilities_unknown");
      assert.equal(recovered.task.status, "waiting_input");
      assert.equal(recovered.run.status, "waiting_input");
      assert.deepEqual(rescanned.recovery.plans, []);
      assert.equal(rescanned.intent.state, "manual_pending");
      assert.equal(rescanned.manualRecoveries.length, 1);
      assert.equal(rescanned.manualRecoveries[0]?.runId, fixture.run.runId);
      assert.equal(
        rescanned.manualRecoveries[0]?.outcomeCode,
        "run_start_legacy_input_capabilities_unknown",
      );
      assert.equal(
        rescanned.manualRecoveries[0]?.runtimeTaskId,
        `runtime-task-${fixture.run.runId}`,
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
