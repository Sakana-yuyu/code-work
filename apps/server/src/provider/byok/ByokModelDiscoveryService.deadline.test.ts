import { describe, it, assert } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderDriverKind } from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerSettingsService } from "../../serverSettings.ts";
import { make } from "./ByokModelDiscoveryService.ts";
import * as ByokCatalog from "./ByokCatalog.ts";

const settings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: {
    "deadline-test": {
      driver: ProviderDriverKind.make("byok"),
      config: {
        enabled: true,
        adapters: [
          {
            id: "catalog",
            protocol: "openai",
            baseURL: "https://deadline.test/v1",
            apiKey: "test-key",
            modelId: "configured",
            modelCatalogURL: "https://deadline.test/first",
            modelCatalogURLs: ["https://deadline.test/second", "https://deadline.test/third"],
            appendModelCatalogCandidates: false,
          },
        ],
      },
    },
  },
};

const makeService = make.pipe(
  Effect.provide(ByokCatalog.layer),
  Effect.provideService(ServerSettingsService, {
    start: Effect.void,
    ready: Effect.void,
    getSettings: Effect.succeed(settings),
    updateSettings: () => Effect.succeed(settings),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.succeed(Stream.empty),
  }),
);

describe("BYOK目录整轮超时", () => {
  for (const phase of ["request", "body"] as const) {
    it.effect(`前一候选耗时后，${phase}挂起也在整轮十五秒内结束`, () =>
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const requests: string[] = [];
        const signals: AbortSignal[] = [];
        let bodyCanceled = false;
        const client = HttpClient.make((request, url, signal) =>
          Effect.gen(function* () {
            requests.push(url.pathname);
            signals.push(signal);
            if (requests.length === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Effect.sleep("8 seconds");
              return HttpClientResponse.fromWeb(
                request,
                new Response("unavailable", { status: 503 }),
              );
            }
            yield* Deferred.succeed(secondStarted, undefined);
            if (phase === "request") return yield* Effect.never;
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                new ReadableStream({
                  cancel() {
                    bodyCanceled = true;
                  },
                }),
              ),
            );
          }),
        );
        const service = yield* makeService.pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );
        const startedAt = yield* Clock.currentTimeMillis;
        const pending = yield* service
          .discover({
            instanceId: "deadline-test",
            adapterId: "catalog",
            forceRefresh: true,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstStarted);
        yield* TestClock.adjust("8 seconds");
        yield* Deferred.await(secondStarted);
        yield* TestClock.adjust("7 seconds");
        assert.isDefined(pending.pollUnsafe(), "整轮截止后不应继续等待下一地址的独立超时");
        const result = yield* Fiber.join(pending);
        assert.strictEqual((yield* Clock.currentTimeMillis) - startedAt, 15_000);
        assert.strictEqual(result.error?.code, "timeout");
        assert.deepStrictEqual(requests, ["/first", "/second"]);
        assert.isTrue(signals.every((signal) => signal.aborted));
        if (phase === "body") assert.isTrue(bodyCanceled);
      }),
    );
  }

  it.effect("剩余预算内的后续候选成功并保留模型结果", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      let calls = 0;
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          calls += 1;
          if (calls === 1) {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Effect.sleep("8 seconds");
            return HttpClientResponse.fromWeb(
              request,
              new Response("unavailable", { status: 503 }),
            );
          }
          yield* Deferred.succeed(secondStarted, undefined);
          yield* Effect.sleep("6 seconds");
          return HttpClientResponse.fromWeb(
            request,
            new Response('{"data":[{"id":"within-budget"}]}'),
          );
        }),
      );
      const service = yield* makeService.pipe(Effect.provideService(HttpClient.HttpClient, client));
      const pending = yield* service
        .discover({ instanceId: "deadline-test", adapterId: "catalog", forceRefresh: true })
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstStarted);
      yield* TestClock.adjust("8 seconds");
      yield* Deferred.await(secondStarted);
      yield* TestClock.adjust("6 seconds");
      const result = yield* Fiber.join(pending);
      assert.strictEqual(result.status, "ready");
      assert.deepStrictEqual(result.models, [{ id: "within-budget" }]);
      assert.strictEqual(calls, 2);
    }),
  );

  it.effect("草稿目录使用相同预算，取消时释放请求且不启动下一个候选", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const signals: AbortSignal[] = [];
      const client = HttpClient.make((_request, _url, signal) =>
        Effect.gen(function* () {
          signals.push(signal);
          yield* Deferred.succeed(started, undefined);
          return yield* Effect.never;
        }),
      );
      const service = yield* makeService.pipe(Effect.provideService(HttpClient.HttpClient, client));
      const pending = yield* service
        .discoverDraft({
          protocol: "openai",
          baseURL: "https://draft-deadline.test/v1",
          apiKey: "test-key",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("15 seconds");
      assert.strictEqual((yield* Fiber.join(pending)).error?.code, "timeout");
      assert.strictEqual(signals.length, 1);
      assert.isTrue(signals[0]!.aborted);
    }),
  );
});
