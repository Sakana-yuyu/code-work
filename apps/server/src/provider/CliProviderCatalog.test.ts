import { ProviderDriverKind } from "@codework/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";

import {
  cliProviderCatalogIdentity,
  makeCliProviderCatalog,
  withCatalogAbortSignal,
  type CliProviderCatalogData,
} from "./CliProviderCatalog.ts";
import { ProviderCatalogForceRefresh } from "./ProviderCatalogCache.ts";

const directory = (slug: string): CliProviderCatalogData => ({
  models: [{ slug, name: slug, isCustom: false, capabilities: null }],
});

describe("withCatalogAbortSignal", () => {
  it.effect("预取消不启动加载", () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      controller.abort();
      let started = false;
      const exit = yield* withCatalogAbortSignal(
        Effect.sync(() => (started = true)),
        controller.signal,
      ).pipe(Effect.exit);
      assert.isFalse(started);
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterrupts(exit.cause));
    }),
  );

  it.effect("同步工作回执触发取消也等待实际资源终结", () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const closed = yield* Deferred.make<void>();
      let started = 0;
      const work = Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.sync(() => started++),
            () => Deferred.succeed(closed, undefined),
          );
          yield* Effect.sync(() => controller.abort());
          return yield* Effect.never;
        }),
      );
      const fiber = yield* withCatalogAbortSignal(work, controller.signal).pipe(Effect.forkChild());
      yield* Deferred.await(closed);
      const exit = yield* Fiber.await(fiber);
      assert.strictEqual(started, 1);
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterrupts(exit.cause));
    }),
  );

  it.effect("外部调用者取消保留中断并终结资源", () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const entered = yield* Deferred.make<void>();
      let closed = 0;
      const work = Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(Deferred.succeed(entered, undefined), () =>
            Effect.sync(() => closed++),
          );
          return yield* Effect.never;
        }),
      );
      const fiber = yield* withCatalogAbortSignal(work, controller.signal).pipe(Effect.forkChild());
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      assert.strictEqual(closed, 1);
      assert.isFalse(controller.signal.aborted);
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterrupts(exit.cause));
    }),
  );

  it.effect("成功移除监听器，仍使用当前服务与原返回值", () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const signal = controller.signal;
      const originalAdd = signal.addEventListener.bind(signal);
      const originalRemove = signal.removeEventListener.bind(signal);
      let added = 0;
      let removed = 0;
      signal.addEventListener = (...args) => {
        added++;
        originalAdd(...args);
      };
      signal.removeEventListener = (...args) => {
        removed++;
        originalRemove(...args);
      };
      const value = yield* withCatalogAbortSignal(LoaderValue, signal).pipe(
        Effect.provideService(LoaderValue, "actual"),
      );
      assert.strictEqual(value, "actual");
      assert.strictEqual(added, 1);
      assert.strictEqual(removed, 1);
      controller.abort();
    }),
  );

  it.effect("预期错误原样返回而不降级为取消", () =>
    Effect.gen(function* () {
      const result = yield* withCatalogAbortSignal(
        Effect.fail("expected"),
        new AbortController().signal,
      ).pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.strictEqual(result.failure, "expected");
    }),
  );
});

const target = {
  driver: ProviderDriverKind.make("cursor"),
  operation: "models",
  config: { binaryPath: "C:/Agent/agent.cmd", args: ["-e", "https://example.test/Models"] },
  cwd: "C:/Project",
  environment: { API_KEY: "synthetic-key", HOME: "C:/Profile" },
};

class LoaderValue extends Context.Service<LoaderValue, string>()(
  "codework/provider/CliProviderCatalog.test/LoaderValue",
) {}

