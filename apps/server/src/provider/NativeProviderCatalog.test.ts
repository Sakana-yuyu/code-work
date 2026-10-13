import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import { makeNativeProviderCatalog } from "./NativeProviderCatalog.ts";
import { ProviderCatalogForceRefresh } from "./ProviderCatalogCache.ts";
import { buildServerProvider } from "./providerSnapshot.ts";

const draft = (version: string) =>
  buildServerProvider({
    presentation: { displayName: "原生目录测试" },
    enabled: true,
    checkedAt: "2026-10-13T00:00:00.000Z",
    models: [],
    probe: { installed: true, version, status: "ready", auth: { status: "authenticated" } },
  });
const base = { key: "native", timeoutMs: 10_000, onTimeout: () => draft("timeout") };

describe("NativeProviderCatalog", () => {
  it.effect("等价整次刷新共享一个controller，首等待者取消后其他等待者完成", () =>
    Effect.gen(function* () {
      const catalog = yield* makeNativeProviderCatalog();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const controllers: AbortController[] = [];
      const first = yield* catalog
        .fetchCatalog({
          ...base,
          load: (controller) =>
            Effect.gen(function* () {
              controllers.push(controller);
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return draft("first");
            }),
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      const second = yield* catalog
        .fetchCatalog({ ...base, load: () => Effect.die("应加入同一刷新") })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.interrupt(first);
      assert.isFalse(controllers[0]!.signal.aborted);
      yield* Deferred.succeed(release, undefined);
      assert.strictEqual((yield* Fiber.join(second)).version, "first");
      assert.isTrue(controllers[0]!.signal.aborted);
      assert.strictEqual(
        (yield* catalog.fetchCatalog({
          ...base,
          load: (controller) =>
            Effect.sync(() => {
              controllers.push(controller);
              return draft("current-account");
            }),
        })).version,
        "current-account",
      );
      assert.notStrictEqual(controllers[0], controllers[1]);
      assert.isTrue(controllers[1]!.signal.aborted);
    }),
  );

  it.effect("晚加入者不能重置截止时间，超时释放同一个controller", () =>
    Effect.gen(function* () {
      const catalog = yield* makeNativeProviderCatalog();
      const entered = yield* Deferred.make<void>();
      let controller: AbortController | undefined;
      const first = yield* catalog
        .fetchCatalog({
          ...base,
          load: (owner) => {
            controller = owner;
            return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
          },
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      yield* TestClock.adjust("6 seconds");
      const second = yield* catalog
        .fetchCatalog({ ...base, timeoutMs: 30_000, load: () => Effect.die("不能建立新预算") })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("4 seconds");
      assert.strictEqual((yield* Fiber.join(first)).version, "timeout");
      assert.strictEqual((yield* Fiber.join(second)).version, "timeout");
      assert.isTrue(controller!.signal.aborted);
    }),
  );

  it.effect("最后等待者取消后实际owner信号终止，不转成超时成功", () =>
    Effect.gen(function* () {
      const catalog = yield* makeNativeProviderCatalog();
      const entered = yield* Deferred.make<void>();
      const aborted = yield* Deferred.make<void>();
      const fiber = yield* catalog
        .fetchCatalog({
          ...base,
          load: (controller) => {
            controller.signal.addEventListener(
              "abort",
              () => Deferred.doneUnsafe(aborted, Effect.void),
              { once: true },
            );
            return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
          },
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      yield* Deferred.await(aborted);
      assert.strictEqual(
        (yield* catalog.fetchCatalog({ ...base, load: () => Effect.succeed(draft("recovered")) }))
          .version,
        "recovered",
      );
    }),
  );

  it.effect("强刷新不加入普通加载，普通等待者可加入已有强刷新", () =>
    Effect.gen(function* () {
      const catalog = yield* makeNativeProviderCatalog();
      const ordinaryEntered = yield* Deferred.make<void>();
      const strongEntered = yield* Deferred.make<void>();
      const ordinaryRelease = yield* Deferred.make<void>();
      const strongRelease = yield* Deferred.make<void>();
      const ordinary = yield* catalog
        .fetchCatalog({
          ...base,
          load: () =>
            Effect.gen(function* () {
              assert.isFalse(yield* ProviderCatalogForceRefresh);
              yield* Deferred.succeed(ordinaryEntered, undefined);
              yield* Deferred.await(ordinaryRelease);
              return draft("ordinary");
            }),
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(ordinaryEntered);
      const strong = yield* catalog
        .fetchCatalog({
          ...base,
          forceRefresh: true,
          load: () =>
            Effect.gen(function* () {
              assert.isTrue(yield* ProviderCatalogForceRefresh);
              yield* Deferred.succeed(strongEntered, undefined);
              yield* Deferred.await(strongRelease);
              return draft("strong");
            }),
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(strongEntered);
      const joined = yield* catalog
        .fetchCatalog({ ...base, load: () => Effect.die("普通请求应加入已有强刷新") })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(strongRelease, undefined);
      assert.strictEqual((yield* Fiber.join(strong)).version, "strong");
      assert.strictEqual((yield* Fiber.join(joined)).version, "strong");
      yield* Deferred.succeed(ordinaryRelease, undefined);
      assert.strictEqual((yield* Fiber.join(ordinary)).version, "ordinary");
    }),
  );

  it.effect("显式强弱意图覆盖入口上下文并在整个load内保持", () =>
    Effect.gen(function* () {
      const catalog = yield* makeNativeProviderCatalog();
      const load = () =>
        Effect.gen(function* () {
          return draft((yield* ProviderCatalogForceRefresh) ? "strong" : "ordinary");
        });
      assert.strictEqual(
        (yield* catalog
          .fetchCatalog({ ...base, forceRefresh: false, load })
          .pipe(Effect.provideService(ProviderCatalogForceRefresh, true))).version,
        "ordinary",
      );
      assert.strictEqual(
        (yield* catalog.fetchCatalog({ ...base, forceRefresh: true, load })).version,
        "strong",
      );
    }),
  );
});
