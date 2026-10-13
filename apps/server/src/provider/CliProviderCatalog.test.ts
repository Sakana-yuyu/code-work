import { ProviderDriverKind } from "@codework/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { TestClock } from "effect/testing";

import {
  cliProviderCatalogIdentity,
  makeCliProviderCatalog,
  type CliProviderCatalogData,
} from "./CliProviderCatalog.ts";
import { ProviderCatalogForceRefresh } from "./ProviderCatalogCache.ts";

const directory = (slug: string): CliProviderCatalogData => ({
  models: [{ slug, name: slug, isCustom: false, capabilities: null }],
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
});
