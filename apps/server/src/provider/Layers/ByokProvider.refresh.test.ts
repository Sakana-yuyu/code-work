// @effect-diagnostics nodeBuiltinImport:off - 本机 HTTP 夹具需要观察服务端正文连接的 close 收据。
// @effect-diagnostics globalFetch:off - 专用 HttpClient 工厂注入真实 Fetch，以验证传输层取消而非模拟结果。
import { assert, describe, it } from "@effect/vitest";
import { ByokSettings } from "@codework/contracts";
import * as NodeHttp from "node:http";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";

import { ProviderCatalogForceRefresh } from "../ProviderCatalogCache.ts";
import { ByokCatalog, byokCatalogTargetFromAdapter, make } from "../byok/ByokCatalog.ts";
import { fetchHttpClientLayer } from "../byok/ByokHttpClient.ts";
import { checkByokProviderStatus } from "./ByokProvider.ts";
import { fetchByokProviderCatalog } from "../ByokProviderCatalog.ts";

const decodeSettings = Schema.decodeSync(ByokSettings);
const adapter = (id: string) => {
  const decoded = decodeSettings({
    enabled: true,
    adapters: [
      {
        id,
        displayName: `服务 ${id}`,
        protocol: "openai",
        baseURL: `https://${id}.test/v1`,
        apiKey: `${id}-key`,
        modelId: "configured",
        modelCatalogURLs: [`https://${id}.test/models`],
        appendModelCatalogCandidates: false,
        customHeaders: '{"x-owner":"original"}',
      },
    ],
  }).adapters[0]!;
  return { ...decoded, modelCatalogURLs: [...decoded.modelCatalogURLs!] };
};
const settings = (...ids: string[]) => ({
  ...decodeSettings({ enabled: true, adapters: [] }),
  adapters: ids.map(adapter),
});
const models = (id = "remote") => new Response(JSON.stringify({ data: [{ id }] }));
const makeCatalog = (
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
) =>
  make.pipe(
    Effect.provide(
      fetchHttpClientLayer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch)),
      ),
    ),
  );
const signalOf = (init?: RequestInit) => {
  assert.instanceOf(init?.signal, AbortSignal);
  return init!.signal!;
};

const localServer = (handler: NodeHttp.RequestListener) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<NodeHttp.Server>((resolve, reject) => {
          const server = NodeHttp.createServer(handler);
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve(server);
          });
        }),
    ),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          }),
      ),
  );

