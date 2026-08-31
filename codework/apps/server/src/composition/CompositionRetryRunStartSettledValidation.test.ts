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
} from "./CompositionOrchestratorRunStartTestSupport.ts";
import { seedDispatchingStart } from "./CompositionRetryRunStartDispatchRecoveryTestSupport.ts";

const layer = it.layer(compositionOrchestratorRunStartTestLayer);

const runtimeTaskPolicy = {
  mode: "fail-closed" as const,
  reasonCode: "runtime_start_replay_not_verified",
  requiredReceipt: "runtime-task" as const,
};

const seedSettledStart = (input: {
  readonly store: typeof CompositionTaskStore.Service;
  readonly runStartStore: typeof CompositionRunStartStore.Service;
  readonly taskId: string;
  readonly previousRunId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly runtimeId: string;
  readonly prompt: string;
  readonly workspaceRoot: string;
  readonly status: "queued" | "running";
  readonly projectedRuntimeTaskId?: string;
  readonly acceptedRuntimeTaskId?: string;
}) =>
  Effect.gen(function* () {
    const seeded = yield* seedDispatchingStart({
      store: input.store,
      runStartStore: input.runStartStore,
      taskId: input.taskId,
      previousRunId: input.previousRunId,
      runId: input.runId,
      agentId: input.agentId,
      runtimeId: input.runtimeId,
      prompt: input.prompt,
      workspaceRoot: input.workspaceRoot,
      status: input.status,
      ...(input.projectedRuntimeTaskId === undefined
        ? {}
        : { runtimeTaskId: input.projectedRuntimeTaskId }),
    });
    const claimId = seeded.dispatching.claimId;
    if (claimId === null) return yield* Effect.die("dispatching seed 缺少 claimId");
    const accepted = yield* input.runStartStore.markAccepted({
      runId: input.runId,
      expectedRevision: seeded.dispatching.revision,
      claimId,
      ...(input.acceptedRuntimeTaskId === undefined
        ? {}
        : { runtimeTaskId: input.acceptedRuntimeTaskId }),
      acceptedAtUnixMs: 12,
    });
    yield* input.runStartStore.settleStart({
      runId: input.runId,
      expectedRevision: accepted.revision,
      claimId,
      settledAtUnixMs: 13,
    });
    return seeded.request;
  });

const registerDriver = (
  driverRegistry: ReturnType<typeof makeCompositionAgentDriverRegistry>,
  input: { readonly agentId: string; readonly runtimeId: string },
) =>
  driverRegistry.register({
    agentId: input.agentId,
    runtimeId: input.runtimeId,
    startRecoveryPolicy: runtimeTaskPolicy,
    startTask: () => Effect.die("settled intent 不得再次启动 Driver"),
    cancelTask: () => Effect.succeed({ status: "already_terminal" as const }),
  });

