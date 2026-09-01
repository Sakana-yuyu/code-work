import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import { runCompositionRunStartRecoveryScheduler } from "./CompositionRunStartRecoveryScheduler.ts";

it.effect("lease 到期会自动恢复，Registry 变化也会立即触发下一次扫描", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* Queue.sliding<void>(1);
      const firstRecovery = yield* Deferred.make<void>();
      const secondRecovery = yield* Deferred.make<void>();
      let recoveries = 0;
      yield* runCompositionRunStartRecoveryScheduler({
        initialReceipt: {
          type: "composition.run_starts.recovered",
          recoveredAtUnixMs: 0,
          plans: [],
          nextRecoveryAtUnixMs: 100,
        },
        changes,
        recover: Effect.gen(function* () {
          recoveries += 1;
          yield* Deferred.succeed(recoveries === 1 ? firstRecovery : secondRecovery, undefined);
          return {
            type: "composition.run_starts.recovered" as const,
            recoveredAtUnixMs: recoveries === 1 ? 100 : 101,
            plans: [],
          };
        }),
      }).pipe(Effect.forkScoped);

      yield* TestClock.adjust("99 millis");
      assert.isFalse(yield* Deferred.isDone(firstRecovery));
      yield* TestClock.adjust("1 millis");
      yield* Deferred.await(firstRecovery);
      assert.equal(recoveries, 1);

      yield* Queue.offer(changes, undefined);
      yield* Deferred.await(secondRecovery);
      assert.equal(recoveries, 2);
    }),
  ),
);

it.effect("恢复返回的新 lease 到期后会自动再次扫描", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* Queue.sliding<void>(1);
      const firstRecovery = yield* Deferred.make<void>();
      const secondRecovery = yield* Deferred.make<void>();
      let recoveries = 0;
      yield* runCompositionRunStartRecoveryScheduler({
        initialReceipt: {
          type: "composition.run_starts.recovered",
          recoveredAtUnixMs: 0,
          plans: [],
          nextRecoveryAtUnixMs: 100,
        },
        changes,
        recover: Effect.gen(function* () {
          recoveries += 1;
          yield* Deferred.succeed(recoveries === 1 ? firstRecovery : secondRecovery, undefined);
          return {
            type: "composition.run_starts.recovered" as const,
            recoveredAtUnixMs: recoveries === 1 ? 100 : 250,
            plans: [],
            ...(recoveries === 1 ? { nextRecoveryAtUnixMs: 250 } : {}),
          };
        }),
      }).pipe(Effect.forkScoped);

      yield* TestClock.adjust("100 millis");
      yield* Deferred.await(firstRecovery);
      assert.equal(recoveries, 1);

      yield* TestClock.adjust("149 millis");
      assert.isFalse(yield* Deferred.isDone(secondRecovery));
      yield* TestClock.adjust("1 millis");
      yield* Deferred.await(secondRecovery);
      assert.equal(recoveries, 2);
    }),
  ),
);

it.effect("扫描进行中多次唤醒只合并为一个后续扫描", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* Queue.sliding<void>(1);
      const firstEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondCompleted = yield* Deferred.make<void>();
      let recoveries = 0;
      yield* runCompositionRunStartRecoveryScheduler({
        changes,
        recover: Effect.gen(function* () {
          recoveries += 1;
          if (recoveries === 1) {
            yield* Deferred.succeed(firstEntered, undefined);
            yield* Deferred.await(releaseFirst);
          } else {
            yield* Deferred.succeed(secondCompleted, undefined);
          }
          return {
            type: "composition.run_starts.recovered" as const,
            recoveredAtUnixMs: recoveries,
            plans: [],
          };
        }),
      }).pipe(Effect.forkScoped);

      yield* Queue.offer(changes, undefined);
      yield* Deferred.await(firstEntered);
      yield* Effect.all(
        [
          Queue.offer(changes, undefined),
          Queue.offer(changes, undefined),
          Queue.offer(changes, undefined),
        ],
        { discard: true },
      );
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Deferred.await(secondCompleted);
      yield* Effect.yieldNow;

      assert.equal(recoveries, 2);
    }),
  ),
);

it.effect("恢复失败默认等待三十秒再重试，避免持续故障时高频扫描", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* Queue.sliding<void>(1);
      const firstAttempt = yield* Deferred.make<void>();
      const secondRecovery = yield* Deferred.make<void>();
      let recoveries = 0;
      yield* runCompositionRunStartRecoveryScheduler({
        changes,
        recover: Effect.gen(function* () {
          recoveries += 1;
          if (recoveries === 1) {
            yield* Deferred.succeed(firstAttempt, undefined);
            return yield* Effect.fail("recovery dependency offline");
          }
          yield* Deferred.succeed(secondRecovery, undefined);
          return {
            type: "composition.run_starts.recovered" as const,
            recoveredAtUnixMs: 30_000,
            plans: [],
          };
        }),
      }).pipe(Effect.forkScoped);

      yield* Queue.offer(changes, undefined);
      yield* Deferred.await(firstAttempt);
      assert.equal(recoveries, 1);

      yield* TestClock.adjust("29999 millis");
      assert.isFalse(yield* Deferred.isDone(secondRecovery));
      yield* TestClock.adjust("1 millis");
      yield* Deferred.await(secondRecovery);
      assert.equal(recoveries, 2);
    }),
  ),
);

it.effect("显式失败重试间隔会覆盖默认值", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* Queue.sliding<void>(1);
      const firstAttempt = yield* Deferred.make<void>();
      const secondRecovery = yield* Deferred.make<void>();
      let recoveries = 0;
      yield* runCompositionRunStartRecoveryScheduler({
        changes,
        failureRetryMs: 7_000,
        recover: Effect.gen(function* () {
          recoveries += 1;
          if (recoveries === 1) {
            yield* Deferred.succeed(firstAttempt, undefined);
            return yield* Effect.fail("recovery dependency offline");
          }
          yield* Deferred.succeed(secondRecovery, undefined);
          return {
            type: "composition.run_starts.recovered" as const,
            recoveredAtUnixMs: 7_000,
            plans: [],
          };
        }),
      }).pipe(Effect.forkScoped);

      yield* Queue.offer(changes, undefined);
      yield* Deferred.await(firstAttempt);

      yield* TestClock.adjust("6999 millis");
      assert.isFalse(yield* Deferred.isDone(secondRecovery));
      yield* TestClock.adjust("1 millis");
      yield* Deferred.await(secondRecovery);
      assert.equal(recoveries, 2);
    }),
  ),
);

it.effect("无 nextRecoveryAt 时三十秒后执行安静扫描", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* Queue.sliding<void>(1);
      const idleRecovery = yield* Deferred.make<void>();
      yield* runCompositionRunStartRecoveryScheduler({
        initialReceipt: {
          type: "composition.run_starts.recovered",
          recoveredAtUnixMs: 0,
          plans: [],
        },
        changes,
        recover: Deferred.succeed(idleRecovery, undefined).pipe(
          Effect.as({
            type: "composition.run_starts.recovered" as const,
            recoveredAtUnixMs: 30_000,
            plans: [],
          }),
        ),
      }).pipe(Effect.forkScoped);

      yield* TestClock.adjust("29999 millis");
      assert.isFalse(yield* Deferred.isDone(idleRecovery));
      yield* TestClock.adjust("1 millis");
      yield* Effect.yieldNow;
      assert.isTrue(yield* Deferred.isDone(idleRecovery));
    }),
  ),
);
