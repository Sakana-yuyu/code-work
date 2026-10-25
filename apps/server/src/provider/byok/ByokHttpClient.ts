import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient } from "effect/http";

// 信号只在 Effect 上下文传递；未使用此工厂的 HTTP 客户端不会收到额外传输字段。
class CatalogSignal extends Context.Reference<AbortSignal | undefined>(
  "codework/provider/byok/CatalogSignal",
  { defaultValue: () => undefined },
) {}

export const withByokCatalogSignal =
  (signal: AbortSignal) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(CatalogSignal, signal));

/** 构造时保存实际 Fetch，兼容只在 HTTP layer 构建时注入的自定义传输。 */
export const fetchHttpClientLayer = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const fetch = yield* FetchHttpClient.Fetch;
    const client = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
    // 传输在工厂构造时确定；执行期上下文不能绕开目录信号包装。
    return HttpClient.transformResponse(client, (response) =>
      Effect.gen(function* () {
        const signal = yield* CatalogSignal;
        // Effect 只调用 Fetch；Bun 全局声明附带的静态 API 不属于此传输契约。
        const catalogFetch = ((...args: Parameters<typeof globalThis.fetch>) => {
          const [input, init] = args;
          return fetch(input, signal === undefined ? init : { ...init, signal });
        }) as typeof globalThis.fetch;
        return yield* response.pipe(Effect.provideService(FetchHttpClient.Fetch, catalogFetch));
      }),
    );
  }),
);
