import { describe, it, assert } from "@effect/vitest";
import { ByokSettings, DEFAULT_SERVER_SETTINGS, ProviderDriverKind } from "@codework/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";

import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderCatalogForceRefresh } from "../ProviderCatalogCache.ts";
import * as ByokCatalog from "../byok/ByokCatalog.ts";
import * as ByokModelDiscovery from "../byok/ByokModelDiscoveryService.ts";
import { checkByokProviderStatus } from "./ByokProvider.ts";

const config = Schema.decodeSync(ByokSettings)({
  enabled: true,
  adapters: [
    {
      id: "primary",
      displayName: "测试服务",
      protocol: "openai",
      baseURL: "https://catalog.test/v1",
      apiKey: "test-key",
      modelId: "configured",
      modelCatalogURL: "https://catalog.test/catalog",
      appendModelCatalogCandidates: false,
      customHeaders: '{"x-catalog-owner":"first"}',
    },
  ],
});

describe("BYOK状态与设置页共用目录入口", () => {
  for (const [protocol, header, credential] of [
    ["openai", "authorization", "Bearer test-key"],
    ["anthropic", "x-api-key", "test-key"],
    ["gemini", "x-goog-api-key", "test-key"],
  ] as const) {
    it.effect(`${protocol}状态目录沿统一入口发送对应认证头`, () =>
      Effect.gen(function* () {
        const client = HttpClient.make((request) =>
          Effect.sync(() => {
            assert.strictEqual(request.headers[header], credential);
            return HttpClientResponse.fromWeb(request, new Response('{"data":[{"id":"remote"}]}'));
          }),
        );
        const catalog = yield* ByokCatalog.make.pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );
        const result = yield* checkByokProviderStatus({
          ...config,
          adapters: [{ ...config.adapters[0]!, protocol }],
        }).pipe(Effect.provideService(ByokCatalog.ByokCatalog, catalog));
        assert.deepStrictEqual(
          result.models.map((model) => model.slug),
          ["primary", "primary/remote"],
        );
      }),
    );
  }

  it.effect("保存配置与状态共享目录，状态取出后补当前adapter路由", () =>
    Effect.gen(function* () {
      let calls = 0;
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          calls += 1;
          assert.strictEqual(request.url, "https://catalog.test/catalog");
          assert.strictEqual(request.headers["x-catalog-owner"], "first");
          return HttpClientResponse.fromWeb(
            request,
            new Response('{"data":[{"id":"remote-model"}]}'),
          );
        }),
      );
      const catalog = yield* ByokCatalog.make.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          saved: { driver: ProviderDriverKind.make("byok"), enabled: true, config },
        },
      };
      const service = yield* ByokModelDiscovery.make.pipe(
        Effect.provideService(ByokCatalog.ByokCatalog, catalog),
        Effect.provideService(ServerSettingsService, {
          start: Effect.void,
          ready: Effect.void,
          getSettings: Effect.succeed(settings),
          updateSettings: () => Effect.succeed(settings),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.succeed(Stream.empty),
        }),
      );
      const saved = yield* service
        .discover({ instanceId: "saved", adapterId: "primary" })
        .pipe(Effect.provideService(HttpClient.HttpClient, client));
      const status = yield* checkByokProviderStatus({
        ...config,
        adapters: [{ ...config.adapters[0]!, id: "other", displayName: "另一实例" }],
      }).pipe(Effect.provideService(ByokCatalog.ByokCatalog, catalog));
      assert.strictEqual(calls, 1);
      assert.strictEqual(saved.instanceId, "saved");
      assert.strictEqual(saved.adapterId, "primary");
      assert.deepStrictEqual(
        status.models.map((model) => model.slug),
        ["other", "other/remote-model"],
      );
      yield* checkByokProviderStatus(config).pipe(
        Effect.provideService(ByokCatalog.ByokCatalog, catalog),
        Effect.provideService(ProviderCatalogForceRefresh, true),
      );
      assert.strictEqual(calls, 2);
    }),
  );

  it.effect("一次强制检查只探测等价目录一次，自定义请求头变化单独查询", () =>
    Effect.gen(function* () {
      const owners: (string | undefined)[] = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          owners.push(request.headers["x-catalog-owner"]);
          return HttpClientResponse.fromWeb(request, new Response('{"data":[]}'));
        }),
      );
      const catalog = yield* ByokCatalog.make.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      yield* checkByokProviderStatus({
        ...config,
        adapters: [
          config.adapters[0]!,
          { ...config.adapters[0]!, id: "same" },
          {
            ...config.adapters[0]!,
            id: "different",
            customHeaders: '{"x-catalog-owner":"second"}',
          },
        ],
      }).pipe(
        Effect.provideService(ByokCatalog.ByokCatalog, catalog),
        Effect.provideService(ProviderCatalogForceRefresh, true),
      );
      assert.deepStrictEqual(owners, ["first", "second"]);
    }),
  );

  it.effect("多adapter状态检查共用十五秒预算，保留已完成目录", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      let calls = 0;
      const signals: AbortSignal[] = [];
      const client = HttpClient.make((request, _url, signal) =>
        Effect.gen(function* () {
          calls += 1;
          signals.push(signal);
          if (calls === 1) {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Effect.sleep("8 seconds");
            return HttpClientResponse.fromWeb(
              request,
              new Response('{"data":[{"id":"finished"}]}'),
            );
          }
          yield* Deferred.succeed(secondStarted, undefined);
          return yield* Effect.never;
        }),
      );
      const catalog = yield* ByokCatalog.make.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      const pending = yield* checkByokProviderStatus({
        ...config,
        adapters: [
          config.adapters[0]!,
          { ...config.adapters[0]!, id: "second", apiKey: "second-key" },
          {
            ...config.adapters[0]!,
            id: "third",
            apiKey: "third-key",
          },
        ],
      }).pipe(Effect.provideService(ByokCatalog.ByokCatalog, catalog), Effect.forkChild);
      yield* Deferred.await(firstStarted);
      yield* TestClock.adjust("8 seconds");
      yield* Deferred.await(secondStarted);
      yield* TestClock.adjust("7 seconds");
      assert.isDefined(pending.pollUnsafe());
      const result = yield* Fiber.join(pending);
      assert.strictEqual(calls, 2);
      assert.isTrue(signals.every((signal) => signal.aborted));
      assert.deepStrictEqual(
        result.models.map((model) => model.slug),
        ["primary", "second", "third", "primary/finished"],
      );
      assert.strictEqual(result.status, "ready");
    }),
  );

  it.effect("后续通道的剩余预算耗尽时保留同配置上一份成功目录", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      let calls = 0;
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          calls += 1;
          if (calls === 3) {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Effect.sleep("8 seconds");
          }
          if (calls <= 3)
            return HttpClientResponse.fromWeb(
              request,
              new Response('{"data":[{"id":"previous-model"}]}'),
            );
          yield* Deferred.succeed(secondStarted, undefined);
          return yield* Effect.never;
        }),
      );
      const catalog = yield* ByokCatalog.make.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      const check = checkByokProviderStatus({
        ...config,
        adapters: [
          config.adapters[0]!,
          {
            ...config.adapters[0]!,
            id: "second",
            baseURL: "https://second.test/v1",
            modelCatalogURL: "https://second.test/catalog",
          },
        ],
      }).pipe(Effect.provideService(ByokCatalog.ByokCatalog, catalog));
      const previous = yield* check;
      const pending = yield* check.pipe(
        Effect.provideService(ProviderCatalogForceRefresh, true),
        Effect.forkChild,
      );
      yield* Deferred.await(firstStarted);
      yield* TestClock.adjust("8 seconds");
      yield* Deferred.await(secondStarted);
      yield* TestClock.adjust("7 seconds");
      assert.isDefined(pending.pollUnsafe());
      const refreshed = yield* Fiber.join(pending);
      assert.deepStrictEqual(refreshed.models, previous.models);
      assert.strictEqual(calls, 4);
    }),
  );
});
