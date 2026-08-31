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
import * as Stream from "effect/Stream";

import { ThreadGoalStore, ThreadGoalStoreDomainError } from "../Services/ThreadGoalStore.ts";
import { SqlitePersistenceMemory, makeSqlitePersistenceLive } from "./Sqlite.ts";
import { ThreadGoalStoreLive } from "./ThreadGoalStore.ts";

const memoryLayer = it.layer(
  ThreadGoalStoreLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  ),
);

const makeFileStoreLayer = (dbPath: string) =>
  ThreadGoalStoreLive.pipe(
    Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
    Layer.provide(NodeServices.layer),
  );

const threadId = ThreadId.make("thread-goal-test");
const isThreadGoalStoreDomainError = Schema.is(ThreadGoalStoreDomainError);

memoryLayer("ThreadGoalStore", (it) => {
  it.effect("set 首次生成稳定服务端 goalId，相同输入幂等且不同目标重置", () =>
    Effect.gen(function* () {
      const store = yield* ThreadGoalStore;
      const first = yield* store.set({
        threadId,
        objective: "Ship the native goal experience",
        tokenBudget: 10_000,
      });
      const replay = yield* store.set({
        threadId,
        objective: "Ship the native goal experience",
        tokenBudget: 10_000,
      });
      const replaced = yield* store.set({
        threadId,
        objective: "Ship the second goal",
        tokenBudget: null,
      });

      assert.equal(first.status, "active");
      assert.isTrue(first.goalId.length > 0);
      assert.deepEqual(replay, first);
      assert.notEqual(replaced.goalId, first.goalId);
      assert.equal(replaced.tokensUsed, 0);
      assert.equal(replaced.timeUsedSeconds, 0);
      assert.deepEqual(Option.getOrThrow(yield* store.get(threadId)), replaced);
    }),
  );

  it.effect("pause/resume 单调推进状态，complete 后拒绝回退", () =>
    Effect.gen(function* () {
      const store = yield* ThreadGoalStore;
      yield* store.set({ threadId, objective: "Exercise transitions", tokenBudget: null });

      const paused = yield* store.pause(threadId);
      const resumed = yield* store.resume(threadId);
      const completed = yield* store.setStatus({ threadId, status: "complete" });
      const staleResume = yield* store.resume(threadId).pipe(Effect.flip);
      const stalePause = yield* store.pause(threadId).pipe(Effect.flip);

      assert.equal(paused.status, "paused");
      assert.equal(resumed.status, "active");
      assert.equal(completed.status, "complete");
      assert.isTrue(isThreadGoalStoreDomainError(staleResume));
      assert.isTrue(isThreadGoalStoreDomainError(stalePause));
      const staleResumeError = isThreadGoalStoreDomainError(staleResume)
        ? staleResume
        : yield* Effect.die("expected invalid-transition domain error");
      const stalePauseError = isThreadGoalStoreDomainError(stalePause)
        ? stalePause
        : yield* Effect.die("expected invalid-transition domain error");
      assert.equal(staleResumeError.code, "invalid-transition");
      assert.equal(stalePauseError.code, "invalid-transition");
    }),
  );

  it.effect("clear 删除 Goal 并发布 typed cleared 事件", () =>
    Effect.gen(function* () {
      const store = yield* ThreadGoalStore;
      const goal = yield* store.set({ threadId, objective: "Clear me", tokenBudget: null });
      const events = yield* store.subscribe(threadId);
      const eventFiber = yield* events.pipe(Stream.runHead, Effect.forkChild);
      yield* Effect.yieldNow;
      const cleared = yield* store.clear(threadId);
      const event = Option.getOrThrow(yield* Fiber.join(eventFiber));

      assert.deepEqual(cleared, {
        type: "cleared",
        threadId,
        goalId: goal.goalId,
        clearedAt: cleared.clearedAt,
      });
      assert.deepEqual(event, cleared);
      assert.isTrue(Option.isNone(yield* store.get(threadId)));
    }),
  );
});

it.effect("使用同一 SQLite 文件重建 Store 后仍可恢复 Goal", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codework-thread-goal-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const persisted = yield* Effect.gen(function* () {
      const store = yield* ThreadGoalStore;
      return yield* store.set({
        threadId: ThreadId.make("thread-restart"),
        objective: "Survive a real runtime restart",
        tokenBudget: 42,
      });
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));

    yield* Effect.gen(function* () {
      const store = yield* ThreadGoalStore;
      const restored = Option.getOrThrow(yield* store.get(ThreadId.make("thread-restart")));
      assert.deepEqual(restored, persisted);
      const cleared = yield* store.clear(ThreadId.make("thread-restart"));
      assert.equal(cleared.goalId, persisted.goalId);
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));

    yield* Effect.gen(function* () {
      const store = yield* ThreadGoalStore;
      assert.isTrue(Option.isNone(yield* store.get(ThreadId.make("thread-restart"))));
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
