import {
  makeCompositionAutomationRunIdempotencyKey,
  type CompositionAutomation,
  type CompositionAutomationRun,
} from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  CompositionAutomationStore,
  type CompositionAutomationStoreError,
} from "../Services/CompositionAutomationStore.ts";
import { CompositionAutomationStoreLive } from "./CompositionAutomationStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  CompositionAutomationStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const makeAutomation = (
  automationId: string,
  overrides: Partial<CompositionAutomation> = {},
): CompositionAutomation => ({
  automationId,
  projectId: "project-automation",
  name: `自动化 ${automationId}`,
  prompt: "检查工作区并汇总结果",
  cadence: { type: "every", intervalMs: 60_000 },
  target: {
    type: "agent",
    agentId: "agent-automation",
    capabilityIds: ["t3.workspace.read_file"],
    executionContext: {
      mode: "isolated",
      workspaceRoot: "E:/workspace/automation",
      archiveOnFinish: true,
    },
  },
  status: "active",
  revision: 1,
  maxRuns: 10,
  runCount: 0,
  createdAtUnixMs: 1_000,
  updatedAtUnixMs: 1_000,
  nextRunAtUnixMs: 2_000,
  lastRunAtUnixMs: null,
  pausedAtUnixMs: null,
  expiresAtUnixMs: 20_000,
  ...overrides,
});

const makeQueuedRun = (
  automationId: string,
  automationRunId: string,
  scheduledForUnixMs: number,
  requestedAtUnixMs = scheduledForUnixMs,
): CompositionAutomationRun => ({
  automationRunId,
  automationId,
  automationRevision: 1,
  scheduledForUnixMs,
  idempotencyKey: makeCompositionAutomationRunIdempotencyKey({
    automationId,
    scheduledForUnixMs,
  }),
  trigger: "scheduled",
  status: "queued",
  attempt: 1,
  requestedAtUnixMs,
  startedAtUnixMs: null,
  finishedAtUnixMs: null,
  compositionTaskId: null,
  compositionRunId: null,
  outputSummary: null,
  errorCode: null,
  errorDetail: null,
});

const failureCode = (
  result:
    | { readonly _tag: "Success" }
    | { readonly _tag: "Failure"; readonly failure: CompositionAutomationStoreError },
): string | undefined =>
  result._tag === "Failure" && result.failure._tag === "CompositionAutomationStoreDomainError"
    ? result.failure.code
    : undefined;

