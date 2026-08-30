import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import { CompositionRunStartStoreLive } from "../persistence/Layers/CompositionRunStartStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  CompositionRunStartStore,
  type CompositionRunStartStoreShape,
} from "../persistence/Services/CompositionRunStartStore.ts";
import type { CompositionTaskInputStoreShape } from "../persistence/Services/CompositionTaskInputStore.ts";
import {
  CompositionTaskStore,
  type CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import { makeCompositionOrchestrator } from "./CompositionOrchestrator.ts";

const layer = it.layer(
  Layer.mergeAll(CompositionTaskStoreLive, CompositionRunStartStoreLive).pipe(
    Layer.provide(SqlitePersistenceMemory),
  ),
);

const inputStore: CompositionTaskInputStoreShape = {
  save: () => Effect.void,
  get: (taskId) =>
    Effect.succeed(
      Option.some({
        taskId,
        prompt: "恢复持久 Run Start setup",
        workspaceRoot: "C:/workspace/run-start-setup",
        workspaceRootDigest: "sha256:workspace-run-start-setup",
        model: "provider/model",
      }),
    ),
  remove: () => Effect.void,
};

const makeRetryInput = (suffix: string) => ({
  taskId: `task-run-start-setup-${suffix}`,
  previousRunId: `run-run-start-setup-${suffix}-1`,
  runId: `run-run-start-setup-${suffix}-2`,
  agentId: `agent-run-start-setup-${suffix}-new`,
  reason: "验证持久 setup owner",
  capabilityIds: ["t3.workspace.read_file"],
});

const seedFailedRun = (
  store: CompositionTaskStoreShape,
  retryInput: ReturnType<typeof makeRetryInput>,
) =>
  Effect.gen(function* () {
    yield* store.upsertTask({
      taskId: retryInput.taskId,
      projectId: "project-run-start-setup",
      assigneeKind: "agent",
      assigneeId: "agent-run-start-setup-old",
      mode: "review",
      status: "failed",
      promptDigest: "sha256:prompt-run-start-setup",
      dependsOnTaskIds: [],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 2,
      finishedAtUnixMs: 2,
    });
    yield* store.upsertRun({
      taskId: retryInput.taskId,
      runId: retryInput.previousRunId,
      agentId: "agent-run-start-setup-old",
      runtimeId: "runtime-run-start-setup-old",
      status: "failed",
      attempt: 1,
      capabilityGrantIds: ["grant-run-start-setup-old"],
      failureCode: "review_rejected",
    });
  });

const makeDriverRegistry = (started: string[], retryInput: ReturnType<typeof makeRetryInput>) =>
  Effect.gen(function* () {
    const registry = makeCompositionAgentDriverRegistry();
    yield* registry.register({
      agentId: retryInput.agentId,
      runtimeId: "runtime-run-start-setup-new",
      startRecoveryPolicy: {
        mode: "idempotent-replay",
        requiredReceipt: "runtime-task",
      },
      startTask: (input) =>
        Effect.sync(() => {
          started.push(input.run.runId);
          return { runtimeTaskId: `runtime-task-${input.run.runId}` };
        }),
      cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
    });
    return registry;
  });

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

layer("Composition Run Start setup owner", (it) => {
  it.effect("并发 retry 在首个 owner 等待 grant 时不得重复签发或启动", () =>
    Effect.gen(function* () {
      const retryInput = makeRetryInput("concurrent");
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      yield* seedFailedRun(store, retryInput);
      const started: string[] = [];
      const driverRegistry = yield* makeDriverRegistry(started, retryInput);
      const firstIssueEntered = yield* Deferred.make<void>();
      const releaseFirstIssue = yield* Deferred.make<void>();
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
                grantId: `grant-run-start-setup-${current}`,
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
        inputStore,
        recoveryClaim.store,
      );
      const secondOrchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        grantRegistry,
        inputStore,
        recoveryClaim.store,
      );

      const first = yield* Effect.forkChild(Effect.result(firstOrchestrator.retryTask(retryInput)));
      yield* Deferred.await(firstIssueEntered);
      const second = yield* Effect.forkChild(
        Effect.result(secondOrchestrator.retryTask(retryInput)),
      );
      const secondResult = yield* Fiber.join(second);
      yield* Deferred.succeed(releaseFirstIssue, undefined);
      const firstResult = yield* Fiber.join(first);

      assert.equal(issueCount, 1);
      assert.equal(recoveryClaim.readCount(), 0);
      assert.equal(started.length, 1);
      assert.equal(firstResult._tag, "Success");
      if (firstResult._tag === "Success") {
        assert.equal(firstResult.success.run.runId, retryInput.runId);
      }
      assert.equal(secondResult._tag, "Failure");
      if (secondResult._tag === "Failure") {
        assert.equal(secondResult.failure._tag, "CompositionAgentDriverFailure");
        if (secondResult.failure._tag === "CompositionAgentDriverFailure") {
          assert.equal(secondResult.failure.code, "run_start_in_progress");
        }
      }
    }),
  );

  it.effect("setup claim 后等待 grant 时中断会释放 owner 且不创建新 Run", () =>
    Effect.gen(function* () {
      const retryInput = makeRetryInput("interrupted");
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      yield* seedFailedRun(store, retryInput);
      const started: string[] = [];
      const driverRegistry = yield* makeDriverRegistry(started, retryInput);
      const issueEntered = yield* Deferred.make<void>();
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        {
          issue: () =>
            Deferred.succeed(issueEntered, undefined).pipe(Effect.andThen(Effect.interrupt)),
          revoke: () => Effect.void,
        },
        inputStore,
        runStartStore,
      );

      const exit = yield* Effect.exit(orchestrator.retryTask(retryInput));

      assert.equal(exit._tag, "Failure");
      const intent = Option.getOrThrow(yield* runStartStore.getStart(retryInput.runId));
      assert.equal(intent.state, "prepared");
      assert.equal(intent.claimId, null);
      assert.isTrue(Option.isNone(yield* store.getRun(retryInput.runId)));
      assert.deepEqual(started, []);
    }),
  );

  it.effect("claim 已落库但尚未返回调用方时中断仍会释放 setup owner", () =>
    Effect.gen(function* () {
      const retryInput = makeRetryInput("claim-commit-interrupted");
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      yield* seedFailedRun(store, retryInput);
      const started: string[] = [];
      const driverRegistry = yield* makeDriverRegistry(started, retryInput);
      const claimCommitted = yield* Deferred.make<void>();
      const releaseClaimReturn = yield* Deferred.make<void>();
      const interruptRequested = yield* Deferred.make<void>();
      let issueCount = 0;
      const hookedRunStartStore = {
        ...runStartStore,
        claimPrepared: (input: Parameters<typeof runStartStore.claimPrepared>[0]) =>
          Effect.gen(function* () {
            const claimed = yield* runStartStore.claimPrepared(input);
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
        inputStore,
        hookedRunStartStore,
      );

      const retryFiber = yield* Effect.forkChild(orchestrator.retryTask(retryInput));
      yield* Deferred.await(claimCommitted);
      const interruptFiber = yield* Effect.forkChild(
        Deferred.succeed(interruptRequested, undefined).pipe(
          Effect.andThen(Fiber.interrupt(retryFiber)),
        ),
      );
      yield* Deferred.await(interruptRequested);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseClaimReturn, undefined);
      yield* Fiber.join(interruptFiber);

      const intent = Option.getOrThrow(yield* runStartStore.getStart(retryInput.runId));
      assert.equal(intent.state, "prepared");
      assert.equal(intent.claimId, null);
      assert.equal(issueCount, 0);
      assert.deepEqual(started, []);
    }),
  );

  it.effect("queued 投影失败会回滚新 Run 并撤销本次 grant", () =>
    Effect.gen(function* () {
      const retryInput = makeRetryInput("projection-failure");
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      yield* seedFailedRun(store, retryInput);
      const started: string[] = [];
      const revoked: string[] = [];
      const driverRegistry = yield* makeDriverRegistry(started, retryInput);
      const failingStore: CompositionTaskStoreShape = {
        ...store,
        appendEvent: (event) =>
          event.runId === retryInput.runId
            ? Effect.fail(
                new PersistenceSqlError({
                  operation: "CompositionRunStartSetupOwnership.test",
                  detail: "注入 queued 投影失败",
                }),
              )
            : store.appendEvent(event),
      };
      const orchestrator = makeCompositionOrchestrator(
        failingStore,
        driverRegistry,
        {
          issue: ({ taskId, agentId }) =>
            Effect.succeed([
              {
                grantId: "grant-run-start-setup-new",
                taskId,
                agentId,
                capabilityId: "t3.workspace.read_file",
                issuedAtUnixMs: 10,
                expiresAtUnixMs: 1_000,
              },
            ]),
          revoke: ({ grantId }) => Effect.sync(() => void revoked.push(grantId)),
        },
        inputStore,
        runStartStore,
      );

      const result = yield* Effect.result(orchestrator.retryTask(retryInput));

      assert.equal(result._tag, "Failure");
      assert.equal(Option.getOrThrow(yield* store.getTask(retryInput.taskId)).status, "failed");
      assert.isTrue(Option.isNone(yield* store.getRun(retryInput.runId)));
      assert.deepEqual(started, []);
      assert.include(revoked, "grant-run-start-setup-new");
      const intent = Option.getOrThrow(yield* runStartStore.getStart(retryInput.runId));
      assert.equal(intent.state, "prepared");
      assert.equal(intent.claimId, null);
    }),
  );
});
