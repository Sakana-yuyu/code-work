import { ByokSettings } from "@codework/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { ByokCatalog } from "./byok/ByokCatalog.ts";
import { fetchByokProviderCatalog } from "./ByokProviderCatalog.ts";
import { makeNativeProviderCatalog, type NativeProviderCatalog } from "./NativeProviderCatalog.ts";
import { ProviderCatalogForceRefresh } from "./ProviderCatalogCache.ts";

const settings = Schema.decodeSync(ByokSettings)({
  enabled: true,
  adapters: [
    {
      id: "first",
      displayName: "配置模型",
      modelId: "configured",
      protocol: "openai",
      baseURL: "https://example.test/v1",
      apiKey: "synthetic",
    },
  ],
});

const fixture = Effect.fn("makeByokRefreshFixture")(function* () {
  const native = yield* makeNativeProviderCatalog();
  const scanEntered = yield* Deferred.make<void>();
  const scanRelease = yield* Deferred.make<void>();
  const modelEntered = yield* Deferred.make<void>();
  const modelRelease = yield* Deferred.make<void>();
  const joined = yield* Deferred.make<void>();
  const state = {
    blockScan: false,
    blockModel: false,
    scans: 0,
    requests: 0,
    models: 0,
    closed: 0,
  };
  const fs = FileSystem.makeNoop({
    readDirectory: () =>
      Effect.gen(function* () {
        state.scans++;
        yield* Deferred.succeed(scanEntered, undefined);
        if (state.blockScan)
          yield* Deferred.await(scanRelease).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                state.closed++;
              }),
            ),
          );
        return ["review"];
      }),
    readFileString: () => Effect.succeed("---\nname: review\ndescription: 检查\n---\n正文"),
  });
  const catalog = ByokCatalog.of({
    fetchCatalog: () =>
      Effect.gen(function* () {
        state.models++;
        yield* Deferred.succeed(modelEntered, undefined);
        if (state.blockModel) yield* Deferred.await(modelRelease);
        return {
          cached: false,
          value: { status: "ready", models: [{ id: "remote" }], source: "fixture" },
        };
      }),
  });
  const observed: NativeProviderCatalog = {
    ...native,
    fetchCatalog: (input) =>
      Effect.gen(function* () {
        state.requests++;
        if (state.requests === 2) yield* Deferred.succeed(joined, undefined);
        return yield* native.fetchCatalog(input);
      }),
  };
  const fetch = (config = settings, cwd = "/fixture/project") =>
    fetchByokProviderCatalog({
      settings: config,
      cwd,
      nativeCatalog: observed,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provide(Path.layer),
      Effect.provideService(ByokCatalog, catalog),
    );
  return { fetch, state, scanEntered, scanRelease, modelEntered, modelRelease, joined };
});