describe("BYOK 多目录刷新资源边界", () => {
  for (const includeSkills of [false, true]) {
    for (const keepOtherClient of [false, true]) {
      it.effect(
        `${includeSkills ? "模型与技能完整刷新" : "模型刷新"}本机 HTTP 挂起正文在实例预算结束后${keepOtherClient ? "保留另一等待者" : "关闭连接"}`,
        () =>
          Effect.gen(function* () {
            const firstEntered = Promise.withResolvers<NodeHttp.ServerResponse>();
            const sharedEntered = Promise.withResolvers<NodeHttp.ServerResponse>();
            const sharedClosed = Promise.withResolvers<void>();
            const urls: string[] = [];
            let closed = false;
            const server = yield* localServer((request, response) => {
              urls.push(request.url!);
              if (request.url === "/a") {
                firstEntered.resolve(response);
              } else {
                response.once("close", () => {
                  closed = true;
                  sharedClosed.resolve();
                });
                response.writeHead(200, { "content-type": "application/json" });
                response.write('{"data":[');
                sharedEntered.resolve(response);
              }
            });
            const address = server.address();
            assert.isNotNull(address);
            assert.notTypeOf(address, "string");
            if (address === null || typeof address === "string") return;
            const origin = `http://127.0.0.1:${address.port}`;
            const config = {
              ...settings("a", "b", "c"),
              adapters: ["a", "b", "c"].map((id) => ({
                ...adapter(id),
                baseURL: `${origin}/${id}/v1`,
                modelCatalogURLs: [`${origin}/${id}`],
              })),
            };
            const signals: AbortSignal[] = [];
            const catalog = yield* makeCatalog((input, init) => {
              signals.push(signalOf(init));
              return globalThis.fetch(input, init);
            });
            const check = includeSkills
              ? fetchByokProviderCatalog({ settings: config, cwd: "/fixture/project" })
              : checkByokProviderStatus(config);
            const pending = yield* check.pipe(
              Effect.provideService(ByokCatalog, catalog),
              Effect.provideService(
                FileSystem.FileSystem,
                FileSystem.makeNoop({ readDirectory: () => Effect.succeed([]) }),
              ),
              Effect.provide(Path.layer),
              Effect.forkChild({ startImmediately: true }),
            );
            const firstResponse = yield* Effect.promise(() => firstEntered.promise);
            yield* TestClock.adjust("8 seconds");
            firstResponse.end('{"data":[{"id":"finished"}]}');
            const sharedResponse = yield* Effect.promise(() => sharedEntered.promise);
            const other = keepOtherClient
              ? yield* catalog
                  .fetchCatalog(byokCatalogTargetFromAdapter(config.adapters[1]!))
                  .pipe(Effect.forkChild({ startImmediately: true }))
              : undefined;
            yield* TestClock.adjust("7 seconds");
            const result = yield* Fiber.join(pending);
            assert.deepStrictEqual(urls, ["/a", "/b"]);
            assert.deepStrictEqual(
              result.models.map((model) => model.slug),
              ["a", "b", "c", "a/finished"],
            );
            if (other !== undefined) {
              assert.isFalse(signals[1]!.aborted);
              assert.isFalse(closed);
              sharedResponse.end('{"id":"network-shared"}]}');
              assert.strictEqual((yield* Fiber.join(other)).value.models[0]?.id, "network-shared");
            }
            yield* Effect.promise(() => sharedClosed.promise);
            assert.isTrue(signals[1]!.aborted);
            assert.isTrue(closed);
          }).pipe(Effect.scoped),
      );
    }
  }

  for (const phase of ["request", "body"] as const) {
    it.effect(`实例总预算结束时关闭最后等待者的 ${phase}，不启动冷目录`, () =>
      Effect.gen(function* () {
        const firstEntered = Promise.withResolvers<void>();
        const firstResponse = Promise.withResolvers<Response>();
        const secondEntered = Promise.withResolvers<void>();
        const closed = Promise.withResolvers<void>();
        const signals: AbortSignal[] = [];
        const urls: string[] = [];
        const catalog = yield* makeCatalog(async (input, init) => {
          urls.push(String(input));
          const signal = signalOf(init);
          signals.push(signal);
          if (urls.length === 1) {
            firstEntered.resolve();
            return firstResponse.promise;
          }
          secondEntered.resolve();
          if (phase === "body")
            return new Response(
              new ReadableStream({
                cancel() {
                  closed.resolve();
                },
              }),
            );
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                closed.resolve();
                reject(new Error("测试请求已取消"));
              },
              { once: true },
            );
          });
        });
        const pending = yield* checkByokProviderStatus(settings("a", "b", "c")).pipe(
          Effect.provideService(ByokCatalog, catalog),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() => firstEntered.promise);
        yield* TestClock.adjust("8 seconds");
        firstResponse.resolve(models("finished"));
        yield* Effect.promise(() => secondEntered.promise);
        assert.notStrictEqual(signals[0], signals[1]);
        assert.isTrue(signals[0]!.aborted);
        assert.isFalse(signals[1]!.aborted);
        yield* TestClock.adjust("7 seconds");
        const result = yield* Fiber.join(pending);
        yield* Effect.promise(() => closed.promise);
        assert.deepStrictEqual(urls, ["https://a.test/models", "https://b.test/models"]);
        assert.isTrue(signals[1]!.aborted);
        assert.deepStrictEqual(
          result.models.map((model) => model.slug),
          ["a", "b", "c", "a/finished"],
        );
        assert.strictEqual(result.checkedAt, "1970-01-01T00:00:15.000Z");
      }),
    );
  }

  it.effect("实例预算耗尽仅退出自身等待，共享目录继续供另一客户端使用", () =>
    Effect.gen(function* () {
      const firstEntered = Promise.withResolvers<void>();
      const firstResponse = Promise.withResolvers<Response>();
      const sharedEntered = Promise.withResolvers<void>();
      const sharedResponse = Promise.withResolvers<Response>();
      const signals: AbortSignal[] = [];
      const catalog = yield* makeCatalog(async (input, init) => {
        signals.push(signalOf(init));
        if (String(input).includes("a.test")) {
          firstEntered.resolve();
          return firstResponse.promise;
        }
        sharedEntered.resolve();
        return sharedResponse.promise;
      });
      const pending = yield* checkByokProviderStatus(settings("a", "b", "c")).pipe(
        Effect.provideService(ByokCatalog, catalog),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.promise(() => firstEntered.promise);
      yield* TestClock.adjust("8 seconds");
      firstResponse.resolve(models("first"));
      yield* Effect.promise(() => sharedEntered.promise);
      const otherClient = yield* catalog
        .fetchCatalog(byokCatalogTargetFromAdapter(adapter("b")))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("7 seconds");
      const result = yield* Fiber.join(pending);
      assert.deepStrictEqual(
        result.models.map((model) => model.slug),
        ["a", "b", "c", "a/first"],
      );
      assert.strictEqual(signals.length, 2);
      assert.isFalse(signals[1]!.aborted);
      sharedResponse.resolve(models("shared"));
      const shared = yield* Fiber.join(otherClient);
      assert.strictEqual(shared.value.models[0]?.id, "shared");
      assert.isTrue(signals[1]!.aborted);
      assert.isTrue(
        (yield* catalog.fetchCatalog(byokCatalogTargetFromAdapter(adapter("b")))).cached,
      );
      assert.strictEqual(signals.length, 2);
    }),
  );

  it.effect("部分重叠实例复用目录；取消一实例不取消另一实例及其后续目录", () =>
    Effect.gen(function* () {
      const entered = Promise.withResolvers<void>();
      const response = Promise.withResolvers<Response>();
      const urls: string[] = [];
      const signals: AbortSignal[] = [];
      const catalog = yield* makeCatalog(async (input, init) => {
        const url = String(input);
        urls.push(url);
        signals.push(signalOf(init));
        if (url.includes("b.test")) {
          entered.resolve();
          return response.promise;
        }
        return models();
      });
      const check = (ids: string[]) =>
        checkByokProviderStatus(settings(...ids)).pipe(
          Effect.provideService(ByokCatalog, catalog),
          Effect.forkChild({ startImmediately: true }),
        );
      const first = yield* check(["a", "b"]);
      yield* Effect.promise(() => entered.promise);
      const second = yield* check(["b", "c"]);
      yield* Fiber.interrupt(first);
      assert.isFalse(signals[1]!.aborted);
      response.resolve(models("overlap"));
      const result = yield* Fiber.join(second);
      assert.deepStrictEqual(urls, [
        "https://a.test/models",
        "https://b.test/models",
        "https://c.test/models",
      ]);
      assert.deepStrictEqual(
        result.models.map((model) => model.slug),
        ["b", "c", "b/overlap", "c/remote"],
      );
      assert.isTrue(signals.every((signal) => signal.aborted));
      assert.notStrictEqual(signals[1], signals[2]);
    }),
  );

  it.effect("两个实例最后等待者退出后中断共同目录，重试创建新信号", () =>
    Effect.gen(function* () {
      const entered = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      const signals: AbortSignal[] = [];
      const catalog = yield* makeCatalog(async (_input, init) => {
        const signal = signalOf(init);
        signals.push(signal);
        if (signals.length > 1) return models();
        entered.resolve();
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              closed.resolve();
              reject(new Error("最后等待者已退出"));
            },
            { once: true },
          );
        });
      });
      const check = checkByokProviderStatus(settings("b")).pipe(
        Effect.provideService(ByokCatalog, catalog),
      );
      const first = yield* check.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => entered.promise);
      const second = yield* check.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.interrupt(first);
      assert.isFalse(signals[0]!.aborted);
      yield* Fiber.interrupt(second);
      yield* Effect.promise(() => closed.promise);
      assert.isTrue(signals[0]!.aborted);
      assert.strictEqual((yield* check).models[1]?.slug, "b/remote");
      assert.strictEqual(signals.length, 2);
      assert.notStrictEqual(signals[0], signals[1]);
    }),
  );

  it.effect("跨目标等待期间冻结配置、候选数组与模型路由，后续刷新读取编辑结果", () =>
    Effect.gen(function* () {
      const entered = Promise.withResolvers<void>();
      const response = Promise.withResolvers<Response>();
      const supplied = settings("a", "b");
      const observed: Array<{ url: string; authorization: string | null; owner: string | null }> =
        [];
      const catalog = yield* makeCatalog(async (input, init) => {
        const headers = new Headers(init?.headers);
        observed.push({
          url: String(input),
          authorization: headers.get("authorization"),
          owner: headers.get("x-owner"),
        });
        if (observed.length === 1) {
          entered.resolve();
          return response.promise;
        }
        return models();
      });
      const check = checkByokProviderStatus(supplied).pipe(
        Effect.provideService(ByokCatalog, catalog),
      );
      const pending = yield* check.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => entered.promise);
      Object.assign(supplied.adapters[1]!, {
        id: "edited",
        displayName: "已编辑",
        apiKey: "new-key",
        customHeaders: '{"x-owner":"edited"}',
      });
      supplied.adapters[1]!.modelCatalogURLs![0] = "https://b.test/edited";
      supplied.adapters.push(adapter("c"));
      yield* TestClock.adjust("4 seconds");
      response.resolve(models());
      const result = yield* Fiber.join(pending);
      assert.deepStrictEqual(observed[1], {
        url: "https://b.test/models",
        authorization: "Bearer b-key",
        owner: "original",
      });
      assert.deepStrictEqual(
        result.models.map((model) => model.slug),
        ["a", "b", "a/remote", "b/remote"],
      );
      assert.strictEqual(result.models[1]?.name, "服务 b");
      assert.strictEqual(result.checkedAt, "1970-01-01T00:00:04.000Z");
      const next = yield* check.pipe(Effect.provideService(ProviderCatalogForceRefresh, true));
      assert.deepStrictEqual(observed[3], {
        url: "https://b.test/edited",
        authorization: "Bearer new-key",
        owner: "edited",
      });
      assert.deepStrictEqual(
        next.models.map((model) => model.slug),
        ["a", "edited", "c", "a/remote", "edited/remote", "c/remote"],
      );
    }),
  );

  it.effect("键登记到加载启动之间冻结目标与选项，不能将编辑后的凭据写入旧键", () =>
    Effect.gen(function* () {
      const supplied = {
        ...byokCatalogTargetFromAdapter(adapter("a")),
        modelCatalogURLs: ["https://a.test/models"],
      };
      const original = { ...supplied, modelCatalogURLs: [...supplied.modelCatalogURLs] };
      const options = { timeoutMs: 15_000 };
      const observed: Array<{ url: string; key: string | null }> = [];
      const catalog = yield* makeCatalog(async (input, init) => {
        observed.push({ url: String(input), key: new Headers(init?.headers).get("authorization") });
        return models();
      });
      // Cache 在加载前主动让出一次，覆盖设置修改发生在键登记与执行之间的窗口。
      const pending = yield* catalog
        .fetchCatalog(supplied, options)
        .pipe(Effect.forkChild({ startImmediately: true }));
      supplied.apiKey = "edited-key";
      supplied.modelCatalogURLs[0] = "https://a.test/edited";
      options.timeoutMs = 0;
      assert.strictEqual((yield* Fiber.join(pending)).value.status, "ready");
      assert.deepStrictEqual(observed, [{ url: "https://a.test/models", key: "Bearer a-key" }]);
      assert.isTrue((yield* catalog.fetchCatalog(original)).cached);
      yield* catalog.fetchCatalog(supplied);
      assert.deepStrictEqual(observed[1], {
        url: "https://a.test/edited",
        key: "Bearer edited-key",
      });
    }),
  );
});
