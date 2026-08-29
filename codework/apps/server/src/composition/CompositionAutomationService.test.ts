import { assert, it } from "@effect/vitest";
import type {
  CompositionAutomationCreateRequest,
  CompositionAutomationRun,
  CompositionAutomationTarget,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CompositionAutomationStoreLive } from "../persistence/Layers/CompositionAutomationStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  CompositionAutomationStore,
  type CompositionAutomationStoreShape,
} from "../persistence/Services/CompositionAutomationStore.ts";
import { makeCompositionAutomationService } from "./CompositionAutomationService.ts";
import {
  CompositionAutomationRunExecutorError,
  type CompositionAutomationRunExecutorShape,
} from "./CompositionAutomationScheduler.ts";

const layer = it.layer(
  CompositionAutomationStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const agentTarget: CompositionAutomationTarget = {
  type: "agent",
  agentId: "agent-1",
  capabilityIds: ["t3.workspace.read_file"],
  executionContext: {
    mode: "isolated",
    workspaceRoot: "E:/workspace",
    archiveOnFinish: true,
  },
};

const makeCreateRequest = (
  automationId: string,
  overrides: Partial<CompositionAutomationCreateRequest> = {},
): CompositionAutomationCreateRequest => ({
  automationId,
  projectId: "project-1",
  name: `自动化 ${automationId}`,
  prompt: "检查项目状态并输出证据。",
  cadence: { type: "every", intervalMs: 60_000 },
  target: agentTarget,
  maxRuns: null,
  expiresAtUnixMs: null,
  runOnCreate: false,
  ...overrides,
});

const makeNow = (...values: ReadonlyArray<number>): (() => number) => {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
};

const makeService = (
  store: CompositionAutomationStoreShape,
  options: {
    readonly now?: () => number;
    readonly ensureStarted?: CompositionAutomationRunExecutorShape["ensureStarted"];
  } = {},
) =>
  makeCompositionAutomationService({
    store,
    executor: {
      ensureStarted: options.ensureStarted ?? (() => Effect.void),
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  });

layer("CompositionAutomationService", (it) => {
  it.effect("创建 Automation 时由服务端生成 revision、时间和首个计划点", () =>
    Effect.gen(function* () {
      const store = yield* CompositionAutomationStore;
      const service = makeService(store, { now: () => 1_000 });

      const scheduled = yield* service.create(makeCreateRequest("scheduled"));
      const immediate = yield* service.create(
        makeCreateRequest("immediate", { runOnCreate: true }),
      );

      assert.equal(scheduled.revision, 1);
      assert.equal(scheduled.createdAtUnixMs, 1_000);
      assert.equal(scheduled.updatedAtUnixMs, 1_000);
      assert.equal(scheduled.nextRunAtUnixMs, 61_000);
      assert.equal(scheduled.runCount, 0);
      assert.equal(immediate.nextRunAtUnixMs, 1_000);
    }),
  );

  it.effect("无效 cron 或已过期配置不会留下 Automation 记录", () =>
    Effect.gen(function* () {
      const store = yield* CompositionAutomationStore;
      const service = makeService(store, { now: () => 1_000 });

      const invalidCron = yield* Effect.flip(
        service.create(
          makeCreateRequest("invalid-cron", {
            cadence: { type: "cron", expression: "not a cron", timezone: "UTC" },
          }),
        ),
      );
      const invalidImmediateCron = yield* Effect.flip(
        service.create(
          makeCreateRequest("invalid-immediate-cron", {
            cadence: { type: "cron", expression: "still not cron", timezone: "UTC" },
            runOnCreate: true,
          }),
        ),
      );
      const expired = yield* Effect.flip(
        service.create(makeCreateRequest("expired", { expiresAtUnixMs: 1_000 })),
      );
      yield* service.create(makeCreateRequest("paused-invalid-cron"));
      yield* service.pause({ automationId: "paused-invalid-cron", expectedRevision: 1 });
      const invalidPausedCron = yield* Effect.flip(
        service.update({
          automationId: "paused-invalid-cron",
          expectedRevision: 2,
          cadence: { type: "cron", expression: "paused invalid cron", timezone: "UTC" },
        }),
      );
      yield* service.create(makeCreateRequest("paused-after-expiry", { expiresAtUnixMs: 100_000 }));
      yield* service.pause({ automationId: "paused-after-expiry", expectedRevision: 1 });
      const afterExpiry = yield* Effect.flip(
        service.update({
          automationId: "paused-after-expiry",
          expectedRevision: 2,
          cadence: { type: "every", intervalMs: 120_000 },
        }),
      );

      assert.equal(invalidCron.code, "automation_cron_invalid");
      assert.equal(invalidImmediateCron.code, "automation_cron_invalid");
      assert.equal(invalidPausedCron.code, "automation_cron_invalid");
      assert.equal(afterExpiry.code, "automation_schedule_invalid");
      assert.equal(expired.code, "automation_schedule_invalid");
      assert.isTrue(Option.isNone(yield* store.getAutomation("invalid-cron")));
      assert.isTrue(Option.isNone(yield* store.getAutomation("invalid-immediate-cron")));
      assert.isTrue(Option.isNone(yield* store.getAutomation("expired")));
    }),
  );

  it.effect("编辑 active Automation 时递增 revision、重算计划并拒绝陈旧覆盖", () =>
    Effect.gen(function* () {
      const store = yield* CompositionAutomationStore;
      const service = makeService(store, { now: makeNow(1_000, 2_000) });
      yield* service.create(makeCreateRequest("update"));

      const updated = yield* service.update({
        automationId: "update",
        expectedRevision: 1,
        name: "更新后的自动化",
        cadence: { type: "every", intervalMs: 120_000 },
      });
      const conflict = yield* Effect.flip(
        service.update({
          automationId: "update",
          expectedRevision: 1,
          name: "陈旧覆盖",
        }),
      );

      assert.equal(updated.revision, 2);
      assert.equal(updated.name, "更新后的自动化");
      assert.equal(updated.nextRunAtUnixMs, 122_000);
      assert.equal(conflict.code, "automation_revision_conflict");
      assert.equal(conflict.expectedRevision, 1);
      assert.equal(conflict.actualRevision, 2);
    }),
  );

  it.effect("暂停与恢复保持双向 lifecycle，并以新 revision 重算计划", () =>
    Effect.gen(function* () {
      const store = yield* CompositionAutomationStore;
      const service = makeService(store, { now: makeNow(1_000, 2_000, 3_000) });
      yield* service.create(makeCreateRequest("lifecycle"));

      const paused = yield* service.pause({
        automationId: "lifecycle",
        expectedRevision: 1,
      });
      const resumed = yield* service.resume({
        automationId: "lifecycle",
        expectedRevision: 2,
      });
      const alreadyActive = yield* Effect.flip(
        service.resume({ automationId: "lifecycle", expectedRevision: 3 }),
      );

      assert.equal(paused.status, "paused");
      assert.equal(paused.revision, 2);
      assert.equal(paused.nextRunAtUnixMs, null);
      assert.equal(paused.pausedAtUnixMs, 2_000);
      assert.equal(resumed.status, "active");
      assert.equal(resumed.revision, 3);
      assert.equal(resumed.nextRunAtUnixMs, 63_000);
      assert.equal(resumed.pausedAtUnixMs, null);
      assert.equal(alreadyActive.code, "automation_invalid_state");
    }),
  );

  it.effect("并发编辑同一 revision 时只有一个写入成功", () =>
    Effect.gen(function* () {
      const store = yield* CompositionAutomationStore;
      const service = makeService(store, { now: makeNow(1_000, 2_000, 2_001) });
      yield* service.create(makeCreateRequest("race"));

      const results = yield* Effect.forEach(
        ["并发版本 A", "并发版本 B"],
        (name) =>
          Effect.result(service.update({ automationId: "race", expectedRevision: 1, name })),
        { concurrency: 2 },
      );

      assert.equal(results.filter((result) => result._tag === "Success").length, 1);
      const failure = results.find((result) => result._tag === "Failure");
      assert.equal(
        failure?._tag === "Failure" ? failure.failure.code : undefined,
        "automation_revision_conflict",
      );
      assert.equal((yield* service.get("race")).revision, 2);
    }),
  );

  it.effect("列表、删除和不存在错误都保留稳定领域语义", () =>
    Effect.gen(function* () {
      const store = yield* CompositionAutomationStore;
      const service = makeService(store, { now: makeNow(1_000, 1_001, 2_000) });
      const first = yield* service.create(
        makeCreateRequest("first", { projectId: "list-project" }),
      );
      yield* service.create(makeCreateRequest("second", { projectId: "other-project" }));

      assert.deepEqual(yield* service.list({ projectId: "list-project" }), [first]);
      const deleted = yield* service.delete({ automationId: "first", expectedRevision: 1 });
      const missing = yield* Effect.flip(service.get("first"));

      assert.equal(deleted.automationId, "first");
      assert.equal(deleted.deletedAtUnixMs, 2_000);
      assert.equal(missing.code, "automation_not_found");
    }),
  );

  it.effect("立即运行不推进 cadence，operation 重放跨 revision 返回原 Run", () =>
    Effect.gen(function* () {
      const store = yield* CompositionAutomationStore;
      const startedRuns: Array<string> = [];
      const service = makeService(store, {
        now: makeNow(1_000, 2_000, 3_000, 4_000),
        ensureStarted: (input) =>
          Effect.sync(() => {
            startedRuns.push(input.run.automationRunId);
          }),
      });
      yield* service.create(makeCreateRequest("run-once"));

      const first = yield* service.runOnce({
        automationId: "run-once",
        expectedRevision: 1,
        operationId: "operation-run-once",
      });
      const unchanged = yield* service.get("run-once");
      yield* service.update({
        automationId: "run-once",
        expectedRevision: 1,
        name: "已编辑的自动化",
      });
      const replay = yield* service.runOnce({
        automationId: "run-once",
        expectedRevision: 1,
        operationId: "operation-run-once",
      });
      const staleNewOperation = yield* Effect.flip(
        service.runOnce({
          automationId: "run-once",
          expectedRevision: 1,
          operationId: "operation-stale-new",
        }),
      );

      assert.equal(first.trigger, "run_once");
      assert.equal(first.operationId, "operation-run-once");
      assert.equal(first.status, "running");
      assert.equal(unchanged.runCount, 0);
      assert.equal(unchanged.nextRunAtUnixMs, 61_000);
      assert.equal(replay.automationRunId, first.automationRunId);
      assert.deepEqual(startedRuns, [first.automationRunId, first.automationRunId]);
      assert.equal(staleNewOperation.code, "automation_revision_conflict");
    }),
  );

  it.effect("失败重试复用来源 revision，并拒绝非 failed Run", () =>
    Effect.gen(function* () {
      const store = yield* CompositionAutomationStore;
      const observedRevisions: Array<number> = [];
      const service = makeService(store, {
        now: makeNow(1_000, 2_000, 3_000, 4_000),
        ensureStarted: (input) =>
          Effect.sync(() => {
            observedRevisions.push(input.automation.revision);
          }),
      });
      yield* service.create(makeCreateRequest("retry"));
      const source = yield* service.runOnce({
        automationId: "retry",
        expectedRevision: 1,
        operationId: "operation-source",
      });
      const failedSource: CompositionAutomationRun = {
        ...source,
        status: "failed",
        finishedAtUnixMs: 3_500,
        errorCode: "runtime_unavailable",
        errorDetail: "Runtime 暂时不可用。",
      };
      yield* store.saveRunTransition({ run: failedSource, expectedStatus: "running" });
      yield* service.update({
        automationId: "retry",
        expectedRevision: 1,
        name: "revision 2",
      });

      const retried = yield* service.retry({
        automationId: "retry",
        automationRunId: source.automationRunId,
        expectedRevision: 2,
        operationId: "operation-retry",
      });
      const invalidSource = yield* Effect.flip(
        service.retry({
          automationId: "retry",
          automationRunId: retried.automationRunId,
          expectedRevision: 2,
          operationId: "operation-retry-running",
        }),
      );

      assert.equal(retried.trigger, "retry");
      assert.equal(retried.sourceAutomationRunId, source.automationRunId);
      assert.equal(retried.automationRevision, 1);
      assert.equal(retried.attempt, 2);
      assert.equal(retried.status, "running");
      assert.deepEqual(observedRevisions, [1, 1]);
      assert.equal(invalidSource.code, "automation_invalid_state");
    }),
  );

  it.effect("执行器永久失败落库为 failed，瞬态失败返回可恢复错误并保留 running", () =>
    Effect.gen(function* () {
      const store = yield* CompositionAutomationStore;
      const service = makeService(store, {
        now: makeNow(1_000, 1_001, 2_000, 2_001),
        ensureStarted: (input) =>
          Effect.fail(
            new CompositionAutomationRunExecutorError({
              code:
                input.automation.automationId === "permanent"
                  ? "automation_target_invalid"
                  : "automation_runtime_unavailable",
              detail:
                input.automation.automationId === "permanent"
                  ? "目标配置无效。"
                  : "Runtime 暂时不可用。",
              retryable: input.automation.automationId !== "permanent",
            }),
          ),
      });
      yield* service.create(makeCreateRequest("permanent"));
      yield* service.create(makeCreateRequest("transient"));

      const permanent = yield* service.runOnce({
        automationId: "permanent",
        expectedRevision: 1,
        operationId: "operation-permanent",
      });
      const transientError = yield* Effect.flip(
        service.runOnce({
          automationId: "transient",
          expectedRevision: 1,
          operationId: "operation-transient",
        }),
      );
      const transientRuns = yield* service.listRuns({ automationId: "transient" });

      assert.equal(permanent.status, "failed");
      assert.equal(permanent.errorCode, "automation_target_invalid");
      assert.equal(transientError.code, "automation_run_retry_pending");
      assert.equal(transientRuns.runs[0]?.status, "running");
    }),
  );
});
