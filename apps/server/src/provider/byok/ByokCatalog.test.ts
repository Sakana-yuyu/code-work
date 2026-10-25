import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";

import { ProviderCatalogForceRefresh } from "../ProviderCatalogCache.ts";
import { make, type ByokCatalogTarget } from "./ByokCatalog.ts";

const target: ByokCatalogTarget = {
  protocol: "openai",
  baseURL: "https://catalog.test/Original/v1",
  apiKey: "catalog-test-key",
  supplierID: "custom",
  modelCatalogURL: "https://catalog.test/Models?Route=Original",
  appendModelCatalogCandidates: false,
};

describe("ByokCatalog", () => {
  it.effect("等价目标共享一分钟缓存，过期后继续使用原始执行地址", () =>
    Effect.gen(function* () {
      const requested: string[] = [];
      const client = HttpClient.make((request, url) =>
        Effect.sync(() => {
          requested.push(url.toString());
          return HttpClientResponse.fromWeb(
            request,
            new Response(`{"data":[{"id":"model-${requested.length}"}]}`),
          );
        }),
      );
      const catalog = yield* make.pipe(Effect.provideService(HttpClient.HttpClient, client));
      const first = yield* catalog.fetchCatalog(target);
      const cached = yield* catalog.fetchCatalog({ ...target });
      assert.isFalse(first.cached);
      assert.isTrue(cached.cached);
      assert.deepStrictEqual(cached.value, first.value);
      yield* TestClock.adjust("60 seconds");
      const refreshed = yield* catalog.fetchCatalog({ ...target });
      assert.isFalse(refreshed.cached);
      assert.deepStrictEqual(refreshed.value.models, [{ id: "model-2" }]);
      assert.deepStrictEqual(requested, [target.modelCatalogURL, target.modelCatalogURL]);
    }),
  );

  it.effect("已有成功缓存时并发强制刷新仍只探测一次", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let requests = 0;
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          requests += 1;
          if (requests > 1) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
          return HttpClientResponse.fromWeb(
            request,
            new Response(`{"data":[{"id":"model-${requests}"}]}`),
          );
        }),
      );
      const catalog = yield* make.pipe(Effect.provideService(HttpClient.HttpClient, client));
      yield* catalog.fetchCatalog(target);
      const first = yield* catalog
        .fetchCatalog(target, { forceRefresh: true })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      const second = yield* catalog
        .fetchCatalog({ ...target }, { forceRefresh: true })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(first);
      assert.deepStrictEqual(yield* Fiber.join(second), result);
      assert.isFalse(result.cached);
      assert.deepStrictEqual(result.value.models, [{ id: "model-2" }]);
      assert.strictEqual(requests, 2);
    }),
  );

  it.effect("手动刷新上下文生效，显式false可使用缓存", () =>
    Effect.gen(function* () {
      let requests = 0;
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          requests += 1;
          return HttpClientResponse.fromWeb(
            request,
            new Response(`{"data":[{"id":"model-${requests}"}]}`),
          );
        }),
      );
      const catalog = yield* make.pipe(Effect.provideService(HttpClient.HttpClient, client));
      yield* catalog.fetchCatalog(target);
      const forced = yield* catalog
        .fetchCatalog(target)
        .pipe(Effect.provideService(ProviderCatalogForceRefresh, true));
      const cached = yield* catalog
        .fetchCatalog(target, { forceRefresh: false })
        .pipe(Effect.provideService(ProviderCatalogForceRefresh, true));
      assert.isFalse(forced.cached);
      assert.isTrue(cached.cached);
      assert.deepStrictEqual(cached.value.models, [{ id: "model-2" }]);
      assert.strictEqual(requests, 2);
    }),
  );

  it.effect("短等待预算返回同配置旧值，仍有等待者时保留共享刷新", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let requests = 0;
      let refreshSignal: AbortSignal | undefined;
      const client = HttpClient.make((request, _url, signal) =>
        Effect.gen(function* () {
          requests += 1;
          if (requests > 1) {
            refreshSignal = signal;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
          return HttpClientResponse.fromWeb(
            request,
            new Response(`{"data":[{"id":"model-${requests}"}]}`),
          );
        }),
      );
      const catalog = yield* make.pipe(Effect.provideService(HttpClient.HttpClient, client));
      const previous = yield* catalog.fetchCatalog(target);
      const waiting = yield* catalog
        .fetchCatalog(target, { forceRefresh: true })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      const limited = yield* catalog
        .fetchCatalog(target, { forceRefresh: true, timeoutMs: 2_000 })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("2 seconds");
      const timeout = yield* Fiber.join(limited);
      assert.strictEqual(timeout.value.error?.code, "timeout");
      assert.deepStrictEqual(timeout.previous, previous.value);
      assert.isFalse(refreshSignal?.aborted);
      const noBudget = yield* catalog.fetchCatalog(target, {
        forceRefresh: true,
        timeoutMs: 0,
      });
      assert.strictEqual(noBudget.value.error?.code, "timeout");
      assert.deepStrictEqual(noBudget.previous, previous.value);
      assert.strictEqual(requests, 2);
      yield* Deferred.succeed(release, undefined);
      assert.deepStrictEqual((yield* Fiber.join(waiting)).value.models, [{ id: "model-2" }]);
    }),
  );

  it.effect("失败不写入缓存，只返回同配置的前次成功值", () =>
    Effect.gen(function* () {
      let failed = false;
      let requests = 0;
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          requests += 1;
          return HttpClientResponse.fromWeb(
            request,
            failed
              ? new Response("failed", { status: 503 })
              : new Response('{"data":[{"id":"previous-model"}]}'),
          );
        }),
      );
      const catalog = yield* make.pipe(Effect.provideService(HttpClient.HttpClient, client));
      const first = yield* catalog.fetchCatalog(target);
      failed = true;
      const refresh = yield* catalog.fetchCatalog(target, { forceRefresh: true });
      const changed = { ...target, apiKey: "different-key" };
      const isolated = yield* catalog.fetchCatalog(changed);
      yield* catalog.fetchCatalog(changed);
      assert.strictEqual(refresh.value.status, "failed");
      assert.deepStrictEqual(refresh.previous, first.value);
      assert.strictEqual(isolated.value.status, "failed");
      assert.isUndefined(isolated.previous);
      assert.strictEqual(requests, 4);
    }),
  );

  for (const body of ['{"data":[]}', '{"data":[{}]}', "not-json"]) {
    it.effect(`空或畸形目录返回可重试失败：${body}`, () =>
      Effect.gen(function* () {
        let requests = 0;
        let responseBody = body;
        const client = HttpClient.make((request) =>
          Effect.sync(() => {
            requests += 1;
            return HttpClientResponse.fromWeb(request, new Response(responseBody));
          }),
        );
        const catalog = yield* make.pipe(Effect.provideService(HttpClient.HttpClient, client));
        const first = yield* catalog.fetchCatalog(target);
        const retry = yield* catalog.fetchCatalog(target);
        assert.strictEqual(first.value.status, "failed");
        assert.strictEqual(first.value.error?.code, "invalid_payload");
        assert.isFalse(first.cached);
        assert.deepStrictEqual(retry, first);
        assert.strictEqual(requests, 2);
        responseBody = '{"data":[{"id":"recovered-model"}]}';
        const recovered = yield* catalog.fetchCatalog(target);
        assert.strictEqual(recovered.value.status, "ready");
        assert.deepStrictEqual(recovered.value.models, [{ id: "recovered-model" }]);
        assert.strictEqual(requests, 3);
      }),
    );
  }

  it.effect("目录地址和自定义认证请求头变化不会复用另一配置的结果", () =>
    Effect.gen(function* () {
      const requested: Array<{ path: string; account: string | undefined }> = [];
      const client = HttpClient.make((request, url) =>
        Effect.sync(() => {
          requested.push({ path: url.pathname, account: request.headers["x-account"] });
          return HttpClientResponse.fromWeb(
            request,
            new Response(`{"data":[{"id":"model-${requested.length}"}]}`),
          );
        }),
      );
      const catalog = yield* make.pipe(Effect.provideService(HttpClient.HttpClient, client));
      const first = yield* catalog.fetchCatalog({
        ...target,
        customHeaders: '{"x-account":"first"}',
      });
      const second = yield* catalog.fetchCatalog({
        ...target,
        customHeaders: '{"x-account":"second"}',
      });
      const third = yield* catalog.fetchCatalog({
        ...target,
        customHeaders: '{"x-account":"second"}',
        modelCatalogURL: "https://catalog.test/DifferentModels",
      });
      assert.deepStrictEqual(first.value.models, [{ id: "model-1" }]);
      assert.deepStrictEqual(second.value.models, [{ id: "model-2" }]);
      assert.deepStrictEqual(third.value.models, [{ id: "model-3" }]);
      assert.deepStrictEqual(requested, [
        { path: "/Models", account: "first" },
        { path: "/Models", account: "second" },
        { path: "/DifferentModels", account: "second" },
      ]);
    }),
  );
});
