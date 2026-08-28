import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  byokDelegationEventPrefix,
  makeByokDelegationProjectionScope,
  projectByokDelegationTransition,
} from "./CompositionByokDelegationProjection.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

const layer = it.layer(CompositionTaskStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const SENSITIVE_TASK_TEXT = "请把 SECRET-DELEGATION-PROMPT 交给下游执行";

const makeScope = (uniqueKey: string) =>
  makeByokDelegationProjectionScope({
    instanceId: "byok-inst",
    delegationId: "delegation-7",
    uniqueKey,
    taskText: SENSITIVE_TASK_TEXT,
  });

layer("projectByokDelegationTransition", (it) => {
  it.effect("排队→运行→完成完整投影为幂等事件行与 Task/Run 状态，重放不重复落行", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const scope = makeScope("proj-happy");
      const transitions = [
        { status: "queued" as const },
        { status: "running" as const },
        { status: "succeeded" as const, resultChars: 42 },
      ];
      for (const [index, transition] of transitions.entries()) {
        const inserted = yield* projectByokDelegationTransition({
          store,
          scope,
          transition,
          nowUnixMs: 1_000 + index,
        });
        assert.isTrue(inserted);
      }

      const events = yield* store.listEvents(scope.taskId, scope.runId);
      const prefix = byokDelegationEventPrefix(scope.taskId, scope.runId);
      assert.deepEqual(
        events.map((event) => event.sourceEventId),
        [`${prefix}:queued`, `${prefix}:running`, `${prefix}:terminal:succeeded`],
      );
      assert.deepEqual(
        events.map((event) => event.status),
        ["queued", "running", "completed"],
      );
      assert.isTrue(events[2]?.summary.includes("输出 42 字符"));

      const task = (yield* store.getTask(scope.taskId)).pipe(Option.getOrThrow);
      assert.equal(task.status, "completed");
      assert.equal(task.projectId, "byok-delegation");
      assert.equal(task.assigneeId, "provider:byok-inst");
      assert.equal(task.createdAtUnixMs, 1_000);
      assert.equal(task.finishedAtUnixMs, 1_002);
      const run = (yield* store.getRun(scope.runId)).pipe(Option.getOrThrow);
      assert.equal(run.status, "completed");
      assert.equal(run.runtimeTaskId, "delegation-7");
      assert.equal(run.startedAtUnixMs, 1_001);
      assert.equal(run.finishedAtUnixMs, 1_002);

      // 幂等重放：同一批迁移再投影一遍，不新增行、不改状态。
      for (const transition of transitions) {
        const inserted = yield* projectByokDelegationTransition({
          store,
          scope,
          transition,
          nowUnixMs: 9_999,
        });
        assert.isFalse(inserted);
      }
      const replayedEvents = yield* store.listEvents(scope.taskId, scope.runId);
      assert.equal(replayedEvents.length, 3);
      const replayedTask = (yield* store.getTask(scope.taskId)).pipe(Option.getOrThrow);
      assert.equal(replayedTask.updatedAtUnixMs, 1_002);
    }),
  );

  it.effect("失败与超时分别映射 failureCode 与 timed_out", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const failedScope = makeScope("proj-failed");
      yield* projectByokDelegationTransition({
        store,
        scope: failedScope,
        transition: { status: "failed", errorCode: "DELEGATION_EXIT_3" },
        nowUnixMs: 2_000,
      });
      const failedRun = (yield* store.getRun(failedScope.runId)).pipe(Option.getOrThrow);
      assert.equal(failedRun.status, "failed");
      assert.equal(failedRun.failureCode, "DELEGATION_EXIT_3");

      const timeoutScope = makeScope("proj-timeout");
      yield* projectByokDelegationTransition({
        store,
        scope: timeoutScope,
        transition: { status: "execution_timed_out" },
        nowUnixMs: 2_001,
      });
      const timeoutRun = (yield* store.getRun(timeoutScope.runId)).pipe(Option.getOrThrow);
      assert.equal(timeoutRun.status, "timed_out");
      assert.equal(timeoutRun.failureCode, "delegation_execution_timed_out");
      const timeoutTask = (yield* store.getTask(timeoutScope.taskId)).pipe(Option.getOrThrow);
      assert.equal(timeoutTask.status, "timed_out");

      const cancelledScope = makeScope("proj-cancelled");
      yield* projectByokDelegationTransition({
        store,
        scope: cancelledScope,
        transition: { status: "cancelled" },
        nowUnixMs: 2_002,
      });
      const cancelledRun = (yield* store.getRun(cancelledScope.runId)).pipe(Option.getOrThrow);
      assert.equal(cancelledRun.status, "cancelled");
      assert.isUndefined(cancelledRun.failureCode);
    }),
  );

  it.effect("迟到的低阶状态只补事件行，不回退已终态的 Task/Run", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const scope = makeScope("proj-late");
      yield* projectByokDelegationTransition({
        store,
        scope,
        transition: { status: "succeeded", resultChars: 3 },
        nowUnixMs: 3_000,
      });
      const insertedLate = yield* projectByokDelegationTransition({
        store,
        scope,
        transition: { status: "queued" },
        nowUnixMs: 3_001,
      });
      // 事件行首次出现仍会补齐，但 Task/Run 状态不回退。
      assert.isTrue(insertedLate);
      const task = (yield* store.getTask(scope.taskId)).pipe(Option.getOrThrow);
      assert.equal(task.status, "completed");
      const run = (yield* store.getRun(scope.runId)).pipe(Option.getOrThrow);
      assert.equal(run.status, "completed");
      const events = yield* store.listEvents(scope.taskId, scope.runId);
      assert.equal(events.length, 2);
    }),
  );

  it.effect("台账只落 promptDigest 与计数摘要，委派原文不进台账", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const scope = makeScope("proj-sensitive");
      for (const transition of [
        { status: "queued" as const },
        { status: "running" as const },
        { status: "succeeded" as const, resultChars: 12 },
      ]) {
        yield* projectByokDelegationTransition({ store, scope, transition, nowUnixMs: 4_000 });
      }
      const events = yield* store.listEvents(scope.taskId, scope.runId);
      const task = (yield* store.getTask(scope.taskId)).pipe(Option.getOrThrow);
      const run = (yield* store.getRun(scope.runId)).pipe(Option.getOrThrow);
      // 敏感内容约定：委派原文（prompt/输出）不得进入任务台账。
      // @effect-diagnostics-next-line preferSchemaOverJson:off - 断言台账整体序列化不含敏感原文。
      const serialized = JSON.stringify({ events, task, run });
      assert.isFalse(serialized.includes("SECRET-DELEGATION-PROMPT"));
      assert.isTrue(task.promptDigest.startsWith("sha256:"));
    }),
  );
});
