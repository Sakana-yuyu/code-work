import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { makeProviderCatalogCache, ProviderCatalogForceRefresh } from "./ProviderCatalogCache.ts";
import type { ServerProviderDraft } from "./providerSnapshot.ts";

interface NativeCatalogInput<E, R> {
  readonly key: string;
  readonly load: (controller: AbortController) => Effect.Effect<ServerProviderDraft, E, R>;
  readonly timeoutMs: number;
  readonly onTimeout: () => ServerProviderDraft;
  readonly forceRefresh?: boolean;
}

/** 配置准备的预期错误可共享；调用方在边界恢复自己的领域错误与实例身份。 */
export class NativeProviderCatalogError extends Schema.TaggedErrorClass<NativeProviderCatalogError>()(
  "NativeProviderCatalogError",
  { cause: Schema.Defect() },
) {}

export interface NativeProviderCatalog {
  readonly fetchCatalog: <R>(
    input: NativeCatalogInput<never, R>,
  ) => Effect.Effect<ServerProviderDraft, never, Exclude<R, Scope.Scope>>;
  readonly fetchCatalogWithError: <E, R>(
    input: NativeCatalogInput<E, R>,
  ) => Effect.Effect<ServerProviderDraft, NativeProviderCatalogError, Exclude<R, Scope.Scope>>;
}

/** 认证只共享在途执行；纯目录的完成缓存由该执行在同一 Scope 内使用。 */
export const makeNativeProviderCatalog = Effect.fn("makeNativeProviderCatalog")(function* () {
  const strong = yield* makeProviderCatalogCache<
    Result.Result<ServerProviderDraft, NativeProviderCatalogError>
  >({
    ttlMs: 0,
    capacity: 0,
    shouldCache: () => false,
  });
  const ordinary = yield* makeProviderCatalogCache<
    Result.Result<ServerProviderDraft, NativeProviderCatalogError>
  >({
    ttlMs: 0,
    capacity: 0,
    shouldCache: () => false,
  });
  const fetchCatalogWithError: NativeProviderCatalog["fetchCatalogWithError"] = Effect.fn(
    "NativeProviderCatalog.fetchCatalogWithError",
  )(function* <E, R>(
    input: NativeCatalogInput<E, R>,
  ): Effect.fn.Return<ServerProviderDraft, NativeProviderCatalogError, Exclude<R, Scope.Scope>> {
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
      Effect.mapError((cause) => new NativeProviderCatalogError({ cause })),
      Effect.result,
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.sync(() => Result.succeed(onTimeout())),
      }),
      // 若原强加载在选择和登记之间结束，新建加载也必须保持强语义。
      Effect.provideService(ProviderCatalogForceRefresh, useStrong),
      Effect.provide(context),
    );
    const result = (yield* cache.fetchCatalog({ key, load })).value;
    return Result.isSuccess(result) ? result.success : yield* result.failure;
  });
  // 既有无错误加载维持原签名；只有带领域错误的准备流程使用新入口。
  const fetchCatalog: NativeProviderCatalog["fetchCatalog"] = (input) =>
    fetchCatalogWithError(input).pipe(Effect.orDie);
  return { fetchCatalog, fetchCatalogWithError } satisfies NativeProviderCatalog;
});
