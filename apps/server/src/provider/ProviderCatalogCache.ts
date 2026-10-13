import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Hash from "effect/Hash";

/** 手动刷新意图随检查上下文传递，具体调用仍可显式覆盖。 */
export class ProviderCatalogForceRefresh extends Context.Reference<boolean>(
  "codework/ProviderCatalogForceRefresh",
  { defaultValue: () => false },
) {}

export interface ProviderCatalogResult<A> {
  readonly value: A;
  readonly cached: boolean;
  readonly previous?: A;
}

class CatalogRequest<A> implements Equal.Equal {
  readonly key: string;
  readonly run: Effect.Effect<ProviderCatalogResult<A>>;

  constructor(key: string, run: Effect.Effect<ProviderCatalogResult<A>>) {
    this.key = key;
    this.run = run;
  }

  [Equal.symbol](other: unknown): boolean {
    return other instanceof CatalogRequest && this.key === other.key;
  }

  [Hash.symbol](): number {
    return Hash.string(this.key);
  }
}

/**
 * 成功值独立保存，过期后仍可作为 previous 返回，直到容量逐出。
 * 加载只使用本次调用提供的 Effect；最后一个等待者取消时中断加载。
 */
export const makeProviderCatalogCache = Effect.fn("makeProviderCatalogCache")(function* <
  A,
>(options: {
  readonly ttlMs: number;
  readonly capacity: number;
  readonly shouldCache: (value: A) => boolean;
}) {
  const completed = new Map<string, { readonly value: A; readonly expiresAt: number }>();
  // 在途检查不能因容量逐出而重复启动；完成记录在等待结束时清理。
  const inFlight = yield* Cache.makeWith((request: CatalogRequest<A>) => request.run, {
    capacity: Infinity,
    timeToLive: () => Duration.zero,
  });
  const pruneCompletedLoads = Cache.keys(inFlight).pipe(
    // keys 惰性删除已到期条目；同步遍历保留 expiresAt 尚未设置的新一轮加载。
    Effect.map((keys) => Array.from(keys)),
    Effect.asVoid,
  );

  const fetchCatalog = Effect.fn("ProviderCatalogCache.fetchCatalog")(function* (input: {
    readonly key: string;
    readonly load: Effect.Effect<A>;
    readonly forceRefresh?: boolean;
    readonly timeout?: {
      readonly milliseconds: number;
      readonly onTimeout: () => A;
    };
  }): Effect.fn.Return<ProviderCatalogResult<A>> {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const cached = completed.get(input.key);
    if (cached && input.forceRefresh !== true && now < cached.expiresAt) {
      completed.delete(input.key);
      completed.set(input.key, cached);
      return { value: cached.value, cached: true };
    }

    const request = new CatalogRequest(
      input.key,
      Effect.gen(function* () {
        const previous = completed.get(input.key);
        const value = yield* input.load;
        const finishedAt = DateTime.toEpochMillis(yield* DateTime.now);
        if (options.capacity > 0 && options.shouldCache(value)) {
          completed.delete(input.key);
          completed.set(input.key, { value, expiresAt: finishedAt + options.ttlMs });
          for (const key of completed.keys()) {
            if (completed.size <= options.capacity) break;
            completed.delete(key);
          }
        }
        return { value, cached: false, ...(previous ? { previous: previous.value } : {}) };
      }),
    );
    const fetch = Cache.get(inFlight, request).pipe(Effect.ensuring(pruneCompletedLoads));
    const timeout = input.timeout;
    if (!timeout) return yield* fetch;

    const timeoutResult = Effect.sync((): ProviderCatalogResult<A> => {
      const previous = completed.get(input.key);
      return {
        value: timeout.onTimeout(),
        cached: false,
        ...(previous ? { previous: previous.value } : {}),
      };
    });
    if (timeout.milliseconds <= 0) return yield* timeoutResult;
    // 超时只取消本次等待；Cache 的最后一个等待者退出时才中断共享加载。
    return yield* fetch.pipe(
      Effect.timeoutOrElse({ duration: timeout.milliseconds, orElse: () => timeoutResult }),
    );
  });

  return { fetchCatalog };
});