describe("BYOK 模型与技能完整刷新", () => {
  it.effect("后续目标挂起时保留前一目录模型，不被整轮预算覆盖", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let calls = 0;
      const catalog = ByokCatalog.of({
        fetchCatalog: () =>
          Effect.gen(function* () {
            calls++;
            if (calls === 2) {
              yield* Deferred.succeed(entered, undefined);
              return yield* Effect.never;
            }
            return {
              cached: false,
              value: { status: "ready", models: [{ id: "finished" }], source: "fixture" },
            };
          }),
      });
      const config = {
        ...settings,
        adapters: [
          settings.adapters[0]!,
          { ...settings.adapters[0]!, id: "second", baseURL: "https://second.test/v1" },
        ],
      };
      const pending = yield* fetchByokProviderCatalog({ settings: config, cwd: "/fixture" }).pipe(
        Effect.provideService(ByokCatalog, catalog),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({ readDirectory: () => Effect.succeed([]) }),
        ),
        Effect.provide(Path.layer),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust("15 seconds");
      assert.deepStrictEqual(
        (yield* Fiber.join(pending)).models.map((m) => m.slug),
        ["first", "second", "first/finished"],
      );
    }),
  );
  it.effect("技能扫描挂起时十五秒返回已发现模型并释放读取，下一轮可恢复", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.state.blockScan = true;
      const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
      const pending = yield* f.fetch().pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(f.scanEntered);
      yield* TestClock.adjust("15 seconds");
      const snapshot = yield* Fiber.join(pending);
      assert.deepStrictEqual(
        snapshot.models.map((m) => m.slug),
        ["first", "first/remote"],
      );
      assert.deepStrictEqual(snapshot.skills, []);
      assert.include(snapshot.message!, "十五秒");
      assert.strictEqual(f.state.closed, 1);
      assert.strictEqual(Date.parse(snapshot.checkedAt) - startedAt, 15_000);
      f.state.blockScan = false;
      const recovered = yield* f.fetch();
      assert.deepStrictEqual(
        recovered.skills.map((s) => s.name),
        ["review"],
      );
      assert.notInclude(recovered.message!, "十五秒");
    }),
  );
  it.effect("模型挂起时保留已扫描技能和配置模型", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.state.blockModel = true;
      const pending = yield* f.fetch().pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(f.modelEntered);
      yield* TestClock.adjust("15 seconds");
      const snapshot = yield* Fiber.join(pending);
      assert.deepStrictEqual(
        snapshot.models.map((m) => m.slug),
        ["first"],
      );
      assert.deepStrictEqual(
        snapshot.skills.map((s) => s.name),
        ["review"],
      );
      assert.include(snapshot.message!, "十五秒");
    }),
  );
  it.effect("等价配置晚加入共用技能扫描和原预算，余额凭据不改变发现身份", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.state.blockScan = true;
      const first = yield* f.fetch().pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(f.scanEntered);
      yield* TestClock.adjust("8 seconds");
      const second = yield* f
        .fetch({
          ...settings,
          adapters: [{ ...settings.adapters[0]!, balanceAccessToken: "unrelated-balance-token" }],
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(f.joined);
      yield* TestClock.adjust("7 seconds");
      assert.deepStrictEqual(yield* Fiber.join(first), yield* Fiber.join(second));
      assert.strictEqual(f.state.scans, 1);
      assert.strictEqual(f.state.models, 1);
    }),
  );
  it.effect("取消一个等待者保留共享扫描，最后一个取消才关闭读取", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.state.blockScan = true;
      const first = yield* f.fetch().pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(f.scanEntered);
      const second = yield* f.fetch().pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(f.joined);
      yield* Fiber.interrupt(first);
      assert.strictEqual(f.state.closed, 0);
      yield* Fiber.interrupt(second);
      assert.strictEqual(f.state.closed, 1);
    }),
  );
  for (const change of ["cwd", "credentials", "name"] as const) {
    it.effect(`${change} 改变时不合并不同技能范围或模型快照`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.state.blockScan = true;
        const first = yield* f.fetch().pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(f.scanEntered);
        const config = {
          ...settings,
          adapters: [
            {
              ...settings.adapters[0]!,
              ...(change === "credentials" ? { apiKey: "different" } : {}),
              ...(change === "name" ? { displayName: "另一模型名" } : {}),
            },
          ],
        };
        const second = yield* f
          .fetch(config, change === "cwd" ? "/other" : undefined)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(f.joined);
        yield* TestClock.adjust("15 seconds");
        yield* Fiber.join(first);
        const snapshot = yield* Fiber.join(second);
        assert.strictEqual(f.state.scans, 2);
        assert.strictEqual(f.state.models, 2);
        if (change === "name") assert.strictEqual(snapshot.models[0]!.name, "另一模型名");
      }),
    );
  }
  it.effect("等待中编辑配置不会改变本轮快照，手动刷新重新读取技能", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.state.blockModel = true;
      const config = { ...settings, adapters: settings.adapters.map((a) => ({ ...a })) };
      const pending = yield* f.fetch(config).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(f.modelEntered);
      config.adapters[0]!.displayName = "后来修改";
      yield* Deferred.succeed(f.modelRelease, undefined);
      assert.strictEqual((yield* Fiber.join(pending)).models[0]!.name, "配置模型");
      f.state.blockModel = false;
      const result = yield* f
        .fetch(config)
        .pipe(Effect.provideService(ProviderCatalogForceRefresh, true));
      assert.strictEqual(result.models[0]!.name, "后来修改");
      assert.strictEqual(f.state.scans, 12);
    }),
  );
});
