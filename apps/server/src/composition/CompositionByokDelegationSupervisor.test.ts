import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { BYOK_DELEGATION_PROJECT_ID } from "@codework/contracts";

import {
  BYOK_DELEGATION_INTERRUPTED_FAILURE_CODE,
  makeByokDelegationProjectionScope,
  projectByokDelegationTransition,
} from "./CompositionByokDelegationProjection.ts";
import {
  recoverInterruptedByokDelegations,
  scanByokDelegationRun,
} from "./CompositionByokDelegationSupervisor.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

const layer = it.layer(CompositionTaskStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const SENSITIVE_TASK_TEXT = "请把 SECRET-INTERRUPT-PROMPT 交给下游执行";

const makeScope = (uniqueKey: string) =>
  makeByokDelegationProjectionScope({
    instanceId: "byok-inst",
    delegationId: `delegation-${uniqueKey}`,
    uniqueKey,
    taskText: SENSITIVE_TASK_TEXT,
  });

describe("scanByokDelegationRun", () => {
  const task = {
    taskId: "byok-delegation-scan",
    projectId: BYOK_DELEGATION_PROJECT_ID,
    assigneeKind: "agent" as const,
    assigneeId: "provider:byok-inst",
    mode: "serial" as const,
    status: "queued" as const,
    promptDigest: "sha256:deadbeef",
    dependsOnTaskIds: [] as string[],
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
  };
  const run = {
    runId: "byok-delegation-run-scan",
    taskId: task.taskId,
    agentId: "provider:byok-inst",
    runtimeId: "byok-delegation:byok-inst",
    runtimeTaskId: "delegation-scan",
    status: "queued" as const,
    attempt: 1,
    capabilityGrantIds: [] as string[],
  };

  it("marks queued/running runs with no live scheduler entry as interrupted", () => {
    const queued = scanByokDelegationRun(task, run, new Set());
    assert.equal(queued.interrupted, true);
    assert.equal(queued.alreadyTerminal, false);
    const running = scanByokDelegationRun(
      { ...task, status: "running" },
      { ...run, status: "running" },
      new Set(),
    );
    assert.equal(running.interrupted, true);
  });

  it("skips runs that still have a live scheduler entry", () => {
    const scan = scanByokDelegationRun(task, run, new Set(["delegation-scan"]));
    assert.equal(scan.interrupted, false);
    assert.equal(scan.alreadyTerminal, false);
  });

  it("does not treat already-terminal runs as interrupted", () => {
    for (const status of ["completed", "failed", "cancelled", "timed_out"] as const) {
      const scan = scanByokDelegationRun({ ...task, status }, { ...run, status }, new Set());
      assert.equal(scan.interrupted, false);
      assert.equal(scan.alreadyTerminal, true);
    }
  });

  it("ignores tasks outside the byok-delegation project", () => {
    const scan = scanByokDelegationRun({ ...task, projectId: "project-other" }, run, new Set());
    assert.equal(scan.interrupted, false);
  });
});

layer("recoverInterruptedByokDelegations", (it) => {
  it.effect("收口 queued/running 合成 Run，已终态不被改写，重复扫描幂等", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const queuedScope = makeScope("queued");
      const runningScope = makeScope("running");
      const doneScope = makeScope("done");

      yield* projectByokDelegationTransition({
        store,
        scope: queuedScope,
        transition: { status: "queued" },
        nowUnixMs: 1_000,
      });
      yield* projectByokDelegationTransition({
        store,
        scope: runningScope,
        transition: { status: "queued" },
        nowUnixMs: 1_001,
      });
      yield* projectByokDelegationTransition({
        store,
        scope: runningScope,
        transition: { status: "running" },
        nowUnixMs: 1_002,
      });
      yield* projectByokDelegationTransition({
        store,
        scope: doneScope,
        transition: { status: "succeeded", resultChars: 4 },
        nowUnixMs: 1_003,
      });

      const first = yield* recoverInterruptedByokDelegations({
        store,
        liveDelegationIds: new Set(),
        nowUnixMs: 2_000,
      });
      assert.isTrue(first.some((row) => row.taskId === queuedScope.taskId && row.settled));
      assert.isTrue(first.some((row) => row.taskId === runningScope.taskId && row.settled));
      assert.isFalse(first.some((row) => row.taskId === doneScope.taskId));

      const queuedRun = (yield* store.getRun(queuedScope.runId)).pipe(Option.getOrThrow);
      assert.equal(queuedRun.status, "failed");
      assert.equal(queuedRun.failureCode, BYOK_DELEGATION_INTERRUPTED_FAILURE_CODE);
      const runningRun = (yield* store.getRun(runningScope.runId)).pipe(Option.getOrThrow);
      assert.equal(runningRun.status, "failed");
      assert.equal(runningRun.failureCode, BYOK_DELEGATION_INTERRUPTED_FAILURE_CODE);

      const doneTask = (yield* store.getTask(doneScope.taskId)).pipe(Option.getOrThrow);
      const doneRun = (yield* store.getRun(doneScope.runId)).pipe(Option.getOrThrow);
      assert.equal(doneTask.status, "completed");
      assert.equal(doneRun.status, "completed");
      assert.equal(doneTask.updatedAtUnixMs, 1_003);
      assert.equal(doneRun.finishedAtUnixMs, 1_003);

      const second = yield* recoverInterruptedByokDelegations({
        store,
        liveDelegationIds: new Set(),
        nowUnixMs: 9_999,
      });
      assert.isFalse(second.some((row) => row.taskId === queuedScope.taskId));
      assert.isFalse(second.some((row) => row.taskId === runningScope.taskId));
      const queuedAgain = (yield* store.getRun(queuedScope.runId)).pipe(Option.getOrThrow);
      assert.equal(queuedAgain.finishedAtUnixMs, 2_000);

      const events = yield* store.listEvents(queuedScope.taskId, queuedScope.runId);
      const queuedTask = (yield* store.getTask(queuedScope.taskId)).pipe(Option.getOrThrow);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - 断言台账整体序列化不含敏感原文。
      const serialized = JSON.stringify({ events, task: queuedTask, run: queuedAgain });
      assert.isFalse(serialized.includes("SECRET-INTERRUPT-PROMPT"));
    }),
  );

  it.effect("调度器内存仍有对应条目时不收口 in-flight Run", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const scope = makeScope("live");
      yield* projectByokDelegationTransition({
        store,
        scope,
        transition: { status: "running" },
        nowUnixMs: 3_000,
      });
      const settled = yield* recoverInterruptedByokDelegations({
        store,
        liveDelegationIds: new Set([scope.delegationId]),
        nowUnixMs: 3_100,
      });
      assert.isFalse(settled.some((row) => row.taskId === scope.taskId));
      const run = (yield* store.getRun(scope.runId)).pipe(Option.getOrThrow);
      assert.equal(run.status, "running");
      assert.isUndefined(run.failureCode);
    }),
  );
});
