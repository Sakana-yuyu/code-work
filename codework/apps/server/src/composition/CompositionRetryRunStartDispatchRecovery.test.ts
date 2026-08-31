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

layer("Composition Retry Run Start Dispatch Recovery", (it) => {
  it.effect("仅对声明幂等策略的 Driver 使用同一 runId 重放 dispatching", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-dispatching-idempotent",
        previousRunId: "run-dispatching-idempotent-old",
        runId: "run-dispatching-idempotent-new",
        agentId: "agent-dispatching-idempotent",
        runtimeId: "runtime-dispatching-idempotent",
        prompt: "继续执行幂等恢复",
        workspaceRoot: "C:/workspace/dispatching-idempotent",
      };
      const seeded = yield* seedDispatchingStart({ store, runStartStore, ...input });
      let startCalls = 0;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: {
          mode: "idempotent-replay",
          capabilityGrantReplay: { mode: "verified" },
          requiredReceipt: "runtime-task-and-handshake-when-granted",
        },
        startTask: ({ run }) =>
          Effect.sync(() => {
            startCalls += 1;
            assert.equal(run.runId, input.runId);
            return { runtimeTaskId: "runtime-task-dispatching-idempotent" };
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

      const recovered = yield* orchestrator.recoverRunStart(seeded.request);

      assert.equal(startCalls, 1);
      assert.equal(recovered.task.status, "running");
      assert.equal(recovered.run.status, "running");
      assert.equal(recovered.run.runId, input.runId);
      assert.equal(Option.getOrThrow(yield* runStartStore.getStart(input.runId)).state, "settled");
    }),
  );

  it.effect("仅声明 runId 幂等的 Driver 不得重放带 grant 的 dispatching", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-dispatching-multica-grant",
        previousRunId: "run-dispatching-multica-grant-old",
        runId: "run-dispatching-multica-grant-new",
        agentId: "agent-dispatching-multica-grant",
        runtimeId: "runtime-dispatching-multica-grant",
        prompt: "禁止重复签发 Multica handshake",
        workspaceRoot: "C:/workspace/dispatching-multica-grant",
        capabilityGrantIds: ["grant-dispatching-multica"],
      };
      const seeded = yield* seedDispatchingStart({ store, runStartStore, ...input });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: {
          mode: "idempotent-replay",
          requiredReceipt: "runtime-task-and-handshake-when-granted",
        },
        startTask: () => Effect.die("带 grant 的 dispatching 恢复不得再次启动 Driver"),
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
      assert.equal(intent.outcomeCode, "driver_capability_grant_replay_not_verified");
    }),
  );

  it.effect("dispatching 缺少 queued Run 投影时转未知且不重建本地副作用", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-dispatching-missing-run",
        previousRunId: "run-dispatching-missing-run-old",
        runId: "run-dispatching-missing-run-new",
        agentId: "agent-dispatching-missing-run",
        runtimeId: "runtime-dispatching-missing-run",
        prompt: "拒绝猜测缺失投影",
        workspaceRoot: "C:/workspace/dispatching-missing-run",
      };
      const seeded = yield* seedDispatchingStart({
        store,
        runStartStore,
        ...input,
        includeRun: false,
      });
      let startCalls = 0;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: {
          mode: "idempotent-replay",
          capabilityGrantReplay: { mode: "verified" },
          requiredReceipt: "runtime-task-and-handshake-when-granted",
        },
        startTask: () => Effect.sync(() => void (startCalls += 1)).pipe(Effect.as({})),
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
      assert.equal(startCalls, 0);
      assert.equal(intent.state, "indeterminate");
      assert.equal(intent.outcomeCode, "run_start_dispatching_projection_missing");
    }),
  );

  it.effect("reconcile-only Driver 在 queued 投影缺少 durable receipt 时 fail-closed", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-dispatching-provider-core-window",
        previousRunId: "run-dispatching-provider-core-window-old",
        runId: "run-dispatching-provider-core-window-new",
        agentId: "agent-dispatching-provider-core-window",
        runtimeId: "runtime-dispatching-provider-core-window",
        prompt: "Provider 返回前崩溃不得猜测远端身份",
        workspaceRoot: "C:/workspace/dispatching-provider-core-window",
      };
      const seeded = yield* seedDispatchingStart({ store, runStartStore, ...input });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        startRecoveryPolicy: {
          mode: "reconcile-only",
          after: "provider-sessions.reconcile",
          requiredReceipt: "runtime-task-and-handshake-when-granted",
        },
        startTask: () => Effect.die("reconcile-only 恢复不得再次启动 Driver"),
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
      assert.equal(intent.outcomeCode, "run_start_reconcile_projection_missing");
    }),
  );

  it.effect("fail-closed Driver 将 dispatching 稳定转为 indeterminate", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-dispatching-fail-closed",
        previousRunId: "run-dispatching-fail-closed-old",
        runId: "run-dispatching-fail-closed-new",
        agentId: "agent-dispatching-fail-closed",
        runtimeId: "runtime-dispatching-fail-closed",
        prompt: "禁止不安全重放",
        workspaceRoot: "C:/workspace/dispatching-fail-closed",
      };
      const seeded = yield* seedDispatchingStart({
        store,
        runStartStore,
        ...input,
        includeRun: false,
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
        startTask: () => Effect.die("fail-closed 恢复不得再次启动 Driver"),
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
      assert.equal(intent.outcomeCode, "byok_start_replay_unsafe");
    }),
  );
});
