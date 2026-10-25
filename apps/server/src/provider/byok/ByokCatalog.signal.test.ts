import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { FetchHttpClient, HttpClient } from "effect/http";

import { make, type ByokCatalogTarget } from "./ByokCatalog.ts";
import { fetchHttpClientLayer, withByokCatalogSignal } from "./ByokHttpClient.ts";
import { fetchByokCatalog } from "./byokHttp.ts";

const target: ByokCatalogTarget = {
  protocol: "openai",
  baseURL: "https://catalog.test/v1",
  apiKey: "fixture-key",
  supplierID: "custom",
  modelCatalogURL: "https://catalog.test/first",
  modelCatalogURLs: ["https://catalog.test/second", "https://catalog.test/third"],
  appendModelCatalogCandidates: false,
};

const models = () => new Response('{"data":[{"id":"fixture-model"}]}');
const asFetch = (
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch => fetch as typeof globalThis.fetch;
const makeCatalog = (fetch: typeof globalThis.fetch, legacy = false) =>
  make.pipe(
    Effect.provide(
      (legacy ? FetchHttpClient.layer : fetchHttpClientLayer).pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
      ),
    ),
  );
const requireSignal = (init?: RequestInit) => {
  assert.instanceOf(init?.signal, AbortSignal);
  return init!.signal!;
};

