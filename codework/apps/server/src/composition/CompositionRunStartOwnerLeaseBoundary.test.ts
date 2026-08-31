import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { CompositionRunStartStoreLive } from "../persistence/Layers/CompositionRunStartStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CompositionRunStartStore } from "../persistence/Services/CompositionRunStartStore.ts";
import { CompositionAgentDriverFailure } from "./CompositionOrchestrator.ts";
import {
  runCompositionWithPersistedStart,
  type CompositionRunStartSetup,
} from "./CompositionRunStartCoordinator.ts";
import { withCompositionRunStartOwnerLease } from "./CompositionRunStartOwnerLease.ts";

const layer = it.layer(CompositionRunStartStoreLive.pipe(Layer.provide(SqlitePersistenceMemory)));

const recoveryPolicy = {
  mode: "idempotent-replay" as const,
  requiredReceipt: "runtime-task" as const,
};

const makeSetup = (suffix: string): CompositionRunStartSetup => ({
  taskId: `task-${suffix}`,
  projectId: `project-${suffix}`,
  threadId: null,
  parentTaskId: null,
  runId: `run-${suffix}`,
  previousRunId: null,
  assigneeKind: "agent",
  assigneeId: `agent-${suffix}`,
  mode: "serial",
  dependsOnTaskIds: [],
  agentId: `agent-${suffix}`,
  runtimeId: `runtime-${suffix}`,
  attempt: 1,
  promptDigest: `sha256:${suffix}`,
  workspaceRootDigest: `sha256:workspace-${suffix}`,
  model: null,
  externalTargetIdentity: null,
  capabilityIds: [],
});

const makeFailure = (failure: { readonly code: string; readonly detail: string }) =>
  new CompositionAgentDriverFailure(failure);

