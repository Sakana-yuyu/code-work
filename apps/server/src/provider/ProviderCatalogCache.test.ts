import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import { makeProviderCatalogCache, ProviderCatalogForceRefresh } from "./ProviderCatalogCache.ts";

const makeCache = (capacity = 2) =>
  makeProviderCatalogCache<number>({ ttlMs: 1_000, capacity, shouldCache: (value) => value > 0 });

describe("ProviderCatalogCache", () => {
  it.effect("强制刷新上下文默认关闭且可局部启用", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* ProviderCatalogForceRefresh);
      assert.isTrue(
        yield* ProviderCatalogForceRefresh.pipe(
          Effect.provideService(ProviderCatalogForceRefresh, true),
        ),
      );
      assert.isFalse(yield* ProviderCatalogForceRefresh);
    }),
  );

  it.effect("TTL命中不加载，到期后使用当前调用的加载器", () =>
    Effect.gen(function* () {
      const { fetchCatalog } = yield* makeCache();
      let oldLoads = 0;
      const first = yield* fetchCatalog({
        key: "a",
        load: Effect.sync(() => ++oldLoads),
      });
      assert.deepStrictEqual(first, { value: 1, cached: false });
      yield* TestClock.adjust("999 millis");
      assert.deepStrictEqual(
        yield* fetchCatalog({ key: "a", load: Effect.die("不应执行命中的加载器") }),
        { value: 1, cached: true },
      );
      yield* TestClock.adjust("1 millis");
      assert.deepStrictEqual(yield* fetchCatalog({ key: "a", load: Effect.succeed(2) }), {
        value: 2,
        cached: false,
        previous: 1,
      });
      assert.strictEqual(oldLoads, 1);
    }),
  );

  it.effect("TTL从加载完成计算", () =>
    Effect.gen(function* () {
      const { fetchCatalog } = yield* makeCache();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const first = yield* fetchCatalog({
        key: "a",
        load: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(1),
        ),
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      assert.deepStrictEqual(yield* fetchCatalog({ key: "a", load: Effect.succeed(2) }), {
        value: 1,
        cached: true,
      });
    }),
  );

  for (const mode of ["普通未命中", "强制未命中", "强制刷新"] as const) {
    it.effect(`${mode}与同key并发请求只执行一次加载`, () =>
      Effect.gen(function* () {
        const { fetchCatalog } = yield* makeCache();
        const seeded = mode === "强制刷新";
        if (seeded) yield* fetchCatalog({ key: "a", load: Effect.succeed(1) });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let loads = 0;
        const first = yield* fetchCatalog({
          key: "a",
          forceRefresh: mode !== "普通未命中",
          load: Effect.gen(function* () {
            loads += 1;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return 2;
          }),
        }).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);
        const second = yield* fetchCatalog({
          key: "a",
          forceRefresh: mode !== "强制未命中",
          load: Effect.die("并发调用不能重复加载"),
        }).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(first);
        assert.deepStrictEqual(yield* Fiber.join(second), result);
        assert.deepStrictEqual(result, {
          value: 2,
          cached: false,
          ...(seeded ? { previous: 1 } : {}),
        });
        assert.strictEqual(loads, 1);
        assert.deepStrictEqual(
          yield* fetchCatalog({ key: "a", forceRefresh: true, load: Effect.succeed(3) }),
          { value: 3, cached: false, previous: 2 },
        );
      }),
    );
  }

  it.effect("跨key加载互不等待，容量不会逐出在途检查", () =>
    Effect.gen(function* () {
      const { fetchCatalog } = yield* makeCache(1);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const first = yield* fetchCatalog({
        key: "a",
        load: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(1),
        ),
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      assert.deepStrictEqual(yield* fetchCatalog({ key: "b", load: Effect.succeed(2) }), {
        value: 2,
        cached: false,
      });
      const second = yield* fetchCatalog({ key: "a", load: Effect.die("在途检查不能被逐出") }).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(release, undefined);
      assert.deepStrictEqual(yield* Fiber.join(second), yield* Fiber.join(first));
    }),
  );

  it.effect("不可缓存结果保留最后成功值，调用方获得previous且下一次重新加载", () =>
    Effect.gen(function* () {
      const { fetchCatalog } = yield* makeCache();
      yield* fetchCatalog({ key: "a", load: Effect.succeed(1) });
      yield* TestClock.adjust("500 millis");
      assert.deepStrictEqual(
        yield* fetchCatalog({ key: "a", forceRefresh: true, load: Effect.succeed(0) }),
        { value: 0, cached: false, previous: 1 },
      );
      assert.deepStrictEqual(yield* fetchCatalog({ key: "a", load: Effect.succeed(2) }), {
        value: 1,
        cached: true,
      });
      yield* TestClock.adjust("500 millis");
      assert.deepStrictEqual(yield* fetchCatalog({ key: "a", load: Effect.succeed(0) }), {
        value: 0,
        cached: false,
        previous: 1,
      });
      assert.deepStrictEqual(yield* fetchCatalog({ key: "a", load: Effect.succeed(2) }), {
        value: 2,
        cached: false,
        previous: 1,
      });
    }),
  );

  it.effect("上一轮等待者结束清理时仍保留同key新一轮加载", () =>
    Effect.gen(function* () {
      const { fetchCatalog } = yield* makeCache();
      const firstEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const nextEntered = yield* Deferred.make<void>();
      const releaseNext = yield* Deferred.make<void>();
      const first = yield* fetchCatalog({
        key: "a",
        load: Deferred.succeed(firstEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirst)),
          Effect.as(1),
        ),
      }).pipe(
        Effect.andThen(
          fetchCatalog({
            key: "a",
            forceRefresh: true,
            load: Deferred.succeed(nextEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseNext)),
              Effect.as(2),
            ),
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(firstEntered);
      const second = yield* fetchCatalog({ key: "a", load: Effect.die("不能重复第一轮") }).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Deferred.await(nextEntered);
      assert.deepStrictEqual(yield* Fiber.join(second), { value: 1, cached: false });
      const third = yield* fetchCatalog({
        key: "a",
        forceRefresh: true,
        load: Effect.die("旧等待者不能清除新一轮在途记录"),
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(releaseNext, undefined);
      assert.deepStrictEqual(yield* Fiber.join(first), { value: 2, cached: false, previous: 1 });
      assert.deepStrictEqual(yield* Fiber.join(third), { value: 2, cached: false, previous: 1 });
    }),
  );

  it.effect("加载失败结束全部等待者，下一次使用新加载器恢复", () =>
    Effect.gen(function* () {
      const { fetchCatalog } = yield* makeCache();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const first = yield* fetchCatalog({
        key: "a",
        load: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.die("受控加载失败")),
        ),
      }).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      const second = yield* fetchCatalog({ key: "a", load: Effect.succeed(99) }).pipe(
        Effect.exit,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(release, undefined);
      assert.strictEqual((yield* Fiber.join(first))._tag, "Failure");
      assert.strictEqual((yield* Fiber.join(second))._tag, "Failure");
      assert.deepStrictEqual(yield* fetchCatalog({ key: "a", load: Effect.succeed(2) }), {
        value: 2,
        cached: false,
      });
    }),
  );

  for (const cancelAll of [false, true]) {
    it.effect(`${cancelAll ? "全部" : "单个"}等待者取消后缓存仍可使用`, () =>
      Effect.gen(function* () {
        const { fetchCatalog } = yield* makeCache();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const first = yield* fetchCatalog({
          key: "a",
          load: Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(1),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
        }).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);
        const second = yield* fetchCatalog({ key: "a", load: Effect.die("不能重复加载") }).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Fiber.interrupt(first);
        assert.isFalse(yield* Deferred.isDone(interrupted));
        if (cancelAll) {
          yield* Fiber.interrupt(second);
          yield* Deferred.await(interrupted);
          assert.deepStrictEqual(yield* fetchCatalog({ key: "a", load: Effect.succeed(2) }), {
            value: 2,
            cached: false,
          });
        } else {
          yield* Deferred.succeed(release, undefined);
          assert.deepStrictEqual(yield* Fiber.join(second), { value: 1, cached: false });
        }
      }),
    );
  }

  it.effect("短等待者超时返回previous，长等待者仍取得共享加载结果", () =>
    Effect.gen(function* () {
      const { fetchCatalog } = yield* makeCache();
      yield* fetchCatalog({ key: "a", load: Effect.succeed(1) });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const short = yield* fetchCatalog({
        key: "a",
        forceRefresh: true,
        timeout: { milliseconds: 100, onTimeout: () => 9 },
        load: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(2),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      const long = yield* fetchCatalog({
        key: "a",
        forceRefresh: true,
        timeout: { milliseconds: 1_000, onTimeout: () => 8 },
        load: Effect.die("不能重复共享加载"),
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("100 millis");
      assert.deepStrictEqual(yield* Fiber.join(short), { value: 9, cached: false, previous: 1 });
      assert.isFalse(yield* Deferred.isDone(interrupted));
      assert.deepStrictEqual(yield* fetchCatalog({ key: "a", load: Effect.succeed(99) }), {
        value: 1,
        cached: true,
      });
      yield* Deferred.succeed(release, undefined);
      assert.deepStrictEqual(yield* Fiber.join(long), { value: 2, cached: false, previous: 1 });
    }),
  );

  it.effect("全部等待者超时后中断加载且可重新加载", () =>
    Effect.gen(function* () {
      const { fetchCatalog } = yield* makeCache();
      const entered = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const first = yield* fetchCatalog({
        key: "a",
        timeout: { milliseconds: 100, onTimeout: () => 9 },
        load: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      const second = yield* fetchCatalog({
        key: "a",
        timeout: { milliseconds: 200, onTimeout: () => 8 },
        load: Effect.die("不能重复共享加载"),
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("100 millis");
      assert.deepStrictEqual(yield* Fiber.join(first), { value: 9, cached: false });
      assert.isFalse(yield* Deferred.isDone(interrupted));
      yield* TestClock.adjust("100 millis");
      assert.deepStrictEqual(yield* Fiber.join(second), { value: 8, cached: false });
      yield* Deferred.await(interrupted);
      assert.deepStrictEqual(yield* fetchCatalog({ key: "a", load: Effect.succeed(2) }), {
        value: 2,
        cached: false,
      });
    }),
  );

  for (const milliseconds of [0, -1]) {
    it.effect(`${milliseconds}毫秒预算直接回退，不启动加载且仍允许TTL命中`, () =>
      Effect.gen(function* () {
        const { fetchCatalog } = yield* makeCache();
        yield* fetchCatalog({ key: "a", load: Effect.succeed(1) });
        const input = {
          key: "a",
          load: Effect.die("预算耗尽不能启动加载"),
          timeout: { milliseconds, onTimeout: () => 9 },
        };
        assert.deepStrictEqual(yield* fetchCatalog(input), { value: 1, cached: true });
        assert.deepStrictEqual(yield* fetchCatalog({ ...input, forceRefresh: true }), {
          value: 9,
          cached: false,
          previous: 1,
        });
        assert.deepStrictEqual(yield* fetchCatalog({ ...input, key: "b" }), {
          value: 9,
          cached: false,
        });
        assert.deepStrictEqual(yield* fetchCatalog({ key: "b", load: Effect.succeed(2) }), {
          value: 2,
          cached: false,
        });
      }),
    );
  }

  it.effect("完成值按最近使用顺序逐出且不同cache实例隔离", () =>
    Effect.gen(function* () {
      const { fetchCatalog } = yield* makeCache(2);
      yield* fetchCatalog({ key: "a", load: Effect.succeed(1) });
      yield* fetchCatalog({ key: "b", load: Effect.succeed(2) });
      yield* fetchCatalog({ key: "a", load: Effect.die("应命中缓存") });
      yield* fetchCatalog({ key: "c", load: Effect.succeed(3) });
      assert.deepStrictEqual(yield* fetchCatalog({ key: "b", load: Effect.succeed(4) }), {
        value: 4,
        cached: false,
      });
      const another = yield* makeCache();
      assert.deepStrictEqual(yield* another.fetchCatalog({ key: "b", load: Effect.succeed(5) }), {
        value: 5,
        cached: false,
      });
    }),
  );

  it.effect("零容量禁用完成值复用", () =>
    Effect.gen(function* () {
      const { fetchCatalog } = yield* makeCache(0);
      yield* fetchCatalog({ key: "a", load: Effect.succeed(1) });
      assert.deepStrictEqual(yield* fetchCatalog({ key: "a", load: Effect.succeed(2) }), {
        value: 2,
        cached: false,
      });
    }),
  );

  for (const capacity of [0, 2]) {
    it.effect(`首等待者取消后容量${capacity}的下一次刷新使用当前加载器`, () =>
      Effect.gen(function* () {
        const { fetchCatalog } = yield* makeCache(capacity);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const first = yield* fetchCatalog({
          key: "a",
          load: Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(1),
          ),
        }).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);
        const second = yield* fetchCatalog({ key: "a", load: Effect.die("必须共享当前加载") }).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Fiber.interrupt(first);
        yield* Deferred.succeed(release, undefined);
        assert.deepStrictEqual(yield* Fiber.join(second), { value: 1, cached: false });
        assert.deepStrictEqual(
          yield* fetchCatalog({ key: "a", forceRefresh: true, load: Effect.succeed(2) }),
          { value: 2, cached: false, ...(capacity > 0 ? { previous: 1 } : {}) },
        );
      }),
    );
  }

  it.effect("调用者拥有加载时仍共享完成值，旧加载不能覆盖后启动的刷新", () =>
    Effect.gen(function* () {
      const { fetchCatalog } = yield* makeCache();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const old = yield* fetchCatalog({
        key: "a",
        shareInFlight: false,
        load: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(1),
        ),
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      assert.deepStrictEqual(
        yield* fetchCatalog({
          key: "a",
          shareInFlight: false,
          forceRefresh: true,
          load: Effect.succeed(2),
        }),
        { value: 2, cached: false },
      );
      yield* Deferred.succeed(release, undefined);
      assert.deepStrictEqual(yield* Fiber.join(old), { value: 1, cached: false });
      assert.deepStrictEqual(
        yield* fetchCatalog({ key: "a", load: Effect.die("必须保留新目录") }),
        {
          value: 2,
          cached: true,
        },
      );
    }),
  );

  it.effect("新代失败后旧代晚完成也不写回，原成功值的TTL不延长", () =>
    Effect.gen(function* () {
      const { fetchCatalog } = yield* makeCache();
      yield* fetchCatalog({ key: "a", load: Effect.succeed(1) });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const old = yield* fetchCatalog({
        key: "a",
        shareInFlight: false,
        forceRefresh: true,
        load: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(3),
        ),
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      yield* fetchCatalog({
        key: "a",
        shareInFlight: false,
        forceRefresh: true,
        load: Effect.succeed(-1),
      });
      assert.deepStrictEqual(yield* fetchCatalog({ key: "a", load: Effect.die("未过期") }), {
        value: 1,
        cached: true,
      });
      yield* TestClock.adjust("1 second");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(old);
      assert.deepStrictEqual(yield* fetchCatalog({ key: "a", load: Effect.succeed(4) }), {
        value: 4,
        cached: false,
        previous: 1,
      });
    }),
  );

  it.effect("取消调用者加载不影响同键另一个拥有者", () =>
    Effect.gen(function* () {
      const { fetchCatalog } = yield* makeCache();
      const entered = yield* Deferred.make<void>();
      const secondEntered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const first = yield* fetchCatalog({
        key: "a",
        shareInFlight: false,
        load: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      const second = yield* fetchCatalog({
        key: "a",
        shareInFlight: false,
        load: Deferred.succeed(secondEntered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(2),
        ),
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(secondEntered);
      yield* Fiber.interrupt(first);
      yield* Deferred.await(interrupted);
      yield* Deferred.succeed(release, undefined);
      assert.deepStrictEqual(yield* Fiber.join(second), { value: 2, cached: false });
    }),
  );

  it.effect("普通拥有者晚到目录阶段不能取代进行中的强刷新写权限", () =>
    Effect.gen(function* () {
      const { fetchCatalog } = yield* makeCache();
      const strongEntered = yield* Deferred.make<void>();
      const ordinaryEntered = yield* Deferred.make<void>();
      const strongRelease = yield* Deferred.make<void>();
      const ordinaryRelease = yield* Deferred.make<void>();
      const strong = yield* fetchCatalog({
        key: "a",
        shareInFlight: false,
        forceRefresh: true,
        load: Deferred.succeed(strongEntered, undefined).pipe(
          Effect.andThen(Deferred.await(strongRelease)),
          Effect.as(2),
        ),
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(strongEntered);
      const ordinary = yield* fetchCatalog({
        key: "a",
        shareInFlight: false,
        load: Deferred.succeed(ordinaryEntered, undefined).pipe(
          Effect.andThen(Deferred.await(ordinaryRelease)),
          Effect.as(1),
        ),
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(ordinaryEntered);
      yield* Deferred.succeed(strongRelease, undefined);
      yield* Fiber.join(strong);
      yield* Deferred.succeed(ordinaryRelease, undefined);
      yield* Fiber.join(ordinary);
      assert.deepStrictEqual(
        yield* fetchCatalog({ key: "a", load: Effect.die("应保留强刷新结果") }),
        { value: 2, cached: true },
      );
    }),
  );

  it.effect("Promise同步发回执后取消也释放加载，下一次同键使用新闭包", () =>
    Effect.gen(function* () {
      const cache = yield* makeCache();
      const entered = yield* Deferred.make<void>();
      const aborted = yield* Deferred.make<void>();
      const first = yield* cache
        .fetchCatalog({
          key: "a",
          load: Effect.promise((signal) => {
            signal.addEventListener("abort", () => Deferred.doneUnsafe(aborted, Effect.void), {
              once: true,
            });
            Deferred.doneUnsafe(entered, Effect.void);
            return new Promise<number>(() => undefined);
          }),
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(first);
      yield* Deferred.await(aborted);
      assert.isFalse(yield* cache.hasInFlight("a"));
      assert.deepStrictEqual(yield* cache.fetchCatalog({ key: "a", load: Effect.succeed(2) }), {
        value: 2,
        cached: false,
      });
    }),
  );
  it.effect("强加载先进入但失败，随后进入的普通加载也不能回填旧目录", () =>
    Effect.gen(function* () {
      const { fetchCatalog } = yield* makeCache();
      yield* fetchCatalog({ key: "a", load: Effect.succeed(9) });
      yield* TestClock.adjust("1 second");
      const strongEntered = yield* Deferred.make<void>();
      const ordinaryEntered = yield* Deferred.make<void>();
      const strongRelease = yield* Deferred.make<void>();
      const ordinaryRelease = yield* Deferred.make<void>();
      const strong = yield* fetchCatalog({
        key: "a",
        shareInFlight: false,
        forceRefresh: true,
        load: Deferred.succeed(strongEntered, undefined).pipe(
          Effect.andThen(Deferred.await(strongRelease)),
          Effect.as(-1),
        ),
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(strongEntered);
      const ordinary = yield* fetchCatalog({
        key: "a",
        shareInFlight: false,
        load: Deferred.succeed(ordinaryEntered, undefined).pipe(
          Effect.andThen(Deferred.await(ordinaryRelease)),
          Effect.as(1),
        ),
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(ordinaryEntered);
      yield* Deferred.succeed(strongRelease, undefined);
      yield* Fiber.join(strong);
      yield* Deferred.succeed(ordinaryRelease, undefined);
      yield* Fiber.join(ordinary);
      assert.deepStrictEqual(yield* fetchCatalog({ key: "a", load: Effect.succeed(3) }), {
        value: 3,
        cached: false,
        previous: 9,
      });
    }),
  );
});