describe("CliProviderCatalog", () => {
  it("身份忽略对象键顺序，但保留目录的所有执行差异", () => {
    const key = cliProviderCatalogIdentity(target);
    assert.match(key, /^[a-f0-9]{64}$/);
    assert.strictEqual(
      key,
      cliProviderCatalogIdentity({
        ...target,
        config: { args: target.config.args, binaryPath: target.config.binaryPath },
        environment: { HOME: target.environment.HOME, API_KEY: target.environment.API_KEY },
      }),
    );
    for (const changed of [
      { ...target, driver: ProviderDriverKind.make("grok") },
      { ...target, operation: "skills" },
      { ...target, cwd: "C:/Other" },
      { ...target, config: { ...target.config, args: target.config.args.toReversed() } },
      { ...target, config: { ...target.config, binaryPath: "C:/Other/agent.cmd" } },
      { ...target, environment: { ...target.environment, API_KEY: "changed-key" } },
      { ...target, environment: { ...target.environment, HOME: "C:/OtherProfile" } },
    ]) {
      assert.notStrictEqual(key, cliProviderCatalogIdentity(changed));
    }
  });

  it.effect("一分钟内复用成功目录，到期后使用当前调用者的服务和加载器", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCliProviderCatalog();
      let loads = 0;
      const load = LoaderValue.pipe(
        Effect.map((value) => {
          loads += 1;
          return directory(value);
        }),
      );
      const key = cliProviderCatalogIdentity(target);
      const first = yield* catalog
        .fetchCatalog({ key, load })
        .pipe(Effect.provideService(LoaderValue, "first"));
      yield* TestClock.adjust("59999 millis");
      assert.strictEqual(
        yield* catalog
          .fetchCatalog({ key, load })
          .pipe(Effect.provideService(LoaderValue, "second")),
        first,
      );
      yield* TestClock.adjust("1 millis");
      assert.deepStrictEqual(
        yield* catalog
          .fetchCatalog({ key, load })
          .pipe(Effect.provideService(LoaderValue, "second")),
        directory("second"),
      );
      assert.strictEqual(loads, 2);
    }),
  );

  it.effect("失败不缓存，也不延长之前成功目录的有效期", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCliProviderCatalog();
      yield* catalog.fetchCatalog({ key: "key", load: Effect.succeed(directory("first")) });
      yield* TestClock.adjust("59 seconds");
      const failure = yield* catalog
        .fetchCatalog({ key: "key", load: Effect.fail("probe failed"), forceRefresh: true })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(failure));
      if (Result.isFailure(failure)) assert.strictEqual(failure.failure.cause, "probe failed");
      assert.deepStrictEqual(
        yield* catalog.fetchCatalog({ key: "key", load: Effect.die("尚未到期") }),
        directory("first"),
      );
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(
        yield* catalog.fetchCatalog({ key: "key", load: Effect.succeed(directory("retry")) }),
        directory("retry"),
      );
    }),
  );

  it.effect("手动刷新意图生效，显式false仍可读取有效缓存", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCliProviderCatalog();
      yield* catalog.fetchCatalog({ key: "key", load: Effect.succeed(directory("first")) });
      const forced = yield* catalog
        .fetchCatalog({ key: "key", load: Effect.succeed(directory("forced")) })
        .pipe(Effect.provideService(ProviderCatalogForceRefresh, true));
      assert.deepStrictEqual(forced, directory("forced"));
      assert.strictEqual(
        yield* catalog
          .fetchCatalog({ key: "key", load: Effect.die("显式使用缓存"), forceRefresh: false })
          .pipe(Effect.provideService(ProviderCatalogForceRefresh, true)),
        forced,
      );
    }),
  );

  it.effect("等价调用共享加载，取消首个等待者不终止另一实例的请求", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCliProviderCatalog();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let loads = 0;
      let finalized = 0;
      const load = Effect.gen(function* () {
        loads += 1;
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        return directory("shared");
      }).pipe(Effect.ensuring(Effect.sync(() => finalized++)));
      const first = yield* catalog
        .fetchCatalog({ key: "key", load })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      const second = yield* catalog
        .fetchCatalog({ key: "key", load })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.interrupt(first);
      assert.strictEqual(finalized, 0);
      yield* Deferred.succeed(release, undefined);
      assert.deepStrictEqual(yield* Fiber.join(second), directory("shared"));
      assert.strictEqual(loads, 1);
      assert.strictEqual(finalized, 1);
    }),
  );

  it.effect("原生完整刷新可在自己的Scope中加载目录并复用同一完成缓存", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCliProviderCatalog();
      const value = yield* Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* Scope.Scope;
          return yield* catalog.fetchCatalog({
            key: "owned",
            shareInFlight: false,
            load: Effect.gen(function* () {
              assert.strictEqual(yield* Scope.Scope, owner);
              assert.strictEqual(yield* LoaderValue, "current");
              return directory("owned");
            }),
          });
        }),
      ).pipe(Effect.provideService(LoaderValue, "current"));
      assert.strictEqual(
        yield* catalog.fetchCatalog({ key: "owned", load: Effect.die("必须复用完成目录") }),
        value,
      );
    }),
  );
});
