import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CompositionRunStartStore } from "../persistence/Services/CompositionRunStartStore.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import { makeCompositionOrchestrator } from "./CompositionOrchestrator.ts";
import {
  compositionOrchestratorRunStartTestLayer,
  makeRunStartRecoveryInputStore,
  makeRunStartRetryRequest,
  seedFailedRunStart,
} from "./CompositionOrchestratorRunStartTestSupport.ts";
import { seedDispatchingStart } from "./CompositionRetryRunStartDispatchRecoveryTestSupport.ts";

const layer = it.layer(compositionOrchestratorRunStartTestLayer);

layer("Composition Retry Run Start Receipt Validation", (it) => {
  it.effect("首次 BYOK accept 缺少 runtimeTaskId 时转未知且不写 running", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-receipt-first-byok",
        previousRunId: "run-receipt-first-byok-old",
        runId: "run-receipt-first-byok-new",
        agentId: "agent-receipt-first-byok",
        runtimeId: "runtime-receipt-first-byok",
        prompt: "首次 BYOK receipt 必须完整",
        workspaceRoot: "C:/workspace/receipt-first-byok",
      };
      yield* seedFailedRunStart(store, input);
      let startCalls = 0;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: {
          mode: "fail-closed",
          reasonCode: "byok_start_replay_unsafe",
          requiredReceipt: "runtime-task",
        },
        startTask: () =>
          Effect.sync(() => {
            startCalls += 1;
            return {};
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        makeRunStartRecoveryInputStore(input.taskId, input.prompt, input.workspaceRoot),
        runStartStore,
      );

      const result = yield* Effect.result(
        orchestrator.retryTask(
          makeRunStartRetryRequest(input.taskId, input.previousRunId, input.runId),
        ),
      );
      const intent = Option.getOrThrow(yield* runStartStore.getStart(input.runId));
      const task = Option.getOrThrow(yield* store.getTask(input.taskId));
      const run = Option.getOrThrow(yield* store.getRun(input.runId));

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "CompositionAgentDriverFailure");
        if (result.failure._tag === "CompositionAgentDriverFailure") {
          assert.equal(result.failure.code, "run_start_runtime_task_receipt_missing");
        }
      }
      assert.equal(startCalls, 1);
      assert.equal(intent.state, "indeterminate");
      assert.equal(intent.outcomeCode, "run_start_runtime_task_receipt_missing");
      assert.equal(task.status, "queued");
      assert.equal(run.status, "queued");
      assert.equal(run.runtimeTaskId, undefined);
    }),
  );

  it.effect("跨重启 accepted IDE receipt 缺少 handshake 时拒绝投影与 settle", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-receipt-accepted-ide",
        previousRunId: "run-receipt-accepted-ide-old",
        runId: "run-receipt-accepted-ide-new",
        agentId: "agent-receipt-accepted-ide",
        runtimeId: "runtime-receipt-accepted-ide",
        prompt: "accepted IDE receipt 必须完整",
        workspaceRoot: "C:/workspace/receipt-accepted-ide",
      };
      const seeded = yield* seedDispatchingStart({ store, runStartStore, ...input });
      const claimId = seeded.dispatching.claimId;
      if (claimId === null) return yield* Effect.die("dispatching seed 缺少 claimId");
      yield* runStartStore.markAccepted({
        runId: input.runId,
        expectedRevision: seeded.dispatching.revision,
        claimId,
        runtimeTaskId: "runtime-task-receipt-accepted-ide",
        acceptedAtUnixMs: 12,
      });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: {
          mode: "fail-closed",
          reasonCode: "ide_start_replay_unsafe",
          requiredReceipt: "runtime-task-and-handshake",
        },
        startTask: () => Effect.die("accepted receipt 恢复不得再次启动 IDE Driver"),
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
      const task = Option.getOrThrow(yield* store.getTask(input.taskId));
      const run = Option.getOrThrow(yield* store.getRun(input.runId));

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "CompositionTaskRetryInvalidError");
        if (result.failure._tag === "CompositionTaskRetryInvalidError") {
          assert.equal(result.failure.reason, "run_start_capability_handshake_receipt_missing");
        }
      }
      assert.equal(intent.state, "accepted");
      assert.equal(task.status, "queued");
      assert.equal(run.status, "queued");
      assert.equal(run.runtimeTaskId, undefined);
    }),
  );

  it.effect("跨重启 accepted Provider 带 grants 缺少 handshake 时拒绝投影与 settle", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-receipt-accepted-provider",
        previousRunId: "run-receipt-accepted-provider-old",
        runId: "run-receipt-accepted-provider-new",
        agentId: "agent-receipt-accepted-provider",
        runtimeId: "runtime-receipt-accepted-provider",
        prompt: "accepted Provider receipt 必须完整",
        workspaceRoot: "C:/workspace/receipt-accepted-provider",
      };
      const seeded = yield* seedDispatchingStart({
        store,
        runStartStore,
        ...input,
        capabilityGrantIds: ["grant-receipt-accepted-provider"],
      });
      const claimId = seeded.dispatching.claimId;
      if (claimId === null) return yield* Effect.die("dispatching seed 缺少 claimId");
      yield* runStartStore.markAccepted({
        runId: input.runId,
        expectedRevision: seeded.dispatching.revision,
        claimId,
        runtimeTaskId: "runtime-task-receipt-accepted-provider",
        acceptedAtUnixMs: 12,
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
        startTask: () => Effect.die("accepted receipt 恢复不得再次启动 Provider Driver"),
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
      const task = Option.getOrThrow(yield* store.getTask(input.taskId));
      const run = Option.getOrThrow(yield* store.getRun(input.runId));

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "CompositionTaskRetryInvalidError");
        if (result.failure._tag === "CompositionTaskRetryInvalidError") {
          assert.equal(result.failure.reason, "run_start_capability_handshake_receipt_missing");
        }
      }
      assert.equal(intent.state, "accepted");
      assert.equal(task.status, "queued");
      assert.equal(run.status, "queued");
      assert.equal(run.runtimeTaskId, undefined);
    }),
  );

  it.effect("首次 accept 未声明 Driver 恢复策略时转未知", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-receipt-policy-missing",
        previousRunId: "run-receipt-policy-missing-old",
        runId: "run-receipt-policy-missing-new",
        agentId: "agent-receipt-policy-missing",
        runtimeId: "runtime-receipt-policy-missing",
        prompt: "Driver 必须声明恢复策略",
        workspaceRoot: "C:/workspace/receipt-policy-missing",
      };
      yield* seedFailedRunStart(store, input);
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startTask: () => Effect.succeed({ runtimeTaskId: "runtime-task-receipt-policy-missing" }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        makeRunStartRecoveryInputStore(input.taskId, input.prompt, input.workspaceRoot),
        runStartStore,
      );

      const result = yield* Effect.result(
        orchestrator.retryTask(
          makeRunStartRetryRequest(input.taskId, input.previousRunId, input.runId),
        ),
      );
      const intent = Option.getOrThrow(yield* runStartStore.getStart(input.runId));

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "CompositionAgentDriverFailure");
        if (result.failure._tag === "CompositionAgentDriverFailure") {
          assert.equal(result.failure.code, "driver_start_recovery_policy_missing");
        }
      }
      assert.equal(intent.state, "indeterminate");
      assert.equal(intent.outcomeCode, "driver_start_recovery_policy_missing");
      assert.equal(Option.getOrThrow(yield* store.getTask(input.taskId)).status, "queued");
      assert.equal(Option.getOrThrow(yield* store.getRun(input.runId)).status, "queued");
    }),
  );

  it.effect("accepted intent 恢复时目标 Driver 不存在则稳定失败", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-receipt-driver-missing",
        previousRunId: "run-receipt-driver-missing-old",
        runId: "run-receipt-driver-missing-new",
        agentId: "agent-receipt-driver-missing",
        runtimeId: "runtime-receipt-driver-missing",
        prompt: "accepted intent 必须绑定当前 Driver",
        workspaceRoot: "C:/workspace/receipt-driver-missing",
      };
      const seeded = yield* seedDispatchingStart({ store, runStartStore, ...input });
      const claimId = seeded.dispatching.claimId;
      if (claimId === null) return yield* Effect.die("dispatching seed 缺少 claimId");
      yield* runStartStore.markAccepted({
        runId: input.runId,
        expectedRevision: seeded.dispatching.revision,
        claimId,
        runtimeTaskId: "runtime-task-receipt-driver-missing",
        acceptedAtUnixMs: 12,
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        makeCompositionAgentDriverRegistry(),
        undefined,
        makeRunStartRecoveryInputStore(input.taskId, input.prompt, input.workspaceRoot),
        runStartStore,
      );

      const result = yield* Effect.result(orchestrator.recoverRunStart(seeded.request));

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "CompositionTaskRetryInvalidError");
        if (result.failure._tag === "CompositionTaskRetryInvalidError") {
          assert.equal(result.failure.reason, "agent_driver_unavailable");
        }
      }
      assert.equal(Option.getOrThrow(yield* runStartStore.getStart(input.runId)).state, "accepted");
      assert.equal(Option.getOrThrow(yield* store.getRun(input.runId)).runtimeTaskId, undefined);
    }),
  );

  it.effect("accepted intent 与当前 Driver runtime 身份不一致时稳定失败", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-receipt-driver-runtime-conflict",
        previousRunId: "run-receipt-driver-runtime-conflict-old",
        runId: "run-receipt-driver-runtime-conflict-new",
        agentId: "agent-receipt-driver-runtime-conflict",
        runtimeId: "runtime-receipt-driver-runtime-conflict",
        prompt: "accepted intent 拒绝 runtime 漂移",
        workspaceRoot: "C:/workspace/receipt-driver-runtime-conflict",
      };
      const seeded = yield* seedDispatchingStart({ store, runStartStore, ...input });
      const claimId = seeded.dispatching.claimId;
      if (claimId === null) return yield* Effect.die("dispatching seed 缺少 claimId");
      yield* runStartStore.markAccepted({
        runId: input.runId,
        expectedRevision: seeded.dispatching.revision,
        claimId,
        runtimeTaskId: "runtime-task-receipt-driver-runtime-conflict",
        acceptedAtUnixMs: 12,
      });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: "runtime-foreign",
        startRecoveryPolicy: {
          mode: "fail-closed",
          reasonCode: "runtime_start_replay_not_verified",
          requiredReceipt: "runtime-task",
        },
        startTask: () => Effect.die("runtime 身份冲突不得再次启动 Driver"),
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

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "CompositionTaskRetryInvalidError");
        if (result.failure._tag === "CompositionTaskRetryInvalidError") {
          assert.equal(result.failure.reason, "run_start_driver_identity_conflict");
        }
      }
      assert.equal(Option.getOrThrow(yield* runStartStore.getStart(input.runId)).state, "accepted");
      assert.equal(Option.getOrThrow(yield* store.getRun(input.runId)).runtimeTaskId, undefined);
    }),
  );
});
