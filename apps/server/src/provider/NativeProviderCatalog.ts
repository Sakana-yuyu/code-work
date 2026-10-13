import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { makeProviderCatalogCache, ProviderCatalogForceRefresh } from "./ProviderCatalogCache.ts";
import type { ServerProviderDraft } from "./providerSnapshot.ts";

export interface NativeProviderCatalog {
  readonly fetchCatalog: <R>(input: {
    readonly key: string;
    readonly load: (controller: AbortController) => Effect.Effect<ServerProviderDraft, never, R>;
    readonly timeoutMs: number;
    readonly onTimeout: () => ServerProviderDraft;
    readonly forceRefresh?: boolean;
  }) => Effect.Effect<ServerProviderDraft, never, Exclude<R, Scope.Scope>>;
}

/** 认证只共享在途执行；纯目录的完成缓存由该执行在同一 Scope 内使用。 */
export const makeNativeProviderCatalog = Effect.fn("makeNativeProviderCatalog")(function* () {
  const strong = yield* makeProviderCatalogCache<ServerProviderDraft>({
    ttlMs: 0,
    capacity: 0,
    shouldCache: () => false,
  });
  const ordinary = yield* makeProviderCatalogCache<ServerProviderDraft>({
    ttlMs: 0,
    capacity: 0,
    shouldCache: () => false,
  });
  const fetchCatalog: NativeProviderCatalog["fetchCatalog"] = Effect.fn(
    "NativeProviderCatalog.fetchCatalog",
  )(function* <R>(input: {
    readonly key: string;
    readonly load: (controller: AbortController) => Effect.Effect<ServerProviderDraft, never, R>;
    readonly timeoutMs: number;
    readonly onTimeout: () => ServerProviderDraft;
    readonly forceRefresh?: boolean;
  }): Effect.fn.Return<ServerProviderDraft, never, Exclude<R, Scope.Scope>> {
    const { key, load: run, timeoutMs, onTimeout, forceRefresh: requestedForce } = input;
    const context = yield* Effect.context<Exclude<R, Scope.Scope>>();
    const forceRefresh = requestedForce ?? (yield* ProviderCatalogForceRefresh);
    const useStrong = forceRefresh || (yield* strong.hasInFlight(key));
    const cache = useStrong ? strong : ordinary;
    const load = Effect.gen(function* () {
      const controller = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller) => Effect.sync(() => controller.abort()),
      );
      return yield* run(controller);
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.sync(onTimeout),
      }),
      // 若原强加载在选择和登记之间结束，新建加载也必须保持强语义。
      Effect.provideService(ProviderCatalogForceRefresh, useStrong),
      Effect.provide(context),
    );
    return (yield* cache.fetchCatalog({ key, load })).value;
  });
  return { fetchCatalog } satisfies NativeProviderCatalog;
});
