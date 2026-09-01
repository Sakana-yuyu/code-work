import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { CompositionRunStartStoreLive } from "../persistence/Layers/CompositionRunStartStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  CompositionRunStartStore,
  type CompositionRunStartStoreShape,
} from "../persistence/Services/CompositionRunStartStore.ts";
import type { CompositionTaskInputStoreShape } from "../persistence/Services/CompositionTaskInputStore.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import { makeCompositionOrchestrator } from "./CompositionOrchestrator.ts";

const layer = it.layer(
  Layer.mergeAll(CompositionTaskStoreLive, CompositionRunStartStoreLive).pipe(
    Layer.provide(SqlitePersistenceMemory),
  ),
);

const recoveryPolicy = {
  mode: "idempotent-replay",
  requiredReceipt: "runtime-task",
} as const;

const makeDispatchInput = (suffix: string) => ({
  taskId: `task-run-start-entry-${suffix}`,
  runId: `run-run-start-entry-${suffix}`,
  projectId: "project-run-start-entry",
  assigneeKind: "agent" as const,
  assigneeId: `agent-run-start-entry-${suffix}`,
  mode: "serial" as const,
  promptDigest: `sha256:prompt-run-start-entry-${suffix}`,
  dependsOnTaskIds: [] as const,
  prompt: "验证初次派发的持久启动所有权",
  workspaceRoot: `C:/workspace/run-start-entry-${suffix}`,
  workspaceRootDigest: `sha256:workspace-run-start-entry-${suffix}`,
  capabilityIds: ["t3.workspace.read_file"] as const,
});

const makeInputStore = (counters?: { saves: number; removes: number }) =>
  ({
    save: () =>
      Effect.sync(() => {
        if (counters !== undefined) counters.saves += 1;
      }),
    get: () => Effect.succeed(Option.none()),
    remove: () =>
      Effect.sync(() => {
        if (counters !== undefined) counters.removes += 1;
      }),
  }) satisfies CompositionTaskInputStoreShape;

const guardRecoveryClaim = (store: CompositionRunStartStoreShape) => {
  let count = 0;
  return {
    store: {
      ...store,
      claimDispatchRecovery: (input: Parameters<typeof store.claimDispatchRecovery>[0]) => {
        count += 1;
        return store.claimDispatchRecovery(input);
      },
    },
    readCount: () => count,
  };
};

const makeDriverRegistry = (input: {
  readonly agentId: string;
  readonly started: string[];
  readonly start?: Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const registry = makeCompositionAgentDriverRegistry();
    yield* registry.register({
      agentId: input.agentId,
      runtimeId: `runtime-${input.agentId}`,
      startRecoveryPolicy: recoveryPolicy,
      startTask: ({ run }) =>
        Effect.gen(function* () {
          input.started.push(run.runId);
          if (input.start !== undefined) yield* input.start;
          return { runtimeTaskId: `runtime-task-${run.runId}` };
        }),
      cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
    });
    return registry;
  });

const seedBlockedReadyTask = (suffix: string) =>
  Effect.gen(function* () {
    const store = yield* CompositionTaskStore;
    const taskId = `task-run-start-blocked-${suffix}`;
    const runId = `run-run-start-blocked-${suffix}`;
    const agentId = `agent-run-start-blocked-${suffix}`;
    const dependencyId = `task-run-start-blocked-${suffix}-dependency`;
    yield* store.upsertTask({
      taskId: dependencyId,
      projectId: "project-run-start-blocked",
      assigneeKind: "agent",
      assigneeId: agentId,
      mode: "serial",
      status: "completed",
      promptDigest: `sha256:${dependencyId}`,
      dependsOnTaskIds: [],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 2,
      finishedAtUnixMs: 2,
    });
    yield* store.upsertTask({
      taskId,
      projectId: "project-run-start-blocked",
      assigneeKind: "agent",
      assigneeId: agentId,
      mode: "serial",
      status: "blocked",
      promptDigest: `sha256:${taskId}`,
      dependsOnTaskIds: [dependencyId],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 2,
    });
    yield* store.upsertRun({
      taskId,
      runId,
      agentId,
      runtimeId: `runtime-${agentId}`,
      status: "blocked",
      attempt: 1,
      capabilityGrantIds: [],
    });
    return { taskId, runId, agentId };
  });

