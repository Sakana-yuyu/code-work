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
import * as TestClock from "effect/testing/TestClock";

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
  it.effect("active 用量更新只结算一次耗时，频繁更新保留不足一秒的区间", () =>
    Effect.gen(function* () {
      const store = yield* ThreadGoalStore;
      yield* store.set({ threadId, objective: "校验计时区间" });
      yield* TestClock.adjust("10 seconds");
      const first = yield* store.setStatus({ threadId, status: "active", tokensUsed: 100 });
      yield* TestClock.adjust("10 seconds");
      const second = yield* store.setStatus({ threadId, status: "active", tokensUsed: 200 });
      assert.deepEqual([first.timeUsedSeconds, second.timeUsedSeconds], [10, 20]);
      yield* TestClock.adjust("500 millis");
      yield* store.setStatus({ threadId, status: "active", tokensUsed: 300 });
      yield* TestClock.adjust("500 millis");
      assert.equal((yield* store.pause(threadId)).timeUsedSeconds, 21);
      yield* TestClock.adjust("10 seconds");
      assert.equal((yield* store.resume(threadId)).timeUsedSeconds, 21);
    }),
  );

  it.effect("旧 Goal 或旧状态的异步用量更新不能覆盖新状态", () =>
    Effect.gen(function* () {
      const store = yield* ThreadGoalStore;
      const goal = yield* store.set({ threadId, objective: "旧目标" });
      yield* store.pause(threadId);
      const staleStatus = yield* store
        .setStatus({
          threadId,
          status: "active",
          tokensUsed: 100,
          expectedGoalId: goal.goalId,
          expectedStatus: "active",
          expectedTokensUsed: 0,
        })
        .pipe(Effect.flip);
      assert.equal(
        isThreadGoalStoreDomainError(staleStatus) ? staleStatus.code : undefined,
        "stale-version",
      );
      const replacement = yield* store.set({ threadId, objective: "新目标" });
      const staleGoal = yield* store
        .setStatus({
          threadId,
          status: "usageLimited",
          tokensUsed: 200,
          expectedGoalId: goal.goalId,
        })
        .pipe(Effect.flip);
      assert.equal(
        isThreadGoalStoreDomainError(staleGoal) ? staleGoal.code : undefined,
        "stale-version",
      );
      const staleClear = yield* store
        .clear({ threadId, expectedGoalId: goal.goalId })
        .pipe(Effect.flip);
      assert.equal(
        isThreadGoalStoreDomainError(staleClear) ? staleClear.code : undefined,
        "stale-version",
      );
      assert.deepEqual(Option.getOrThrow(yield* store.get(threadId)), replacement);
    }),
  );

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
      yield* TestClock.adjust("1 second");
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

  it.effect("usageLimited 允许手动恢复为 active，blocked 不允许", () =>
    Effect.gen(function* () {
      const store = yield* ThreadGoalStore;
      yield* store.set({ threadId, objective: "Recover from usage limit", tokenBudget: 100 });

      const limited = yield* store.setStatus({
        threadId,
        status: "usageLimited",
        tokensUsed: 120,
      });
      assert.equal(limited.status, "usageLimited");
      assert.equal(limited.tokensUsed, 120);
      const recovered = yield* store.resume(threadId);
      assert.equal(recovered.status, "active");
      // 恢复后用量保留，不因状态切换清零。
      assert.equal(recovered.tokensUsed, 120);

      yield* store.setStatus({ threadId, status: "blocked" });
      const blockedResume = yield* store.resume(threadId).pipe(Effect.flip);
      assert.isTrue(isThreadGoalStoreDomainError(blockedResume));
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
