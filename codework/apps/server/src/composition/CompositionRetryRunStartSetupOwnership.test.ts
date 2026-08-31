import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import { CompositionRunStartStore } from "../persistence/Services/CompositionRunStartStore.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import type { CompositionTaskStoreShape } from "../persistence/Services/CompositionTaskStore.ts";
import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import { makeCompositionOrchestrator } from "./CompositionOrchestrator.ts";
import {
  compositionOrchestratorRunStartTestLayer,
  makeRunStartRecoveryInputStore,
  makeRunStartRetryRequest,
  seedFailedRunStart,
} from "./CompositionOrchestratorRunStartTestSupport.ts";

const layer = it.layer(compositionOrchestratorRunStartTestLayer);

const runtimeTaskPolicy = {
  mode: "idempotent-replay" as const,
  capabilityGrantReplay: { mode: "verified" as const },
  requiredReceipt: "runtime-task" as const,
};

layer("Composition Retry Run Start Setup Ownership", (it) => {
  it.effect("本地授权签发未完成前不得把 RunStart 标记为 dispatching", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-setup-owner-grant",
        previousRunId: "run-setup-owner-grant-old",
        runId: "run-setup-owner-grant-new",
        agentId: "agent-setup-owner-grant",
        runtimeId: "runtime-setup-owner-grant",
        prompt: "验证本地 setup 与外部 dispatch 的状态边界",
        workspaceRoot: "C:/workspace/setup-owner-grant",
      };
      yield* seedFailedRunStart(store, input);

      const issueStarted = yield* Deferred.make<void>();
      const releaseIssue = yield* Deferred.make<void>();
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
          Effect.sync(() => {
            startCalls += 1;
            return { runtimeTaskId: "runtime-task-setup-owner-grant" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        {
          issue: ({ taskId, agentId, capabilityIds }) =>
            Deferred.succeed(issueStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseIssue)),
              Effect.as(
                capabilityIds.map((capabilityId) => ({
                  grantId: `grant-${capabilityId}`,
                  taskId,
                  agentId,
                  capabilityId,
                  issuedAtUnixMs: 10,
                  expiresAtUnixMs: 60_010,
                })),
              ),
            ),
        },
        makeRunStartRecoveryInputStore(input.taskId, input.prompt, input.workspaceRoot),
        runStartStore,
      );

      const retryFiber = yield* orchestrator
        .retryTask(makeRunStartRetryRequest(input.taskId, input.previousRunId, input.runId))
        .pipe(Effect.forkChild);
      yield* Deferred.await(issueStarted);

      yield* Effect.gen(function* () {
        const intent = Option.getOrThrow(yield* runStartStore.getStart(input.runId));
        assert.notEqual(intent.state, "dispatching");
        assert.equal(startCalls, 0);
      }).pipe(Effect.ensuring(Deferred.succeed(releaseIssue, undefined).pipe(Effect.asVoid)));

      const retried = yield* Fiber.join(retryFiber);
      assert.equal(retried.task.status, "running");
      assert.equal(retried.run.status, "running");
      assert.equal(startCalls, 1);
    }),
  );

  it.effect("本地授权签发等待被中断时释放 setup 所有权且不留下新 Run", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-setup-owner-interrupted",
        previousRunId: "run-setup-owner-interrupted-old",
        runId: "run-setup-owner-interrupted-new",
        agentId: "agent-setup-owner-interrupted",
        runtimeId: "runtime-setup-owner-interrupted",
        prompt: "验证 setup 中断补偿",
        workspaceRoot: "C:/workspace/setup-owner-interrupted",
      };
      yield* seedFailedRunStart(store, input);
      const taskBefore = Option.getOrThrow(yield* store.getTask(input.taskId));
      const previousRunBefore = Option.getOrThrow(yield* store.getRun(input.previousRunId));

      const issueStarted = yield* Deferred.make<void>();
      const neverRelease = yield* Deferred.make<void>();
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
          Effect.sync(() => {
            startCalls += 1;
            return { runtimeTaskId: "runtime-task-setup-owner-interrupted" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        {
          issue: () =>
            Deferred.succeed(issueStarted, undefined).pipe(
              Effect.andThen(Deferred.await(neverRelease)),
              Effect.as([]),
            ),
        },
        makeRunStartRecoveryInputStore(input.taskId, input.prompt, input.workspaceRoot),
        runStartStore,
      );

      const retryFiber = yield* orchestrator
        .retryTask(makeRunStartRetryRequest(input.taskId, input.previousRunId, input.runId))
        .pipe(Effect.forkChild);
      yield* Deferred.await(issueStarted);
      yield* Fiber.interrupt(retryFiber);

      const intent = Option.getOrThrow(yield* runStartStore.getStart(input.runId));
      assert.equal(intent.state, "prepared");
      assert.equal(intent.claimId, null);
      assert.deepEqual(Option.getOrThrow(yield* store.getTask(input.taskId)), taskBefore);
      assert.deepEqual(
        Option.getOrThrow(yield* store.getRun(input.previousRunId)),
        previousRunBefore,
      );
      assert.isTrue(Option.isNone(yield* store.getRun(input.runId)));
      assert.equal(startCalls, 0);
    }),
  );

  it.effect("授权签发后 queued 投影事务失败时撤销新 grant", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-setup-grant-compensation",
        previousRunId: "run-setup-grant-compensation-old",
        runId: "run-setup-grant-compensation-new",
        agentId: "agent-setup-grant-compensation",
        runtimeId: "runtime-setup-grant-compensation",
        prompt: "验证 grant 补偿",
        workspaceRoot: "C:/workspace/setup-grant-compensation",
      };
      yield* seedFailedRunStart(store, input);

      const failingStore = {
        ...store,
        appendEventIfNew: (event) =>
          event.sourceEventId === `capgrant:${input.taskId}:${input.runId}:issued`
            ? Effect.fail(
                new PersistenceSqlError({
                  operation: "CompositionRetryRunStartSetupOwnership.test",
                  detail: "模拟 queued 投影事务失败",
                }),
              )
            : store.appendEventIfNew(event),
      } satisfies CompositionTaskStoreShape;
      const revokedGrantIds: string[] = [];
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: runtimeTaskPolicy,
        startTask: () => Effect.die("queued 投影失败后不得调用 Driver"),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        failingStore,
        driverRegistry,
        {
          issue: () =>
            Effect.succeed([
              {
                grantId: "grant-setup-compensation",
                taskId: input.taskId,
                agentId: input.agentId,
                capabilityId: "t3.workspace.read_file",
                issuedAtUnixMs: 10,
                expiresAtUnixMs: 60_010,
              },
            ]),
          revoke: ({ grantId }) =>
            Effect.sync(() => {
              revokedGrantIds.push(grantId);
            }),
        },
        makeRunStartRecoveryInputStore(input.taskId, input.prompt, input.workspaceRoot),
        runStartStore,
      );

      const result = yield* Effect.result(
        orchestrator.retryTask(
          makeRunStartRetryRequest(input.taskId, input.previousRunId, input.runId),
        ),
      );

      assert.equal(result._tag, "Failure");
      assert.deepEqual(revokedGrantIds, ["grant-setup-compensation"]);
      assert.isTrue(Option.isNone(yield* store.getRun(input.runId)));
      const intent = Option.getOrThrow(yield* runStartStore.getStart(input.runId));
      assert.equal(intent.state, "prepared");
      assert.equal(intent.claimId, null);
    }),
  );
});