const makeBlockedInputStore = (taskId: string): CompositionTaskInputStoreShape => ({
  save: () => Effect.void,
  get: (requestedTaskId) =>
    Effect.succeed(
      requestedTaskId === taskId
        ? Option.some({
            taskId,
            prompt: "验证 blocked-ready 的持久启动所有权",
            workspaceRoot: "C:/workspace/run-start-blocked",
            workspaceRootDigest: `sha256:workspace-run-start-blocked:${taskId}`,
            capabilityIds: [],
          })
        : Option.none(),
    ),
  remove: () => Effect.void,
});

layer("Composition Run Start entry ownership", (it) => {
  it.effect("并发初次派发在首个原子 setup 提交后拒绝第二请求且不重复副作用", () =>
    Effect.gen(function* () {
      const input = makeDispatchInput("concurrent");
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const started: string[] = [];
      const driverRegistry = yield* makeDriverRegistry({ agentId: input.assigneeId, started });
      const firstIssueEntered = yield* Deferred.make<void>();
      const releaseFirstIssue = yield* Deferred.make<void>();
      const inputCounters = { saves: 0, removes: 0 };
      const recoveryClaim = guardRecoveryClaim(runStartStore);
      let issueCount = 0;
      const grantRegistry = {
        issue: ({ taskId, agentId }: { readonly taskId: string; readonly agentId: string }) =>
          Effect.gen(function* () {
            issueCount += 1;
            const current = issueCount;
            if (current === 1) {
              yield* Deferred.succeed(firstIssueEntered, undefined);
              yield* Deferred.await(releaseFirstIssue);
            }
            return [
              {
                grantId: `grant-run-start-entry-${current}`,
                taskId,
                agentId,
                capabilityId: "t3.workspace.read_file",
                issuedAtUnixMs: 10,
                expiresAtUnixMs: 1_000,
              },
            ];
          }),
        revoke: () => Effect.void,
      };
      const firstOrchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        grantRegistry,
        makeInputStore(inputCounters),
        recoveryClaim.store,
      );
      const secondOrchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        grantRegistry,
        makeInputStore(inputCounters),
        recoveryClaim.store,
      );

      const first = yield* Effect.forkChild(Effect.result(firstOrchestrator.dispatchTask(input)));
      yield* Deferred.await(firstIssueEntered);
      const second = yield* Effect.forkChild(Effect.result(secondOrchestrator.dispatchTask(input)));
      yield* Deferred.succeed(releaseFirstIssue, undefined);
      const firstResult = yield* Fiber.join(first);
      const secondResult = yield* Fiber.join(second);

      assert.equal(inputCounters.saves, 1);
      assert.equal(issueCount, 1);
      assert.equal(recoveryClaim.readCount(), 0);
      assert.deepEqual(started, [input.runId]);
      assert.equal(firstResult._tag, "Success");
      assert.equal(secondResult._tag, "Failure");
      if (secondResult._tag === "Failure") {
        assert.equal(secondResult.failure._tag, "CompositionTaskAlreadyExistsError");
      }
    }),
  );

  it.effect("初次派发 claim 已落库但尚未返回时中断不得产生后续副作用", () =>
    Effect.gen(function* () {
      const input = makeDispatchInput("claim-commit-interrupted");
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const started: string[] = [];
      const driverRegistry = yield* makeDriverRegistry({ agentId: input.assigneeId, started });
      const claimCommitted = yield* Deferred.make<void>();
      const releaseClaimReturn = yield* Deferred.make<void>();
      const interruptRequested = yield* Deferred.make<void>();
      const inputCounters = { saves: 0, removes: 0 };
      let issueCount = 0;
      const hookedRunStartStore = {
        ...runStartStore,
        claimPrepared: (claimInput: Parameters<typeof runStartStore.claimPrepared>[0]) =>
          Effect.gen(function* () {
            const claimed = yield* runStartStore.claimPrepared(claimInput);
            yield* Deferred.succeed(claimCommitted, undefined);
            yield* Deferred.await(releaseClaimReturn);
            return claimed;
          }),
      };
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        {
          issue: () =>
            Effect.sync(() => {
              issueCount += 1;
              return [];
            }),
          revoke: () => Effect.void,
        },
        makeInputStore(inputCounters),
        hookedRunStartStore,
      );

      const dispatchFiber = yield* Effect.forkChild(orchestrator.dispatchTask(input));
      yield* Deferred.await(claimCommitted);
      const interruptFiber = yield* Effect.forkChild(
        Deferred.succeed(interruptRequested, undefined).pipe(
          Effect.andThen(Fiber.interrupt(dispatchFiber)),
        ),
      );
      yield* Deferred.await(interruptRequested);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseClaimReturn, undefined);
      yield* Fiber.join(interruptFiber);

      assert.isTrue(Option.isNone(yield* runStartStore.getStart(input.runId)));
      assert.equal(inputCounters.saves, 0);
      assert.equal(issueCount, 0);
      assert.deepEqual(started, []);
      assert.isTrue(Option.isNone(yield* store.getTask(input.taskId)));
      assert.isTrue(Option.isNone(yield* store.getRun(input.runId)));
    }),
  );

  it.effect("blocked-ready 的两个 Orchestrator 共用持久 owner 时只启动一次", () =>
    Effect.gen(function* () {
      const seeded = yield* seedBlockedReadyTask("concurrent");
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const firstStartEntered = yield* Deferred.make<void>();
      const releaseFirstStart = yield* Deferred.make<void>();
      let startCount = 0;
      const started: string[] = [];
      const driverRegistry = yield* makeDriverRegistry({
        agentId: seeded.agentId,
        started,
        start: Effect.gen(function* () {
          startCount += 1;
          if (startCount === 1) {
            yield* Deferred.succeed(firstStartEntered, undefined);
            yield* Deferred.await(releaseFirstStart);
          }
        }),
      });
      const inputStore = makeBlockedInputStore(seeded.taskId);
      const recoveryClaim = guardRecoveryClaim(runStartStore);
      const firstOrchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        inputStore,
        recoveryClaim.store,
      );
      const secondOrchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        inputStore,
        recoveryClaim.store,
      );

      const first = yield* Effect.forkChild(Effect.result(firstOrchestrator.resumeReadyTasks()));
      yield* Deferred.await(firstStartEntered);
      const secondResult = yield* Effect.result(secondOrchestrator.resumeReadyTasks());
      yield* Deferred.succeed(releaseFirstStart, undefined);
      const firstResult = yield* Fiber.join(first);

      assert.equal(startCount, 1);
      assert.equal(recoveryClaim.readCount(), 0);
      assert.deepEqual(started, [seeded.runId]);
      assert.equal(firstResult._tag, "Success");
      assert.equal(secondResult._tag, "Success");
      if (secondResult._tag === "Success") assert.deepEqual(secondResult.success, []);
    }),
  );

  it.effect("blocked-ready claim 已落库但尚未返回时中断会释放 owner 且不启动 Driver", () =>
    Effect.gen(function* () {
      const seeded = yield* seedBlockedReadyTask("claim-commit-interrupted");
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const started: string[] = [];
      const driverRegistry = yield* makeDriverRegistry({ agentId: seeded.agentId, started });
      const claimCommitted = yield* Deferred.make<void>();
      const releaseClaimReturn = yield* Deferred.make<void>();
      const interruptRequested = yield* Deferred.make<void>();
      const hookedRunStartStore = {
        ...runStartStore,
        claimPrepared: (claimInput: Parameters<typeof runStartStore.claimPrepared>[0]) =>
          Effect.gen(function* () {
            const claimed = yield* runStartStore.claimPrepared(claimInput);
            yield* Deferred.succeed(claimCommitted, undefined);
            yield* Deferred.await(releaseClaimReturn);
            return claimed;
          }),
      };
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        makeBlockedInputStore(seeded.taskId),
        hookedRunStartStore,
      );

      const resumeFiber = yield* Effect.forkChild(orchestrator.resumeReadyTasks());
      yield* Deferred.await(claimCommitted);
      const interruptFiber = yield* Effect.forkChild(
        Deferred.succeed(interruptRequested, undefined).pipe(
          Effect.andThen(Fiber.interrupt(resumeFiber)),
        ),
      );
      yield* Deferred.await(interruptRequested);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseClaimReturn, undefined);
      yield* Fiber.join(interruptFiber);

      assert.isTrue(Option.isNone(yield* runStartStore.getStart(seeded.runId)));
      assert.deepEqual(started, []);
      assert.equal(Option.getOrThrow(yield* store.getTask(seeded.taskId)).status, "blocked");
      assert.equal(Option.getOrThrow(yield* store.getRun(seeded.runId)).status, "blocked");
    }),
  );

  it.effect("blocked-ready 调用 Driver 前已持久化 queued、lease 与 dispatching", () =>
    Effect.gen(function* () {
      const seeded = yield* seedBlockedReadyTask("durable-queued-before-driver");
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const startEntered = yield* Deferred.make<void>();
      const releaseStart = yield* Deferred.make<void>();
      const started: string[] = [];
      const driverRegistry = yield* makeDriverRegistry({
        agentId: seeded.agentId,
        started,
        start: Deferred.succeed(startEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseStart)),
        ),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        makeBlockedInputStore(seeded.taskId),
        runStartStore,
      );

      const resumeFiber = yield* Effect.forkChild(Effect.result(orchestrator.resumeReadyTasks()));
      yield* Deferred.await(startEntered);

      const task = Option.getOrThrow(yield* store.getTask(seeded.taskId));
      const run = Option.getOrThrow(yield* store.getRun(seeded.runId));
      const intent = Option.getOrThrow(yield* runStartStore.getStart(seeded.runId));
      assert.equal(task.status, "queued");
      assert.equal(run.status, "queued");
      assert.isDefined(run.leaseId);
      assert.equal(intent.state, "dispatching");

      yield* Deferred.succeed(releaseStart, undefined);
      const result = yield* Fiber.join(resumeFiber);
      assert.equal(result._tag, "Success");
      assert.deepEqual(started, [seeded.runId]);
    }),
  );

  it.effect("外部启动超过初始租约时持续续租且其他恢复实例不能接管", () =>
    Effect.gen(function* () {
      const input = makeDispatchInput("owner-heartbeat");
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const startEntered = yield* Deferred.make<void>();
      const releaseStart = yield* Deferred.make<void>();
      const started: string[] = [];
      const driverRegistry = yield* makeDriverRegistry({
        agentId: input.assigneeId,
        started,
        start: Deferred.succeed(startEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseStart)),
        ),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        makeInputStore(),
        runStartStore,
      );

      const dispatch = yield* Effect.forkChild(orchestrator.dispatchTask(input));
      yield* Deferred.await(startEntered);
      const before = Option.getOrThrow(yield* runStartStore.getStart(input.runId));
      assert.equal(before.state, "dispatching");
      assert.notEqual(before.ownerLeaseExpiresAtUnixMs, null);

      yield* TestClock.adjust("61 seconds");
      yield* Effect.yieldNow;

      const renewed = Option.getOrThrow(yield* runStartStore.getStart(input.runId));
      assert.equal(renewed.state, "dispatching");
      assert.isTrue(
        (renewed.ownerLeaseExpiresAtUnixMs ?? 0) > (before.ownerLeaseExpiresAtUnixMs ?? 0),
      );
      const competingClaim = yield* runStartStore.claimDispatchRecovery({
        runId: input.runId,
        expectedRevision: renewed.revision,
        claimId: "startup-recovery:competing-owner",
        claimedAtUnixMs: 61_000,
        leaseExpiresAtUnixMs: 121_000,
      });
      assert.isFalse(competingClaim.claimed);
      assert.equal(competingClaim.intent.claimId, renewed.claimId);

      yield* Deferred.succeed(releaseStart, undefined);
      yield* Fiber.join(dispatch);

      const settled = Option.getOrThrow(yield* runStartStore.getStart(input.runId));
      assert.equal(settled.state, "settled");
      assert.deepEqual(started, [input.runId]);
    }),
  );
});
