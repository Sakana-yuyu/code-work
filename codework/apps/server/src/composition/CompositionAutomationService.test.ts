import { assert, it } from "@effect/vitest";
import type {
  CompositionAutomationCreateRequest,
  CompositionAutomationTarget,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CompositionAutomationStoreLive } from "../persistence/Layers/CompositionAutomationStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CompositionAutomationStore } from "../persistence/Services/CompositionAutomationStore.ts";
import { makeCompositionAutomationService } from "./CompositionAutomationService.ts";

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

layer("CompositionAutomationService", (it) => {
  it.effect("创建 Automation 时由服务端生成 revision、时间和首个计划点", () =>
    Effect.gen(function* () {
      const store = yield* CompositionAutomationStore;
      const service = makeCompositionAutomationService({ store, now: () => 1_000 });

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
      const service = makeCompositionAutomationService({ store, now: () => 1_000 });

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
      const service = makeCompositionAutomationService({
        store,
        now: makeNow(1_000, 2_000),
      });
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
      const service = makeCompositionAutomationService({
        store,
        now: makeNow(1_000, 2_000, 3_000),
      });
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
      const service = makeCompositionAutomationService({
        store,
        now: makeNow(1_000, 2_000, 2_001),
      });
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
      const service = makeCompositionAutomationService({
        store,
        now: makeNow(1_000, 1_001, 2_000),
      });
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
});