layer("Composition Run Start owner lease 边界", (it) => {
  it.effect("owner heartbeat 使用当前 revision 续租且不推进 revision", () =>
    Effect.gen(function* () {
      const runStartStore = yield* CompositionRunStartStore;
      const setup = makeSetup("owner-boundary-revision");
      const prepared = yield* runStartStore.prepareStart({
        taskId: setup.taskId,
        runId: setup.runId,
        previousRunId: setup.previousRunId,
        agentId: setup.agentId,
        runtimeId: setup.runtimeId,
        attempt: setup.attempt,
        payloadDigest: "sha256:owner-boundary-revision-payload",
        capabilityDigest: "sha256:owner-boundary-revision-capability",
        createdAtUnixMs: 1,
      });
      const preparing = yield* runStartStore.claimPrepared({
        runId: setup.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-owner-boundary-revision",
        claimedAtUnixMs: 2,
        leaseExpiresAtUnixMs: 60_002,
      });
      const dispatching = yield* runStartStore.markDispatching({
        runId: setup.runId,
        expectedRevision: preparing.intent.revision,
        claimId: preparing.intent.claimId ?? "",
        ownerEpoch: preparing.intent.ownerEpoch,
        dispatchedAtUnixMs: 3,
      });
      const heartbeatRevision = yield* Deferred.make<number>();
      const release = yield* Deferred.make<void>();
      const hookedStore = {
        ...runStartStore,
        renewOwnerLease: (input: Parameters<typeof runStartStore.renewOwnerLease>[0]) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(heartbeatRevision, input.expectedRevision);
            return yield* runStartStore.renewOwnerLease(input);
          }),
      };

      const ownerFiber = yield* Effect.forkChild(
        withCompositionRunStartOwnerLease(hookedStore, dispatching, Deferred.await(release)),
      );
      yield* TestClock.adjust("20 seconds");
      yield* Effect.yieldNow;

      assert.equal(yield* Deferred.await(heartbeatRevision), dispatching.revision);
      assert.equal(
        Option.getOrThrow(yield* runStartStore.getStart(setup.runId)).revision,
        dispatching.revision,
      );

      yield* Deferred.succeed(release, undefined);
      const result = yield* Effect.result(Fiber.join(ownerFiber));
      assert.equal(result._tag, "Success");
    }),
  );

  it.effect("accepted 持久化后业务投影跨过心跳周期仍由原调用完成结算", () =>
    Effect.gen(function* () {
      const runStartStore = yield* CompositionRunStartStore;
      const acceptedRecorded = yield* Deferred.make<void>();
      const releaseProjection = yield* Deferred.make<void>();
      const setup = makeSetup("owner-boundary-accepted");

      const dispatchFiber = yield* Effect.forkChild(
        runCompositionWithPersistedStart({
          store: runStartStore,
          setup,
          policy: recoveryPolicy,
          capabilityGrantIds: [],
          start: Effect.succeed({ runtimeTaskId: "runtime-task-owner-boundary-accepted" }),
          onAccepted: () => Effect.succeed("accepted"),
          onAcceptedWithReceipt: (_receipt, recordAccepted) =>
            Effect.gen(function* () {
              const accepted = yield* recordAccepted;
              yield* Deferred.succeed(acceptedRecorded, undefined);
              yield* Deferred.await(releaseProjection);
              return { accepted, result: "accepted" };
            }),
          onRejected: (failure) => Effect.fail(failure),
          makeFailure,
        }),
      );

      yield* Deferred.await(acceptedRecorded);
      assert.equal(Option.getOrThrow(yield* runStartStore.getStart(setup.runId)).state, "accepted");

      yield* TestClock.adjust("20 seconds");
      yield* Effect.yieldNow;
      const beforeRelease = dispatchFiber.pollUnsafe();

      yield* Deferred.succeed(releaseProjection, undefined);
      const result = yield* Effect.result(Fiber.join(dispatchFiber));

      assert.isUndefined(beforeRelease);
      assert.equal(result._tag, "Success");
      if (result._tag === "Success") {
        assert.equal(result.success, "accepted");
      }
      assert.equal(Option.getOrThrow(yield* runStartStore.getStart(setup.runId)).state, "settled");
    }),
  );

  it.effect("Driver 拒绝落库后跨过心跳周期仍返回原始失败", () =>
    Effect.gen(function* () {
      const runStartStore = yield* CompositionRunStartStore;
      const rejectedRecorded = yield* Deferred.make<void>();
      const releaseRejection = yield* Deferred.make<void>();
      const setup = makeSetup("owner-boundary-rejected");
      const driverFailure = new CompositionAgentDriverFailure({
        code: "driver_start_rejected",
        detail: "Driver 明确拒绝启动。",
      });
      let startCount = 0;
      const hookedStore = {
        ...runStartStore,
        settleRejected: (input: Parameters<typeof runStartStore.settleRejected>[0]) =>
          Effect.gen(function* () {
            const settled = yield* runStartStore.settleRejected(input);
            yield* Deferred.succeed(rejectedRecorded, undefined);
            yield* Deferred.await(releaseRejection);
            return settled;
          }),
      };

      const dispatchFiber = yield* Effect.forkChild(
        runCompositionWithPersistedStart({
          store: hookedStore,
          setup,
          policy: recoveryPolicy,
          capabilityGrantIds: [],
          start: Effect.sync(() => {
            startCount += 1;
          }).pipe(Effect.andThen(Effect.fail(driverFailure))),
          onAccepted: () => Effect.succeed("accepted"),
          onRejected: (failure) => Effect.fail(failure),
          makeFailure,
        }),
      );

      yield* Deferred.await(rejectedRecorded);
      const rejectedIntent = Option.getOrThrow(yield* runStartStore.getStart(setup.runId));
      assert.equal(rejectedIntent.state, "settled");
      assert.equal(rejectedIntent.outcomeCode, "driver_start_rejected");

      yield* TestClock.adjust("20 seconds");
      yield* Effect.yieldNow;
      const beforeRelease = dispatchFiber.pollUnsafe();

      yield* Deferred.succeed(releaseRejection, undefined);
      const result = yield* Effect.result(Fiber.join(dispatchFiber));

      assert.isUndefined(beforeRelease);
      assert.equal(startCount, 1);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "CompositionAgentDriverFailure");
        if (result.failure._tag === "CompositionAgentDriverFailure") {
          assert.equal(result.failure.code, "driver_start_rejected");
        }
      }
    }),
  );

  it.effect("无效 receipt 隔离后跨过心跳周期仍返回稳定校验失败", () =>
    Effect.gen(function* () {
      const runStartStore = yield* CompositionRunStartStore;
      const quarantinedRecorded = yield* Deferred.make<void>();
      const releaseQuarantine = yield* Deferred.make<void>();
      const setup = makeSetup("owner-boundary-quarantine");
      let startCount = 0;
      let acceptedCount = 0;
      const hookedStore = {
        ...runStartStore,
        quarantine: (input: Parameters<typeof runStartStore.quarantine>[0]) =>
          Effect.gen(function* () {
            const quarantined = yield* runStartStore.quarantine(input);
            yield* Deferred.succeed(quarantinedRecorded, undefined);
            yield* Deferred.await(releaseQuarantine);
            return quarantined;
          }),
      };

      const dispatchFiber = yield* Effect.forkChild(
        runCompositionWithPersistedStart({
          store: hookedStore,
          setup,
          policy: recoveryPolicy,
          capabilityGrantIds: [],
          start: Effect.sync(() => {
            startCount += 1;
            return {};
          }),
          onAccepted: () =>
            Effect.sync(() => {
              acceptedCount += 1;
              return "accepted";
            }),
          onRejected: (failure) => Effect.fail(failure),
          makeFailure,
        }),
      );

      yield* Deferred.await(quarantinedRecorded);
      const quarantinedIntent = Option.getOrThrow(yield* runStartStore.getStart(setup.runId));
      assert.equal(quarantinedIntent.state, "quarantined");
      assert.equal(quarantinedIntent.outcomeCode, "run_start_runtime_task_receipt_missing");

      yield* TestClock.adjust("20 seconds");
      yield* Effect.yieldNow;
      const beforeRelease = dispatchFiber.pollUnsafe();

      yield* Deferred.succeed(releaseQuarantine, undefined);
      const result = yield* Effect.result(Fiber.join(dispatchFiber));

      assert.isUndefined(beforeRelease);
      assert.equal(startCount, 1);
      assert.equal(acceptedCount, 0);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "CompositionAgentDriverFailure");
        if (result.failure._tag === "CompositionAgentDriverFailure") {
          assert.equal(result.failure.code, "run_start_runtime_task_receipt_missing");
        }
      }
    }),
  );

  it.effect("旧 owner 被新 epoch 接管后不得先执行外部启动", () =>
    Effect.gen(function* () {
      const runStartStore = yield* CompositionRunStartStore;
      const setup = makeSetup("owner-boundary-takeover");
      const prepared = yield* runStartStore.prepareStart({
        taskId: setup.taskId,
        runId: setup.runId,
        previousRunId: setup.previousRunId,
        agentId: setup.agentId,
        runtimeId: setup.runtimeId,
        attempt: setup.attempt,
        payloadDigest: "sha256:owner-boundary-takeover-payload",
        capabilityDigest: "sha256:owner-boundary-takeover-capability",
        createdAtUnixMs: 1,
      });
      const firstOwner = yield* runStartStore.claimPrepared({
        runId: setup.runId,
        expectedRevision: prepared.revision,
        claimId: "claim-owner-boundary-first",
        claimedAtUnixMs: 2,
        leaseExpiresAtUnixMs: 10,
      });
      const dispatching = yield* runStartStore.markDispatching({
        runId: setup.runId,
        expectedRevision: firstOwner.intent.revision,
        claimId: firstOwner.intent.claimId ?? "",
        ownerEpoch: firstOwner.intent.ownerEpoch,
        dispatchedAtUnixMs: 3,
      });
      yield* TestClock.adjust("11 millis");
      const nextOwner = yield* runStartStore.claimDispatchRecovery({
        runId: setup.runId,
        expectedRevision: dispatching.revision,
        claimId: "claim-owner-boundary-next",
        claimedAtUnixMs: 11,
        leaseExpiresAtUnixMs: 60_011,
      });
      let starts = 0;

      const result = yield* Effect.result(
        withCompositionRunStartOwnerLease(
          runStartStore,
          dispatching,
          Effect.sync(() => {
            starts += 1;
          }),
        ),
      );

      assert.isTrue(nextOwner.claimed);
      assert.equal(nextOwner.intent.ownerEpoch, dispatching.ownerEpoch + 1);
      assert.equal(result._tag, "Failure");
      assert.equal(starts, 0);
    }),
  );
});