layer("Composition Retry Run Start Settled Validation", (it) => {
  it.effect("settled intent 不得把 queued 投影当作已启动结果", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-settled-queued",
        previousRunId: "run-settled-queued-old",
        runId: "run-settled-queued-new",
        agentId: "agent-settled-queued",
        runtimeId: "runtime-settled-queued",
        prompt: "settled queued 必须关闭",
        workspaceRoot: "C:/workspace/settled-queued",
      };
      const request = yield* seedSettledStart({
        store,
        runStartStore,
        ...input,
        status: "queued",
        projectedRuntimeTaskId: "runtime-task-settled-queued",
        acceptedRuntimeTaskId: "runtime-task-settled-queued",
      });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* registerDriver(driverRegistry, input);
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        makeRunStartRecoveryInputStore(input.taskId, input.prompt, input.workspaceRoot),
        runStartStore,
      );

      const result = yield* Effect.result(orchestrator.recoverRunStart(request));
      const task = Option.getOrThrow(yield* store.getTask(input.taskId));
      const run = Option.getOrThrow(yield* store.getRun(input.runId));

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "CompositionTaskRetryInvalidError");
        if (result.failure._tag === "CompositionTaskRetryInvalidError") {
          assert.equal(result.failure.reason, "run_start_settled_projection_not_started");
        }
      }
      assert.equal(task.status, "queued");
      assert.equal(run.status, "queued");
      assert.equal(Option.getOrThrow(yield* runStartStore.getStart(input.runId)).state, "settled");
    }),
  );

  it.effect("settled intent 缺少必需 receipt 时稳定失败", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-settled-intent-receipt-missing",
        previousRunId: "run-settled-intent-receipt-missing-old",
        runId: "run-settled-intent-receipt-missing-new",
        agentId: "agent-settled-intent-receipt-missing",
        runtimeId: "runtime-settled-intent-receipt-missing",
        prompt: "settled intent receipt 必须完整",
        workspaceRoot: "C:/workspace/settled-intent-receipt-missing",
      };
      const request = yield* seedSettledStart({
        store,
        runStartStore,
        ...input,
        status: "running",
        projectedRuntimeTaskId: "runtime-task-settled-intent-receipt-missing",
      });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* registerDriver(driverRegistry, input);
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        makeRunStartRecoveryInputStore(input.taskId, input.prompt, input.workspaceRoot),
        runStartStore,
      );

      const result = yield* Effect.result(orchestrator.recoverRunStart(request));

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "CompositionTaskRetryInvalidError");
        if (result.failure._tag === "CompositionTaskRetryInvalidError") {
          assert.equal(result.failure.reason, "run_start_runtime_task_receipt_missing");
        }
      }
      assert.equal(
        Option.getOrThrow(yield* store.getRun(input.runId)).runtimeTaskId,
        "runtime-task-settled-intent-receipt-missing",
      );
    }),
  );

  it.effect("settled Run receipt 与 intent 不一致时稳定失败", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-settled-receipt-conflict",
        previousRunId: "run-settled-receipt-conflict-old",
        runId: "run-settled-receipt-conflict-new",
        agentId: "agent-settled-receipt-conflict",
        runtimeId: "runtime-settled-receipt-conflict",
        prompt: "settled receipt 冲突必须关闭",
        workspaceRoot: "C:/workspace/settled-receipt-conflict",
      };
      const request = yield* seedSettledStart({
        store,
        runStartStore,
        ...input,
        status: "running",
        projectedRuntimeTaskId: "runtime-task-settled-projection",
        acceptedRuntimeTaskId: "runtime-task-settled-intent",
      });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* registerDriver(driverRegistry, input);
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        makeRunStartRecoveryInputStore(input.taskId, input.prompt, input.workspaceRoot),
        runStartStore,
      );

      const result = yield* Effect.result(orchestrator.recoverRunStart(request));

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "CompositionTaskRetryInvalidError");
        if (result.failure._tag === "CompositionTaskRetryInvalidError") {
          assert.equal(result.failure.reason, "run_start_receipt_conflict");
        }
      }
      assert.equal(
        Option.getOrThrow(yield* store.getRun(input.runId)).runtimeTaskId,
        "runtime-task-settled-projection",
      );
    }),
  );

  it.effect("settled 已启动投影缺少 Run receipt 时按 intent 安全补齐", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-settled-receipt-backfill",
        previousRunId: "run-settled-receipt-backfill-old",
        runId: "run-settled-receipt-backfill-new",
        agentId: "agent-settled-receipt-backfill",
        runtimeId: "runtime-settled-receipt-backfill",
        prompt: "settled receipt 可安全补齐",
        workspaceRoot: "C:/workspace/settled-receipt-backfill",
      };
      const request = yield* seedSettledStart({
        store,
        runStartStore,
        ...input,
        status: "running",
        acceptedRuntimeTaskId: "runtime-task-settled-receipt-backfill",
      });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* registerDriver(driverRegistry, input);
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        makeRunStartRecoveryInputStore(input.taskId, input.prompt, input.workspaceRoot),
        runStartStore,
      );

      const recovered = yield* orchestrator.recoverRunStart(request);

      assert.equal(recovered.task.status, "running");
      assert.equal(recovered.run.status, "running");
      assert.equal(recovered.run.runtimeTaskId, "runtime-task-settled-receipt-backfill");
      assert.equal(
        Option.getOrThrow(yield* store.getRun(input.runId)).runtimeTaskId,
        "runtime-task-settled-receipt-backfill",
      );
      assert.equal(Option.getOrThrow(yield* runStartStore.getStart(input.runId)).state, "settled");
    }),
  );
});
