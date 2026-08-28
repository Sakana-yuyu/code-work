import { assert, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import {
  cancelProjectedByokDelegationTask,
  type ByokDelegationRuntimeCancelPort,
} from "./CompositionByokDelegationCancel.ts";
import {
  makeByokDelegationProjectionScope,
  projectByokDelegationTransition,
} from "./CompositionByokDelegationProjection.ts";

const layer = effectIt.layer(
  CompositionTaskStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("cancelProjectedByokDelegationTask", (it) => {
  it.effect("取消活跃委派后调度器与台账都收敛为 cancelled，且原文不进投影", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const scope = makeByokDelegationProjectionScope({
        instanceId: "instance-cancel",
        delegationId: "delegation-7",
        uniqueKey: "cancel",
        taskText: "delegation-secret-prompt",
      });
      yield* projectByokDelegationTransition({
        store,
        scope,
        transition: { status: "queued" },
        nowUnixMs: 1_000,
      });
      yield* projectByokDelegationTransition({
        store,
        scope,
        transition: { status: "running" },
        nowUnixMs: 2_000,
      });

      let runtimeCancelInput: Parameters<ByokDelegationRuntimeCancelPort>[0] | undefined;
      const result = yield* cancelProjectedByokDelegationTask({
        store,
        input: {
          taskId: scope.taskId,
          runId: scope.runId,
          reason: "用户从控制中心取消",
        },
        cancelRuntime: (input) => {
          runtimeCancelInput = input;
          return { status: "cancelled" };
        },
        nowUnixMs: 3_000,
      });

      assert.isDefined(result);
      assert.equal(result?.status, "cancelled");
      assert.equal(result?.task.status, "cancelled");
      assert.equal(result?.run.status, "cancelled");
      assert.deepEqual(runtimeCancelInput, {
        taskId: scope.taskId,
        runId: scope.runId,
        instanceId: "instance-cancel",
        delegationId: "delegation-7",
      });
      const events = yield* store.listEvents(scope.taskId, scope.runId);
      assert.isTrue(events.some((event) => event.sourceEventId?.endsWith(":terminal:cancelled")));
      // @effect-diagnostics-next-line preferSchemaOverJson:off - 整体序列化用于验证敏感正文不进入台账/返回值。
      const serialized = JSON.stringify({ events, result });
      assert.isFalse(serialized.includes("delegation-secret-prompt"));
    }),
  );

  it.effect("调度器已先到终态时投影真实终态，不把完成任务覆盖成 cancelled", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const scope = makeByokDelegationProjectionScope({
        instanceId: "instance-terminal",
        delegationId: "delegation-8",
        uniqueKey: "terminal",
        taskText: "terminal-secret-prompt",
      });
      yield* projectByokDelegationTransition({
        store,
        scope,
        transition: { status: "running" },
        nowUnixMs: 1_000,
      });

      const result = yield* cancelProjectedByokDelegationTask({
        store,
        input: { taskId: scope.taskId, runId: scope.runId, reason: "取消" },
        cancelRuntime: () => ({
          status: "already_terminal",
          transition: { status: "succeeded", resultChars: 321 },
        }),
        nowUnixMs: 2_000,
      });

      assert.equal(result?.status, "already_terminal");
      assert.equal(result?.task.status, "completed");
      assert.equal(result?.run.status, "completed");
      const events = yield* store.listEvents(scope.taskId, scope.runId);
      assert.isTrue(events.some((event) => event.sourceEventId?.endsWith(":terminal:succeeded")));
      // @effect-diagnostics-next-line preferSchemaOverJson:off - 整体序列化用于验证敏感正文不进入台账/返回值。
      assert.isFalse(JSON.stringify({ events, result }).includes("terminal-secret-prompt"));
    }),
  );

  it.effect("非 BYOK 委派 Task 返回 undefined，留给通用 Orchestrator 处理", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      yield* store.upsertTask({
        taskId: "task-plain",
        projectId: "project-plain",
        assigneeKind: "agent",
        assigneeId: "agent-plain",
        mode: "serial",
        status: "running",
        promptDigest: "sha256:plain",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1_000,
        updatedAtUnixMs: 1_000,
      });
      yield* store.upsertRun({
        runId: "run-plain",
        taskId: "task-plain",
        agentId: "agent-plain",
        runtimeId: "runtime-plain",
        status: "running",
        attempt: 1,
        capabilityGrantIds: [],
      });
      let cancelCalled = false;
      const result = yield* cancelProjectedByokDelegationTask({
        store,
        input: { taskId: "task-plain", runId: "run-plain", reason: "取消" },
        cancelRuntime: () => {
          cancelCalled = true;
          return { status: "cancelled" };
        },
        nowUnixMs: 2_000,
      });

      assert.isUndefined(result);
      assert.isFalse(cancelCalled);
      assert.equal((yield* store.getTask("task-plain")).pipe(Option.getOrThrow).status, "running");
    }),
  );
});
