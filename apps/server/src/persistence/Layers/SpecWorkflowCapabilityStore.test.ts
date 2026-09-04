// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ThreadId } from "@codework/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Stream from "effect/Stream";

import {
  SpecWorkflowCapabilityStore,
  SpecWorkflowCapabilityStoreDomainError,
} from "../Services/SpecWorkflowCapabilityStore.ts";
import { SqlitePersistenceMemory, makeSqlitePersistenceLive } from "./Sqlite.ts";
import { SpecWorkflowCapabilityStoreLive } from "./SpecWorkflowCapabilityStore.ts";

const memoryLayer = it.layer(
  SpecWorkflowCapabilityStoreLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  ),
);

const makeFileStoreLayer = (dbPath: string) =>
  SpecWorkflowCapabilityStoreLive.pipe(
    Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
    Layer.provide(NodeServices.layer),
  );

const threadId = ThreadId.make("spec-workflow-capability-test");
const transitionThreadId = ThreadId.make("spec-workflow-transition-test");
const isDomainError = Schema.is(SpecWorkflowCapabilityStoreDomainError);

memoryLayer("SpecWorkflowCapabilityStore", (it) => {
  it.effect("未设置时默认关闭且不写入能力记录，显式设置后相同输入幂等", () =>
    Effect.gen(function* () {
      const store = yield* SpecWorkflowCapabilityStore;
      const sql = yield* SqlClient.SqlClient;

      const initial = yield* store.get(threadId);
      const rowsBeforeSet = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM thread_spec_workflow_capabilities
        WHERE thread_id = ${threadId}
      `;
      const enabled = yield* store.set({ threadId, enabled: true, expectedRevision: 0 });
      const replay = yield* store.set({
        threadId,
        enabled: true,
        expectedRevision: enabled.revision,
      });

      assert.deepEqual(initial, {
        threadId,
        enabled: false,
        revision: 0,
        updatedAt: 0,
      });
      assert.equal(rowsBeforeSet[0]?.count, 0);
      assert.equal(enabled.enabled, true);
      assert.equal(enabled.revision, 1);
      assert.deepEqual(replay, enabled);
    }),
  );

  it.effect("revision 冲突拒绝旧写入，更新事件可订阅", () =>
    Effect.gen(function* () {
      const store = yield* SpecWorkflowCapabilityStore;
      const initial = yield* store.get(transitionThreadId);
      const events = yield* store.subscribe(transitionThreadId);
      const eventFiber = yield* events.pipe(Stream.runHead, Effect.forkChild);
      yield* Effect.yieldNow;

      const updated = yield* store.set({
        threadId: transitionThreadId,
        enabled: true,
        expectedRevision: initial.revision,
      });
      const stale = yield* store
        .set({
          threadId: transitionThreadId,
          enabled: false,
          expectedRevision: initial.revision,
        })
        .pipe(Effect.flip);
      const event = Option.getOrThrow(yield* Fiber.join(eventFiber));

      assert.equal(updated.revision, 1);
      assert.isTrue(isDomainError(stale));
      if (isDomainError(stale)) assert.equal(stale.code, "stale-version");
      assert.deepEqual(event, { type: "updated", capability: updated });
    }),
  );
});

it.effect("使用同一 SQLite 文件重建 Store 后仍可恢复开关状态", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codework-spec-workflow-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const persisted = yield* Effect.gen(function* () {
      const store = yield* SpecWorkflowCapabilityStore;
      return yield* store.set({
        threadId: ThreadId.make("thread-restart"),
        enabled: true,
        expectedRevision: 0,
      });
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));

    yield* Effect.gen(function* () {
      const store = yield* SpecWorkflowCapabilityStore;
      const restored = yield* store.get(ThreadId.make("thread-restart"));
      assert.deepEqual(restored, persisted);
      const disabled = yield* store.set({
        threadId: ThreadId.make("thread-restart"),
        enabled: false,
        expectedRevision: persisted.revision,
      });
      assert.equal(disabled.enabled, false);
      assert.equal(disabled.revision, 2);
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
