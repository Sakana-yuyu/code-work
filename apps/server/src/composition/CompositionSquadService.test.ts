import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import {
  makeCompositionSquadService,
  type CompositionSquadCreateInput,
} from "./CompositionSquadService.ts";

const layer = it.layer(CompositionTaskStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const makeInput = (
  squadId: string,
  overrides: Partial<CompositionSquadCreateInput> = {},
): CompositionSquadCreateInput => ({
  squadId,
  name: `协同组 ${squadId}`,
  leaderAgentId: `${squadId}-leader`,
  collaborationMode: "leader_workers",
  members: [
    {
      agentId: `${squadId}-leader`,
      role: "leader",
      order: 0,
      required: true,
      model: "provider/leader",
      workspaceRoot: "C:/workspace/leader",
      capabilityIds: ["t3.workspace.read_file"],
      maxConcurrentTasks: 1,
    },
    {
      agentId: `${squadId}-worker`,
      role: "worker",
      order: 1,
      required: true,
      model: "provider/worker",
      workspaceRoot: "C:/workspace/worker",
      capabilityIds: ["t3.workspace.read_file", "t3.workspace.write_file"],
      maxConcurrentTasks: 2,
    },
  ],
  maxConcurrency: 2,
  maxRetries: 1,
  failurePolicy: "fail_fast",
  partialSuccessPolicy: "reject",
  approvalStages: ["before_finalize"],
  ...overrides,
});

const makeNow = (...values: ReadonlyArray<number>): (() => number) => {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
};

layer("CompositionSquadService", (it) => {
  it.effect("创建 Squad 时由服务端生成 projection、revision 和时间戳", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const service = makeCompositionSquadService({ store, now: () => 100 });

      const created = yield* service.create(makeInput("create"));

      assert.equal(created.revision, 1);
      assert.equal(created.createdAtUnixMs, 100);
      assert.equal(created.updatedAtUnixMs, 100);
      assert.deepEqual(created.memberAgentIds, ["create-leader", "create-worker"]);
      assert.deepEqual(yield* service.list(), [created]);
      assert.deepEqual(yield* service.listRevisions(created.squadId), [
        {
          squadId: created.squadId,
          revision: 1,
          configuration: created,
          createdAtUnixMs: 100,
        },
      ]);
    }),
  );

  it.effect("编辑时自动递增 revision，并拒绝陈旧 revision 覆盖", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const service = makeCompositionSquadService({ store, now: makeNow(100, 200) });
      const created = yield* service.create(makeInput("edit"));

      const updated = yield* service.update({
        ...makeInput("edit", { name: "协同组 edit v2", maxConcurrency: 3 }),
        expectedRevision: 1,
      });

      assert.equal(updated.revision, 2);
      assert.equal(updated.createdAtUnixMs, created.createdAtUnixMs);
      assert.equal(updated.updatedAtUnixMs, 200);
      assert.equal(updated.name, "协同组 edit v2");
      const conflict = yield* Effect.flip(
        service.update({
          ...makeInput("edit", { name: "陈旧覆盖" }),
          expectedRevision: 1,
        }),
      );
      assert.equal(conflict.code, "squad_revision_conflict");
      assert.equal(conflict.expectedRevision, 1);
      assert.equal(conflict.actualRevision, 2);
    }),
  );

  it.effect("按固定 revision 读取不可变配置，不受后续编辑和归档影响", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const service = makeCompositionSquadService({ store, now: makeNow(100, 200, 300) });
      const created = yield* service.create(makeInput("history"));
      const updated = yield* service.update({
        ...makeInput("history", { name: "协同组 history v2", maxConcurrency: 3 }),
        expectedRevision: 1,
      });
      const archived = yield* service.archive({ squadId: created.squadId, expectedRevision: 2 });

      assert.deepEqual(yield* service.getRevision(created.squadId, 1), created);
      assert.deepEqual(yield* service.getRevision(created.squadId, 2), updated);
      assert.deepEqual(yield* service.getRevision(created.squadId, 3), archived);

      const missing = yield* Effect.flip(service.getRevision(created.squadId, 4));
      assert.equal(missing.code, "squad_revision_not_found");
      assert.equal(missing.expectedRevision, 4);
      assert.equal(missing.actualRevision, 3);
    }),
  );

  it.effect("旧迁移 revision 缺少完整配置时拒绝伪造恢复", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const service = makeCompositionSquadService({
        store: {
          ...store,
          listSquadRevisions: () =>
            Effect.succeed([
              {
                squadId: "legacy-history",
                revision: 1,
                configuration: null,
                createdAtUnixMs: 100,
              },
            ]),
        },
      });

      const unavailable = yield* Effect.flip(service.getRevision("legacy-history", 1));
      assert.equal(unavailable.code, "squad_revision_unavailable");
      assert.equal(unavailable.expectedRevision, 1);
    }),
  );

  it.effect("复制 Squad 时保留协同策略并建立独立 revision 历史", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const service = makeCompositionSquadService({ store, now: makeNow(100, 200) });
      const source = yield* service.create(makeInput("source"));

      const copied = yield* service.duplicate({
        sourceSquadId: source.squadId,
        squadId: "copy",
        name: "复制后的协同组",
      });

      assert.equal(copied.squadId, "copy");
      assert.equal(copied.name, "复制后的协同组");
      assert.equal(copied.revision, 1);
      assert.equal(copied.createdAtUnixMs, 200);
      assert.deepEqual(copied.members, source.members);
      assert.deepEqual(
        (yield* service.listRevisions(copied.squadId)).map((revision) => revision.revision),
        [1],
      );
    }),
  );

  it.effect("归档 Squad 后禁止编辑和新运行，恢复后重新可运行", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const service = makeCompositionSquadService({ store, now: makeNow(100, 200, 300) });
      const created = yield* service.create(makeInput("archive"));

      const archived = yield* service.archive({ squadId: created.squadId, expectedRevision: 1 });
      assert.equal(archived.revision, 2);
      assert.equal(archived.archivedAtUnixMs, 200);
      assert.isFalse((yield* service.list()).some((squad) => squad.squadId === archived.squadId));
      assert.deepEqual(
        (yield* service.list({ includeArchived: true })).find(
          (squad) => squad.squadId === archived.squadId,
        ),
        archived,
      );

      const runError = yield* Effect.flip(service.getRunnable(created.squadId));
      assert.equal(runError.code, "squad_archived");
      const editError = yield* Effect.flip(
        service.update({ ...makeInput("archive", { name: "归档后编辑" }), expectedRevision: 2 }),
      );
      assert.equal(editError.code, "squad_archived");

      const restored = yield* service.restore({ squadId: created.squadId, expectedRevision: 2 });
      assert.equal(restored.revision, 3);
      assert.isUndefined(restored.archivedAtUnixMs);
      assert.deepEqual(yield* service.getRunnable(created.squadId), restored);
    }),
  );

  it.effect("拒绝缺少唯一 Leader 的非法 Squad 配置", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const service = makeCompositionSquadService({ store, now: () => 100 });
      const invalid = makeInput("invalid", {
        leaderAgentId: "missing-leader",
      });

      const error = yield* Effect.flip(service.create(invalid));

      assert.equal(error.code, "squad_validation_failed");
      assert.isTrue(Option.isNone(yield* store.getSquad(invalid.squadId)));
    }),
  );

  it.effect("并发编辑同一 revision 时只允许一个写入成功", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const service = makeCompositionSquadService({ store, now: makeNow(100, 200, 201) });
      yield* service.create(makeInput("race"));

      const results = yield* Effect.forEach(
        ["并发版本 A", "并发版本 B"],
        (name) =>
          Effect.result(
            service.update({
              ...makeInput("race", { name }),
              expectedRevision: 1,
            }),
          ),
        { concurrency: 2 },
      );

      assert.equal(results.filter((result) => result._tag === "Success").length, 1);
      const failure = results.find((result) => result._tag === "Failure");
      assert.equal(
        failure?._tag === "Failure" ? failure.failure.code : undefined,
        "squad_revision_conflict",
      );
      assert.equal((yield* service.get("race")).revision, 2);
    }),
  );
});
