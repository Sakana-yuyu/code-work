import {
  makeCompositionAutomationRunIdempotencyKey,
  type CompositionAutomation,
} from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CompositionAutomationStoreLive } from "../persistence/Layers/CompositionAutomationStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CompositionAutomationStore } from "../persistence/Services/CompositionAutomationStore.ts";
import {
  CompositionAutomationRunExecutorError,
  makeCompositionAutomationRunId,
  makeCompositionAutomationScheduler,
  type CompositionAutomationRunExecutorShape,
} from "./CompositionAutomationScheduler.ts";

const layer = it.layer(
  CompositionAutomationStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const makeAutomation = (
  automationId: string,
  overrides: Partial<CompositionAutomation> = {},
): CompositionAutomation => ({
  automationId,
  projectId: "project-scheduler",
  name: `Scheduler ${automationId}`,
  prompt: "执行自动化目标",
  cadence: { type: "every", intervalMs: 60_000 },
  target: {
    type: "agent",
    agentId: "agent-scheduler",
    capabilityIds: ["t3.workspace.read_file"],
    executionContext: {
      mode: "isolated",
      workspaceRoot: "E:/workspace/scheduler",
      archiveOnFinish: true,
    },
  },
  status: "active",
  revision: 1,
  maxRuns: 10,
  runCount: 0,
  createdAtUnixMs: 100,
  updatedAtUnixMs: 100,
  nextRunAtUnixMs: 1_000,
  lastRunAtUnixMs: null,
  pausedAtUnixMs: null,
  expiresAtUnixMs: 500_000,
  ...overrides,
});

layer("CompositionAutomationScheduler", (it) => {
  it.effect("到期 tick 跳过离线积压、绑定稳定 Composition ID 并启动一次", () =>
    Effect.gen(function* () {
      const store = yield* CompositionAutomationStore;
      const automation = makeAutomation("automation-scheduler-tick");
      const starts: Parameters<CompositionAutomationRunExecutorShape["ensureStarted"]>[0][] = [];
      const executor: CompositionAutomationRunExecutorShape = {
        ensureStarted: (input) => Effect.sync(() => void starts.push(input)),
      };
      const scheduler = makeCompositionAutomationScheduler({
        store,
        executor,
        now: () => 5_000,
        batchSize: 10,
      });
      yield* store.createAutomation(automation);

      const result = yield* scheduler.tick();
      const stored = Option.getOrThrow(yield* store.getAutomation(automation.automationId));
      const runId = makeCompositionAutomationRunId({
        automationId: automation.automationId,
        scheduledForUnixMs: 1_000,
      });
      const run = Option.getOrThrow(yield* store.getRun(runId));

      assert.deepEqual(
        result.outcomes.map((outcome) => outcome.status),
        ["started"],
      );
      assert.equal(stored.runCount, 1);
      assert.equal(stored.lastRunAtUnixMs, 1_000);
      assert.equal(stored.nextRunAtUnixMs, 65_000);
      assert.equal(run.status, "running");
      assert.equal(run.compositionTaskId, `${runId}:task`);
      assert.equal(run.compositionRunId, `${runId}:run`);
      assert.equal(starts.length, 1);
      assert.equal(starts[0]?.automation.revision, 1);
      assert.equal(
        starts[0]?.run.idempotencyKey,
        makeCompositionAutomationRunIdempotencyKey({
          automationId: automation.automationId,
          scheduledForUnixMs: 1_000,
        }),
      );
    }),
  );

  it.effect("下一次 tick 恢复 retry_pending Run，且不创建重复计划运行", () =>
    Effect.gen(function* () {
      const store = yield* CompositionAutomationStore;
      const automation = makeAutomation("automation-scheduler-retry-pending");
      let starts = 0;
      let nowUnixMs = 5_000;
      const scheduler = makeCompositionAutomationScheduler({
        store,
        executor: {
          ensureStarted: (input) => {
            if (input.automation.automationId !== automation.automationId) return Effect.void;
            starts += 1;
            return starts === 1
              ? Effect.fail(
                  new CompositionAutomationRunExecutorError({
                    code: "runtime_temporarily_unavailable",
                    detail: "Runtime 正在重新连接",
                    retryable: true,
                  }),
                )
              : Effect.void;
          },
        },
        now: () => nowUnixMs,
        batchSize: 10,
      });
      yield* store.createAutomation(automation);

      const first = yield* scheduler.tick();
      nowUnixMs = 35_000;
      const second = yield* scheduler.tick();
      const runs = (yield* store.listRuns({ automationId: automation.automationId })).runs;
      const secondAutomationOutcomes = second.outcomes.filter(
        (outcome) => outcome.automationId === automation.automationId,
      );

      assert.deepEqual(
        first.outcomes.map((outcome) => outcome.status),
        ["retry_pending"],
      );
      assert.deepEqual(
        secondAutomationOutcomes.map((outcome) => outcome.status),
        ["recovered"],
      );
      assert.equal(starts, 2);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.status, "running");
      assert.equal(
        runs[0]?.automationRunId,
        makeCompositionAutomationRunId({
          automationId: automation.automationId,
          scheduledForUnixMs: 1_000,
        }),
      );
    }),
  );

  it.effect("两个时钟略有偏差的 Scheduler 并发 tick 只让一个执行者启动 Run", () =>
    Effect.gen(function* () {
      const store = yield* CompositionAutomationStore;
      const automation = makeAutomation("automation-scheduler-race");
      let starts = 0;
      const executor: CompositionAutomationRunExecutorShape = {
        ensureStarted: () => Effect.sync(() => void (starts += 1)),
      };
      const schedulerA = makeCompositionAutomationScheduler({
        store,
        executor,
        now: () => 5_000,
        batchSize: 10,
      });
      const schedulerB = makeCompositionAutomationScheduler({
        store,
        executor,
        now: () => 5_001,
        batchSize: 10,
      });
      yield* store.createAutomation(automation);

      yield* Effect.all([schedulerA.tick(), schedulerB.tick()], { concurrency: "unbounded" });

      assert.equal(starts, 1);
      assert.equal(
        (yield* store.listRuns({ automationId: automation.automationId })).runs.length,
        1,
      );
    }),
  );

  it.effect("重启恢复 queued Run，并重新确保 running Run 已启动", () =>
    Effect.gen(function* () {
      const store = yield* CompositionAutomationStore;
      const automation = makeAutomation("automation-scheduler-recovery");
      const runId = makeCompositionAutomationRunId({
        automationId: automation.automationId,
        scheduledForUnixMs: 1_000,
      });
      const queued = {
        automationRunId: runId,
        automationId: automation.automationId,
        automationRevision: 1,
        scheduledForUnixMs: 1_000,
        idempotencyKey: makeCompositionAutomationRunIdempotencyKey({
          automationId: automation.automationId,
          scheduledForUnixMs: 1_000,
        }),
        trigger: "scheduled" as const,
        status: "queued" as const,
        attempt: 1,
        requestedAtUnixMs: 1_000,
        startedAtUnixMs: null,
        finishedAtUnixMs: null,
        compositionTaskId: null,
        compositionRunId: null,
        outputSummary: null,
        errorCode: null,
        errorDetail: null,
      };
      const next: CompositionAutomation = {
        ...automation,
        runCount: 1,
        updatedAtUnixMs: 5_000,
        nextRunAtUnixMs: 65_000,
        lastRunAtUnixMs: 1_000,
      };
      const starts: string[] = [];
      const scheduler = makeCompositionAutomationScheduler({
        store,
        executor: {
          ensureStarted: (input) => Effect.sync(() => void starts.push(input.run.automationRunId)),
        },
        now: () => 5_000,
        batchSize: 10,
      });
      yield* store.createAutomation(automation);
      yield* store.claimScheduledRun({ run: queued, nextAutomation: next });

      const first = yield* scheduler.recover();
      const second = yield* scheduler.recover();
      const firstOutcome = first.outcomes.find((outcome) => outcome.automationRunId === runId);
      const secondOutcome = second.outcomes.find((outcome) => outcome.automationRunId === runId);

      assert.equal(firstOutcome?.status, "started");
      assert.equal(secondOutcome?.status, "recovered");
      assert.equal(starts.filter((startedRunId) => startedRunId === runId).length, 2);
      assert.equal(Option.getOrThrow(yield* store.getRun(runId)).status, "running");
    }),
  );

  it.effect("永久 cadence 错误写入失败 Run 并完成 Automation，避免热循环", () =>
    Effect.gen(function* () {
      const store = yield* CompositionAutomationStore;
      const automation = makeAutomation("automation-scheduler-invalid-cron", {
        cadence: { type: "cron", expression: "not a cron", timezone: "UTC" },
        maxRuns: null,
      });
      let starts = 0;
      const scheduler = makeCompositionAutomationScheduler({
        store,
        executor: {
          ensureStarted: () => Effect.sync(() => void (starts += 1)),
        },
        now: () => 5_000,
        batchSize: 10,
      });
      yield* store.createAutomation(automation);

      const result = yield* scheduler.tick();
      const stored = Option.getOrThrow(yield* store.getAutomation(automation.automationId));
      const runs = (yield* store.listRuns({ automationId: automation.automationId })).runs;

      assert.equal(result.outcomes[0]?.status, "failed");
      assert.equal(stored.status, "completed");
      assert.equal(stored.nextRunAtUnixMs, null);
      assert.equal(runs[0]?.status, "failed");
      assert.equal(runs[0]?.errorCode, "automation_cron_invalid");
      assert.equal(starts, 0);
    }),
  );
});
