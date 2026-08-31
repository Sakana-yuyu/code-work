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

layer("Composition Retry Run Start Receipt Policy", (it) => {
  it.effect("BYOK 有 grants 时只要求 runtimeTaskId 即可结算已运行投影", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-dispatching-byok-receipt",
        previousRunId: "run-dispatching-byok-receipt-old",
        runId: "run-dispatching-byok-receipt-new",
        agentId: "agent-dispatching-byok-receipt",
        runtimeId: "runtime-dispatching-byok-receipt",
        prompt: "BYOK 不使用 capability handshake",
        workspaceRoot: "C:/workspace/dispatching-byok-receipt",
      };
      const seeded = yield* seedDispatchingStart({
        store,
        runStartStore,
        ...input,
        status: "running",
        runtimeTaskId: "runtime-task-dispatching-byok-receipt",
        capabilityGrantIds: ["grant-dispatching-byok-receipt"],
      });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: {
          mode: "fail-closed",
          reasonCode: "byok_start_replay_unsafe",
          requiredReceipt: "runtime-task",
        },
        startTask: () => Effect.die("已投影的 BYOK Run 不得再次启动"),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        undefined,
        makeRunStartRecoveryInputStore(input.taskId, input.prompt, input.workspaceRoot),
        runStartStore,
      );

      const recovered = yield* orchestrator.recoverRunStart(seeded.request);
      const intent = Option.getOrThrow(yield* runStartStore.getStart(input.runId));

      assert.equal(recovered.task.status, "running");
      assert.equal(recovered.run.runtimeTaskId, "runtime-task-dispatching-byok-receipt");
      assert.equal(recovered.run.capabilityHandshakeId, undefined);
      assert.equal(intent.state, "settled");
    }),
  );

  it.effect("仅有 capability handshake 且缺少 runtimeTaskId 时不得结算", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-dispatching-handshake-only",
        previousRunId: "run-dispatching-handshake-only-old",
        runId: "run-dispatching-handshake-only-new",
        agentId: "agent-dispatching-handshake-only",
        runtimeId: "runtime-dispatching-handshake-only",
        prompt: "拒绝不完整启动 receipt",
        workspaceRoot: "C:/workspace/dispatching-handshake-only",
      };
      const seeded = yield* seedDispatchingStart({
        store,
        runStartStore,
        ...input,
        status: "running",
        capabilityHandshakeId: "handshake-dispatching-only",
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
        startTask: () => Effect.die("不完整 receipt 不得触发 Driver"),
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

      assert.equal(result._tag, "Failure");
      assert.equal(intent.state, "indeterminate");
      assert.equal(intent.outcomeCode, "run_start_runtime_task_receipt_missing");
    }),
  );

  it.effect("IDE 即使没有 grants 也要求 capability handshake receipt", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-dispatching-ide-receipt",
        previousRunId: "run-dispatching-ide-receipt-old",
        runId: "run-dispatching-ide-receipt-new",
        agentId: "agent-dispatching-ide-receipt",
        runtimeId: "runtime-dispatching-ide-receipt",
        prompt: "IDE 必须持久化 handshake",
        workspaceRoot: "C:/workspace/dispatching-ide-receipt",
      };
      const seeded = yield* seedDispatchingStart({
        store,
        runStartStore,
        ...input,
        status: "running",
        runtimeTaskId: "runtime-task-dispatching-ide-receipt",
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
        startTask: () => Effect.die("缺少 handshake 的 IDE Run 不得再次启动"),
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

      assert.equal(result._tag, "Failure");
      assert.equal(intent.state, "indeterminate");
      assert.equal(intent.outcomeCode, "run_start_capability_handshake_receipt_missing");
    }),
  );

  it.effect("Multica 带 grants 时要求 capability handshake receipt", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-dispatching-multica-receipt",
        previousRunId: "run-dispatching-multica-receipt-old",
        runId: "run-dispatching-multica-receipt-new",
        agentId: "agent-dispatching-multica-receipt",
        runtimeId: "runtime-dispatching-multica-receipt",
        prompt: "Multica grant 需要 handshake",
        workspaceRoot: "C:/workspace/dispatching-multica-receipt",
      };
      const seeded = yield* seedDispatchingStart({
        store,
        runStartStore,
        ...input,
        status: "running",
        runtimeTaskId: "runtime-task-dispatching-multica-receipt",
        capabilityGrantIds: ["grant-dispatching-multica-receipt"],
      });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: {
          mode: "idempotent-replay",
          capabilityGrantReplay: { mode: "verified" },
          requiredReceipt: "runtime-task-and-handshake-when-granted",
        },
        startTask: () => Effect.die("已投影但 receipt 不完整时不得重放 Multica"),
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

      assert.equal(result._tag, "Failure");
      assert.equal(intent.state, "indeterminate");
      assert.equal(intent.outcomeCode, "run_start_capability_handshake_receipt_missing");
    }),
  );
});
