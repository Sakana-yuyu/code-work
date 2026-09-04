// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProjectId, ThreadId } from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  startSpecWorkflow,
  transitionSpecWorkflowState,
} from "../../specWorkflow/SpecWorkflowDecider.ts";
import {
  SpecWorkflowStateStore,
  SpecWorkflowStateStoreDomainError,
} from "../Services/SpecWorkflowStateStore.ts";
import { SqlitePersistenceMemory, makeSqlitePersistenceLive } from "./Sqlite.ts";
import { SpecWorkflowStateStoreLive } from "./SpecWorkflowStateStore.ts";

const memoryLayer = it.layer(
  SpecWorkflowStateStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const makeFileStoreLayer = (dbPath: string) =>
  SpecWorkflowStateStoreLive.pipe(
    Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
    Layer.provide(NodeServices.layer),
  );
const isDomainError = Schema.is(SpecWorkflowStateStoreDomainError);

const started = startSpecWorkflow({
  workflowId: "workflow-state-store",
  projectId: ProjectId.make("project-state-store"),
  threadId: ThreadId.make("thread-state-store"),
  changeName: "persisted-state",
  mode: "full",
  updatedAt: 1,
});
const designed = transitionSpecWorkflowState(
  started.state,
  { type: "advance", to: "design", expectedRevision: started.state.revision },
  2,
);
const proposed = transitionSpecWorkflowState(
  designed.state,
  { type: "advance", to: "propose", expectedRevision: designed.state.revision },
  3,
);

memoryLayer("SpecWorkflowStateStore", (it) => {
  it.effect("按连续 revision 持久化、重复事件幂等并拒绝过期写入", () =>
    Effect.gen(function* () {
      const store = yield* SpecWorkflowStateStore;
      const first = yield* store.append({
        threadId: started.state.threadId,
        event: started,
        expectedRevision: 0,
      });
      const replay = yield* store.append({
        threadId: started.state.threadId,
        event: started,
        expectedRevision: 0,
      });
      const second = yield* store.append({
        threadId: started.state.threadId,
        event: designed,
        expectedRevision: 1,
      });
      const stale = yield* store
        .append({
          threadId: started.state.threadId,
          event: proposed,
          expectedRevision: 1,
        })
        .pipe(Effect.flip);

      assert.deepEqual(first, started.state);
      assert.deepEqual(replay, first);
      assert.deepEqual(second, designed.state);
      assert.isTrue(isDomainError(stale));
      assert.equal(isDomainError(stale) ? stale.code : "invalid-input", "revision-conflict");
      assert.deepEqual(yield* store.get(started.state.threadId), Option.some(designed.state));
      assert.deepEqual(yield* store.listStates(), [designed.state]);
      assert.equal((yield* store.listEvents(started.state.threadId)).length, 2);
    }),
  );
});

it.effect("使用同一 SQLite 文件重建 Store 后仍可恢复 workflow snapshot 和事件", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codework-spec-workflow-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const persisted = yield* Effect.gen(function* () {
      const store = yield* SpecWorkflowStateStore;
      return yield* store.append({
        threadId: started.state.threadId,
        event: started,
        expectedRevision: 0,
      });
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));

    yield* Effect.gen(function* () {
      const store = yield* SpecWorkflowStateStore;
      const restored = yield* store.get(started.state.threadId);
      assert.deepEqual(restored, Option.some(persisted));
      assert.deepEqual(yield* store.listStates(), [persisted]);
      assert.equal((yield* store.listEvents(started.state.threadId)).length, 1);
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
