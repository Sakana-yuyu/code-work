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

layer("Composition Retry Run Start Persisted Identity", (it) => {
  it.effect("跨重启恢复 accepted receipt 时拒绝同值 Squad assignee", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-accepted-squad-identity",
        previousRunId: "run-accepted-squad-identity-old",
        runId: "run-accepted-squad-identity-new",
        agentId: "shared-accepted-assignee-id",
        runtimeId: "runtime-accepted-squad-identity",
        prompt: "accepted receipt 不得认领 Squad Task",
        workspaceRoot: "C:/workspace/accepted-squad-identity",
      };
      const seeded = yield* seedDispatchingStart({ store, runStartStore, ...input });
      const claimId = seeded.dispatching.claimId;
      if (claimId === null) return yield* Effect.die("dispatching seed 缺少 claimId");
      yield* runStartStore.markAccepted({
        runId: input.runId,
        expectedRevision: seeded.dispatching.revision,
        claimId,
        runtimeTaskId: "runtime-task-accepted-squad-identity",
        acceptedAtUnixMs: 12,
      });
      const task = Option.getOrThrow(yield* store.getTask(input.taskId));
      yield* store.upsertTask({ ...task, assigneeKind: "squad" });
      const orchestrator = makeCompositionOrchestrator(
        store,
        makeCompositionAgentDriverRegistry(),
        undefined,
        makeRunStartRecoveryInputStore(input.taskId, input.prompt, input.workspaceRoot),
        runStartStore,
      );

      const result = yield* Effect.result(orchestrator.recoverRunStart(seeded.request));
      const intent = Option.getOrThrow(yield* runStartStore.getStart(input.runId));
      const recoveredTask = Option.getOrThrow(yield* store.getTask(input.taskId));
      const recoveredRun = Option.getOrThrow(yield* store.getRun(input.runId));

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "CompositionTaskRetryInvalidError");
        if (result.failure._tag === "CompositionTaskRetryInvalidError") {
          assert.equal(result.failure.reason, "run_start_projection_identity_conflict");
        }
      }
      assert.equal(intent.state, "accepted");
      assert.equal(recoveredTask.assigneeKind, "squad");
      assert.equal(recoveredTask.status, "queued");
      assert.equal(recoveredRun.status, "queued");
      assert.equal(recoveredRun.runtimeTaskId, undefined);
    }),
  );

  it.effect("跨重启恢复 accepted receipt 时拒绝 payload 摘要漂移", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-accepted-payload-drift",
        previousRunId: "run-accepted-payload-drift-old",
        runId: "run-accepted-payload-drift-new",
        agentId: "agent-accepted-payload-drift",
        runtimeId: "runtime-accepted-payload-drift",
        prompt: "accepted 原始 payload",
        workspaceRoot: "C:/workspace/accepted-payload-drift",
      };
      const seeded = yield* seedDispatchingStart({ store, runStartStore, ...input });
      const claimId = seeded.dispatching.claimId;
      if (claimId === null) return yield* Effect.die("dispatching seed 缺少 claimId");
      yield* runStartStore.markAccepted({
        runId: input.runId,
        expectedRevision: seeded.dispatching.revision,
        claimId,
        runtimeTaskId: "runtime-task-accepted-payload-drift",
        acceptedAtUnixMs: 12,
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        makeCompositionAgentDriverRegistry(),
        undefined,
        makeRunStartRecoveryInputStore(
          input.taskId,
          "accepted 已漂移 payload",
          input.workspaceRoot,
        ),
        runStartStore,
      );

      const result = yield* Effect.result(orchestrator.recoverRunStart(seeded.request));
      const intent = Option.getOrThrow(yield* runStartStore.getStart(input.runId));
      const recoveredTask = Option.getOrThrow(yield* store.getTask(input.taskId));
      const recoveredRun = Option.getOrThrow(yield* store.getRun(input.runId));

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "CompositionTaskRetryInvalidError");
        if (result.failure._tag === "CompositionTaskRetryInvalidError") {
          assert.equal(result.failure.reason, "run_start_identity_conflict");
        }
      }
      assert.equal(intent.state, "accepted");
      assert.equal(recoveredTask.status, "queued");
      assert.equal(recoveredRun.status, "queued");
      assert.equal(recoveredRun.runtimeTaskId, undefined);
    }),
  );

  it.effect("跨重启读取 settled receipt 时拒绝 capability 摘要漂移", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const runStartStore = yield* CompositionRunStartStore;
      const input = {
        taskId: "task-settled-capability-drift",
        previousRunId: "run-settled-capability-drift-old",
        runId: "run-settled-capability-drift-new",
        agentId: "agent-settled-capability-drift",
        runtimeId: "runtime-settled-capability-drift",
        prompt: "settled capability 身份",
        workspaceRoot: "C:/workspace/settled-capability-drift",
      };
      const seeded = yield* seedDispatchingStart({ store, runStartStore, ...input });
      const claimId = seeded.dispatching.claimId;
      if (claimId === null) return yield* Effect.die("dispatching seed 缺少 claimId");
      const accepted = yield* runStartStore.markAccepted({
        runId: input.runId,
        expectedRevision: seeded.dispatching.revision,
        claimId,
        runtimeTaskId: "runtime-task-settled-capability-drift",
        acceptedAtUnixMs: 12,
      });
      const task = Option.getOrThrow(yield* store.getTask(input.taskId));
      const run = Option.getOrThrow(yield* store.getRun(input.runId));
      yield* store.upsertTask({ ...task, status: "running", updatedAtUnixMs: 12 });
      yield* store.upsertRun({
        ...run,
        status: "running",
        runtimeTaskId: "runtime-task-settled-capability-drift",
        startedAtUnixMs: 12,
      });
      yield* runStartStore.settleStart({
        runId: input.runId,
        expectedRevision: accepted.revision,
        claimId,
        settledAtUnixMs: 13,
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        makeCompositionAgentDriverRegistry(),
        undefined,
        makeRunStartRecoveryInputStore(input.taskId, input.prompt, input.workspaceRoot),
        runStartStore,
      );

      const result = yield* Effect.result(
        orchestrator.recoverRunStart({
          ...seeded.request,
          capabilityIds: ["t3.workspace.write_file"],
        }),
      );
      const intent = Option.getOrThrow(yield* runStartStore.getStart(input.runId));

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "CompositionTaskRetryInvalidError");
        if (result.failure._tag === "CompositionTaskRetryInvalidError") {
          assert.equal(result.failure.reason, "run_start_identity_conflict");
        }
      }
      assert.equal(intent.state, "settled");
      assert.equal(Option.getOrThrow(yield* store.getTask(input.taskId)).status, "running");
      assert.equal(Option.getOrThrow(yield* store.getRun(input.runId)).status, "running");
    }),
  );
});