describe("BYOK 实际 Fetch 共享目录信号", () => {
  it.effect("候选和手工跳转共用信号，跨源不回填默认认证且不泄漏内部标记", () =>
    Effect.gen(function* () {
      const requests: Array<{ url: URL; init: RequestInit; signal: AbortSignal }> = [];
      const fetch = asFetch(async (input, init) => {
        const url = new URL(String(input));
        const signal = requireSignal(init);
        assert.isFalse(signal.aborted, "前一个失败候选不能取消整个刷新");
        assert.deepStrictEqual(Object.getOwnPropertySymbols(init!), []);
        requests.push({ url, init: init!, signal });
        if (url.pathname === "/first")
          return new Response(null, { status: 302, headers: { location: "/moved" } });
        if (url.pathname === "/moved") return new Response("unavailable", { status: 503 });
        if (url.pathname === "/second")
          return new Response(null, {
            status: 302,
            headers: { location: "https://other.test/final" },
          });
        return models();
      });
      const catalog = yield* makeCatalog(fetch);
      const result = yield* catalog.fetchCatalog(target).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, {
          credentials: "omit",
          cache: "no-store",
          redirect: "follow",
          headers: {
            authorization: "ambient-secret",
            cookie: "ambient-cookie",
            "x-api-key": "ambient-key",
          },
        }),
      );
      assert.strictEqual(result.value.status, "ready");
      assert.deepStrictEqual(
        requests.map(({ url }) => url.pathname),
        ["/first", "/moved", "/second", "/final"],
      );
      assert.isTrue(requests.every(({ signal }) => signal === requests[0]!.signal));
      assert.isTrue(requests[0]!.signal.aborted);
      assert.isTrue(requests.every(({ init }) => init.redirect === "manual"));
      assert.isTrue(requests.every(({ init }) => init.credentials === undefined));
      assert.isTrue(requests.every(({ init }) => init.cache === undefined));
      assert.strictEqual(
        new Headers(requests[1]!.init.headers).get("authorization"),
        "Bearer fixture-key",
      );
      assert.isNull(new Headers(requests[3]!.init.headers).get("authorization"));
      assert.isNull(new Headers(requests[3]!.init.headers).get("cookie"));
      assert.isNull(new Headers(requests[3]!.init.headers).get("x-api-key"));
      yield* catalog.fetchCatalog(target, { forceRefresh: true });
      assert.notStrictEqual(requests[4]!.signal, requests[0]!.signal);
      assert.isTrue(requests[4]!.signal.aborted);
    }),
  );

  it.effect("工厂保留 layer 内 custom Fetch 和实际 RequestInit 字段，仅替换信号", () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const observed: RequestInit[] = [];
      const fetch = asFetch(async (_input, init) => {
        observed.push(init!);
        return models();
      });
      const options: RequestInit = {
        credentials: "omit",
        cache: "no-store",
        redirect: "manual",
        headers: { "x-fixture": "preserved" },
      };
      yield* Effect.gen(function* () {
        const client = HttpClient.withScope(yield* HttpClient.HttpClient);
        yield* client.get("https://factory.test/models");
      }).pipe(
        Effect.scoped,
        withByokCatalogSignal(controller.signal),
        Effect.provide(
          fetchHttpClientLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(FetchHttpClient.Fetch, fetch),
                Layer.succeed(FetchHttpClient.RequestInit, options),
              ),
            ),
          ),
        ),
      );
      assert.strictEqual(observed.length, 1);
      assert.strictEqual(observed[0]!.signal, controller.signal);
      assert.strictEqual(observed[0]!.credentials, "omit");
      assert.strictEqual(observed[0]!.cache, "no-store");
      assert.strictEqual(observed[0]!.redirect, "manual");
      assert.strictEqual(new Headers(observed[0]!.headers).get("x-fixture"), "preserved");
      assert.deepStrictEqual(Object.getOwnPropertySymbols(observed[0]!), []);
      assert.isFalse(controller.signal.aborted, "共享 controller 的生命周期由调用者 Scope 持有");
      controller.abort();
    }),
  );

  it.effect("旧标准 HTTP layer 内注入的 custom Fetch 仍被使用且作用域清理保持兼容", () =>
    Effect.gen(function* () {
      const signals: AbortSignal[] = [];
      const catalog = yield* makeCatalog(
        asFetch(async (_input, init) => {
          signals.push(requireSignal(init));
          assert.deepStrictEqual(Object.getOwnPropertySymbols(init!), []);
          return models();
        }),
        true,
      );
      const result = yield* catalog.fetchCatalog(target);
      assert.strictEqual(result.value.status, "ready");
      assert.strictEqual(signals.length, 1);
      assert.isTrue(signals[0]!.aborted);
    }),
  );

  it.effect("执行期 ambient Fetch 不能绕过工厂包装或泄漏内部标记", () =>
    Effect.gen(function* () {
      let ambientCalls = 0;
      const signals: AbortSignal[] = [];
      const catalog = yield* makeCatalog(
        asFetch(async (_input, init) => {
          signals.push(requireSignal(init));
          assert.deepStrictEqual(Object.getOwnPropertySymbols(init!), []);
          return signals.length === 1 ? new Response("retry", { status: 503 }) : models();
        }),
      );
      const result = yield* catalog.fetchCatalog(target).pipe(
        Effect.provideService(
          FetchHttpClient.Fetch,
          asFetch(async () => {
            ambientCalls += 1;
            return models();
          }),
        ),
      );
      assert.strictEqual(result.value.status, "ready");
      assert.strictEqual(ambientCalls, 0);
      assert.strictEqual(signals.length, 2);
      assert.strictEqual(signals[0], signals[1]);
      assert.isTrue(signals[0]!.aborted);
    }),
  );

  it.effect("余额等独立 HTTP 调用继续使用各自 Scope 和信号", () =>
    Effect.gen(function* () {
      const signals: AbortSignal[] = [];
      const fetch = asFetch(async (_input, init) => {
        signals.push(requireSignal(init));
        assert.deepStrictEqual(Object.getOwnPropertySymbols(init!), []);
        return models();
      });
      yield* Effect.gen(function* () {
        yield* fetchByokCatalog({ url: "https://balance.test/first" });
        assert.isTrue(signals[0]!.aborted);
        yield* fetchByokCatalog({ url: "https://balance.test/second" });
      }).pipe(
        Effect.provide(
          fetchHttpClientLayer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
        ),
      );
      assert.notStrictEqual(signals[0], signals[1]);
      assert.isTrue(signals[1]!.aborted);
    }),
  );

  for (const phase of ["request", "body"] as const) {
    it.effect(`前候选耗时后 ${phase} 挂起仍在总十五秒结束并释放共享信号`, () =>
      Effect.gen(function* () {
        const firstEntered = Promise.withResolvers<void>();
        const firstResponse = Promise.withResolvers<Response>();
        const secondEntered = Promise.withResolvers<void>();
        const signals: AbortSignal[] = [];
        let bodyCanceled = false;
        const catalog = yield* makeCatalog(
          asFetch(async (_input, init) => {
            const signal = requireSignal(init);
            signals.push(signal);
            if (signals.length === 1) {
              firstEntered.resolve();
              return firstResponse.promise;
            }
            secondEntered.resolve();
            if (phase === "body")
              return new Response(
                new ReadableStream({
                  cancel() {
                    bodyCanceled = true;
                  },
                }),
              );
            return new Promise<Response>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new Error("fixture canceled")), {
                once: true,
              });
            });
          }),
        );
        const pending = yield* catalog
          .fetchCatalog(target)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => firstEntered.promise);
        yield* TestClock.adjust("8 seconds");
        firstResponse.resolve(new Response("unavailable", { status: 503 }));
        yield* Effect.promise(() => secondEntered.promise);
        assert.strictEqual(signals[0], signals[1]);
        assert.isFalse(signals[0]!.aborted);
        yield* TestClock.adjust("7 seconds");
        const result = yield* Fiber.join(pending);
        assert.strictEqual(result.value.error?.code, "timeout");
        assert.strictEqual(signals.length, 2);
        assert.isTrue(signals[0]!.aborted);
        if (phase === "body") assert.isTrue(bodyCanceled);
      }),
    );
  }

  it.effect("短等待者退出保留共享请求，最后等待者取消后下次加载创建新信号", () =>
    Effect.gen(function* () {
      const entered = Promise.withResolvers<void>();
      const signals: AbortSignal[] = [];
      const catalog = yield* makeCatalog(
        asFetch(async (_input, init) => {
          const signal = requireSignal(init);
          signals.push(signal);
          if (signals.length > 1) return models();
          entered.resolve();
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("fixture canceled")), {
              once: true,
            });
          });
        }),
      );
      const first = yield* catalog
        .fetchCatalog(target)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => entered.promise);
      const second = yield* catalog
        .fetchCatalog(target)
        .pipe(Effect.forkChild({ startImmediately: true }));
      const limited = yield* catalog
        .fetchCatalog(target, { timeoutMs: 2_000 })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.interrupt(first);
      assert.isFalse(signals[0]!.aborted);
      yield* TestClock.adjust("2 seconds");
      assert.strictEqual((yield* Fiber.join(limited)).value.error?.code, "timeout");
      assert.isFalse(signals[0]!.aborted);
      yield* Fiber.interrupt(second);
      assert.isTrue(signals[0]!.aborted);
      assert.strictEqual((yield* catalog.fetchCatalog(target)).value.status, "ready");
      assert.strictEqual(signals.length, 2);
      assert.notStrictEqual(signals[0], signals[1]);
      assert.isTrue(signals[1]!.aborted);
    }),
  );

  it.effect("所有候选失败也释放信号，失败不缓存且恢复后使用新信号", () =>
    Effect.gen(function* () {
      let failed = true;
      const signals: AbortSignal[] = [];
      const catalog = yield* makeCatalog(
        asFetch(async (_input, init) => {
          signals.push(requireSignal(init));
          return failed ? new Response("unavailable", { status: 503 }) : models();
        }),
      );
      const first = yield* catalog.fetchCatalog(target);
      assert.strictEqual(first.value.status, "failed");
      assert.strictEqual(signals.length, 3);
      assert.isTrue(signals.every((signal) => signal === signals[0]));
      assert.isTrue(signals[0]!.aborted);
      failed = false;
      const next = yield* catalog.fetchCatalog(target);
      assert.strictEqual(next.value.status, "ready");
      assert.strictEqual(signals.length, 4);
      assert.notStrictEqual(signals[0], signals[3]);
    }),
  );
});