layer("CompositionAutomationStore", (it) => {
  it.effect("创建、读取并按项目和状态稳定列出 Automation", () =>
    Effect.gen(function* () {
      const store = yield* CompositionAutomationStore;
      const older = makeAutomation("automation-older");
      const newer = makeAutomation("automation-newer", {
        projectId: "project-other",
        status: "paused",
        updatedAtUnixMs: 1_100,
        nextRunAtUnixMs: null,
        pausedAtUnixMs: 1_100,
      });

      assert.deepEqual(yield* store.createAutomation(older), older);
      assert.deepEqual(yield* store.createAutomation(newer), newer);
      assert.deepEqual(Option.getOrThrow(yield* store.getAutomation(older.automationId)), older);

      const all = yield* store.listAutomations({});
      assert.deepEqual(
        all.map((automation) => automation.automationId),
        [newer.automationId, older.automationId],
      );
      assert.deepEqual(yield* store.listAutomations({ projectId: older.projectId }), [older]);
      assert.deepEqual(yield* store.listAutomations({ statuses: ["paused"] }), [newer]);
    }),
  );

  it.effect("只接受连续 revision，并允许同一快照幂等重放", () =>
    Effect.gen(function* () {
      const store = yield* CompositionAutomationStore;
      const revision1 = makeAutomation("automation-revisions");
      const revision2 = makeAutomation(revision1.automationId, {
        name: "自动化 revision 2",
        revision: 2,
        updatedAtUnixMs: 1_100,
        nextRunAtUnixMs: 2_100,
      });

      yield* store.createAutomation(revision1);
      assert.deepEqual(yield* store.createAutomation(revision1), revision1);
      assert.deepEqual(
        yield* store.saveAutomationRevision({ automation: revision2, expectedRevision: 1 }),
        revision2,
      );
      assert.deepEqual(
        yield* store.saveAutomationRevision({ automation: revision2, expectedRevision: 1 }),
        revision2,
      );

      const drift = yield* Effect.result(
        store.saveAutomationRevision({
          automation: { ...revision2, name: "同 revision 内容漂移" },
          expectedRevision: 1,
        }),
      );
      const skipped = yield* Effect.result(
        store.saveAutomationRevision({
          automation: { ...revision2, revision: 4 },
          expectedRevision: 2,
        }),
      );

      assert.equal(failureCode(drift), "automation_revision_conflict");
      assert.equal(failureCode(skipped), "automation_revision_invalid");
      assert.deepEqual(
        Option.getOrThrow(yield* store.getAutomationRevision(revision1.automationId, 1)),
        revision1,
      );
      assert.deepEqual(
        Option.getOrThrow(yield* store.getAutomationRevision(revision1.automationId, 2)),
        revision2,
      );
    }),
  );

  it.effect("以 revision 保护暂停、恢复和删除，同时保留不可变历史", () =>
    Effect.gen(function* () {
      const store = yield* CompositionAutomationStore;
      const active = makeAutomation("automation-lifecycle");
      const paused = makeAutomation(active.automationId, {
        status: "paused",
        revision: 2,
        updatedAtUnixMs: 1_100,
        nextRunAtUnixMs: null,
        pausedAtUnixMs: 1_100,
      });
      const resumed = makeAutomation(active.automationId, {
        revision: 3,
        updatedAtUnixMs: 1_200,
        nextRunAtUnixMs: 2_200,
      });

      yield* store.createAutomation(active);
      yield* store.saveAutomationRevision({ automation: paused, expectedRevision: 1 });
      yield* store.saveAutomationRevision({ automation: resumed, expectedRevision: 2 });

      const staleDelete = yield* Effect.result(
        store.deleteAutomation({
          automationId: active.automationId,
          expectedRevision: 2,
          deletedAtUnixMs: 1_300,
        }),
      );
      assert.equal(failureCode(staleDelete), "automation_revision_conflict");

      assert.deepEqual(
        yield* store.deleteAutomation({
          automationId: active.automationId,
          expectedRevision: 3,
          deletedAtUnixMs: 1_300,
        }),
        { automationId: active.automationId, deletedAtUnixMs: 1_300 },
      );
      assert.ok(Option.isNone(yield* store.getAutomation(active.automationId)));
      assert.deepEqual(
        Option.getOrThrow(yield* store.getAutomationRevision(active.automationId, 2)),
        paused,
      );
      assert.deepEqual(
        Option.getOrThrow(yield* store.getAutomationRevision(active.automationId, 3)),
        resumed,
      );
    }),
  );

  it.effect("并发 claim 同一计划点只产生一个 Run，重放返回既有记录", () =>
    Effect.gen(function* () {
      const store = yield* CompositionAutomationStore;
      const automation = makeAutomation("automation-claim");
      yield* store.createAutomation(automation);

      const first = makeQueuedRun(automation.automationId, "automation-run-a", 3_000, 3_010);
      const competing = { ...first, automationRunId: "automation-run-b" };
      const claims = yield* Effect.all([store.claimRun(first), store.claimRun(competing)], {
        concurrency: "unbounded",
      });

      assert.equal(claims.filter((claim) => claim.claimed).length, 1);
      assert.equal(claims[0]?.run.automationRunId, claims[1]?.run.automationRunId);

      const winner = claims.find((claim) => claim.claimed)!.run;
      const replay = yield* store.claimRun(winner);
      assert.equal(replay.claimed, false);
      assert.deepEqual(replay.run, winner);

      const conflict = yield* Effect.result(store.claimRun({ ...winner, automationRevision: 2 }));
      assert.equal(failureCode(conflict), "automation_run_conflict");
    }),
  );

  it.effect("以期望状态原子推进 Run，并允许目标快照幂等重放", () =>
    Effect.gen(function* () {
      const store = yield* CompositionAutomationStore;
      const automation = makeAutomation("automation-transition");
      const queued = makeQueuedRun(automation.automationId, "automation-run-transition", 4_000);
      yield* store.createAutomation(automation);
      yield* store.claimRun(queued);

      const running: CompositionAutomationRun = {
        ...queued,
        status: "running",
        startedAtUnixMs: 4_010,
      };
      assert.deepEqual(
        yield* store.saveRunTransition({ run: running, expectedStatus: "queued" }),
        running,
      );
      assert.deepEqual(
        yield* store.saveRunTransition({ run: running, expectedStatus: "queued" }),
        running,
      );

      const stale = yield* Effect.result(
        store.saveRunTransition({
          run: { ...running, status: "cancelled", finishedAtUnixMs: 4_020 },
          expectedStatus: "queued",
        }),
      );
      assert.equal(failureCode(stale), "automation_run_status_conflict");
      assert.deepEqual(Option.getOrThrow(yield* store.getRun(running.automationRunId)), running);
    }),
  );

  it.effect("运行历史使用稳定复合 cursor 分页并拒绝损坏 cursor", () =>
    Effect.gen(function* () {
      const store = yield* CompositionAutomationStore;
      const automation = makeAutomation("automation-history");
      yield* store.createAutomation(automation);

      const runs = [
        makeQueuedRun(automation.automationId, "run-history-c", 5_000, 7_000),
        makeQueuedRun(automation.automationId, "run-history-b", 5_100, 7_000),
        makeQueuedRun(automation.automationId, "run-history-a", 5_200, 6_000),
      ];
      yield* Effect.forEach(runs, (run) => store.claimRun(run));

      const firstPage = yield* store.listRuns({ automationId: automation.automationId, limit: 2 });
      assert.deepEqual(
        firstPage.runs.map((run) => run.automationRunId),
        ["run-history-c", "run-history-b"],
      );
      assert.notEqual(firstPage.nextCursor, null);

      const secondPage = yield* store.listRuns({
        automationId: automation.automationId,
        cursor: firstPage.nextCursor!,
        limit: 2,
      });
      assert.deepEqual(
        secondPage.runs.map((run) => run.automationRunId),
        ["run-history-a"],
      );
      assert.equal(secondPage.nextCursor, null);

      const malformed = yield* Effect.result(
        store.listRuns({ automationId: automation.automationId, cursor: "not-a-cursor" }),
      );
      assert.equal(failureCode(malformed), "automation_history_cursor_invalid");
    }),
  );

  it.effect("按计划时间稳定列出到期 Automation，并限制批次大小", () =>
    Effect.gen(function* () {
      const store = yield* CompositionAutomationStore;
      const dueB = makeAutomation("automation-due-b", { nextRunAtUnixMs: 900 });
      const dueA = makeAutomation("automation-due-a", { nextRunAtUnixMs: 900 });
      const future = makeAutomation("automation-future", { nextRunAtUnixMs: 2_000 });
      const paused = makeAutomation("automation-paused", {
        status: "paused",
        updatedAtUnixMs: 1_100,
        nextRunAtUnixMs: null,
        pausedAtUnixMs: 1_100,
      });
      yield* Effect.forEach([dueB, dueA, future, paused], (automation) =>
        store.createAutomation(automation),
      );

      const due = yield* store.listDueAutomations({ nowUnixMs: 1_000, limit: 10 });
      const first = yield* store.listDueAutomations({ nowUnixMs: 1_000, limit: 1 });

      assert.deepEqual(
        due.map((automation) => automation.automationId),
        [dueA.automationId, dueB.automationId],
      );
      assert.deepEqual(first, [dueA]);
    }),
  );

  it.effect("并发推进同一计划点只增加一次 runCount，并幂等返回获胜 Run", () =>
    Effect.gen(function* () {
      const store = yield* CompositionAutomationStore;
      const current = makeAutomation("automation-scheduled-claim", {
        nextRunAtUnixMs: 2_000,
        expiresAtUnixMs: 120_000,
      });
      const next: CompositionAutomation = {
        ...current,
        runCount: 1,
        updatedAtUnixMs: 2_100,
        nextRunAtUnixMs: 62_000,
        lastRunAtUnixMs: 2_100,
      };
      const firstRun = makeQueuedRun(current.automationId, "scheduled-run-a", 2_000, 2_100);
      const competingRun = { ...firstRun, automationRunId: "scheduled-run-b" };
      yield* store.createAutomation(current);

      const results = yield* Effect.all(
        [
          store.claimScheduledRun({ run: firstRun, nextAutomation: next }),
          store.claimScheduledRun({ run: competingRun, nextAutomation: next }),
        ],
        { concurrency: "unbounded" },
      );

      assert.equal(results.filter((result) => result.claimed).length, 1);
      assert.equal(results.filter((result) => result.scheduleAdvanced).length, 1);
      assert.equal(results[0]?.run.automationRunId, results[1]?.run.automationRunId);
      assert.deepEqual(Option.getOrThrow(yield* store.getAutomation(current.automationId)), next);
      assert.equal((yield* store.listRuns({ automationId: current.automationId })).runs.length, 1);
    }),
  );

  it.effect("崩溃窗口可用既有 queued Run 推进计划，并在 maxRuns 后完成 Automation", () =>
    Effect.gen(function* () {
      const store = yield* CompositionAutomationStore;
      const current = makeAutomation("automation-recovery-claim", {
        maxRuns: 1,
        nextRunAtUnixMs: 3_000,
      });
      const run = makeQueuedRun(current.automationId, "scheduled-run-recovery", 3_000, 3_100);
      const completed: CompositionAutomation = {
        ...current,
        status: "completed",
        runCount: 1,
        updatedAtUnixMs: 3_100,
        nextRunAtUnixMs: null,
        lastRunAtUnixMs: 3_100,
      };
      yield* store.createAutomation(current);
      assert.equal((yield* store.claimRun(run)).claimed, true);

      const recovered = yield* store.claimScheduledRun({ run, nextAutomation: completed });
      assert.equal(recovered.claimed, false);
      assert.equal(recovered.scheduleAdvanced, true);
      assert.deepEqual(recovered.automation, completed);

      const replay = yield* store.claimScheduledRun({ run, nextAutomation: completed });
      assert.equal(replay.claimed, false);
      assert.equal(replay.scheduleAdvanced, false);

      const recoverable = yield* store.listRecoverableRuns({ limit: 10 });
      assert.ok(recoverable.some((candidate) => candidate.automationRunId === run.automationRunId));
      assert.deepEqual(
        recoverable.map((candidate) => candidate.requestedAtUnixMs),
        recoverable.map((candidate) => candidate.requestedAtUnixMs).toSorted((a, b) => a - b),
      );
    }),
  );
});
