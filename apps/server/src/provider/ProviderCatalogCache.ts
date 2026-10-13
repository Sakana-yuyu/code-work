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
  waiters = 0;
  settled = false;

  constructor(key: string, run: Effect.Effect<ProviderCatalogResult<A>>) {
    this.key = key;
    this.run = run;
  }

  [Equal.symbol](other: unknown): boolean {
    return this === other;
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
  const active = new Map<string, CatalogRequest<A>>();
  const generations = new Map<string, { latest: symbol; latestStrong: boolean; active: number }>();
  // Cache 管理加载与取消引用计数；显式清理已结束的一轮，不依赖首等待者的时钟。
  const inFlight = yield* Cache.makeWith(
    (request: CatalogRequest<A>) =>
      Effect.yieldNow.pipe(
        // 先让 Cache 登记等待者与取消处理，再允许加载同步回执重入调用方。
        Effect.andThen(request.run),
        Effect.ensuring(
          Effect.sync(() => {
            request.settled = true;
            if (active.get(request.key) === request) active.delete(request.key);
          }),
        ),
      ),
    { capacity: Infinity, timeToLive: () => Duration.infinity },
  );

  const fetchCatalog = Effect.fn("ProviderCatalogCache.fetchCatalog")(function* (input: {
    readonly key: string;
    readonly load: Effect.Effect<A>;
    readonly forceRefresh?: boolean;
    /** 整次刷新已拥有 Scope 时，只复用完成值，加载留在调用者的资源边界内。 */
    readonly shareInFlight?: boolean;
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

    const load = Effect.acquireUseRelease(
      Effect.sync(() => {
        const generation = Symbol();
        const state = generations.get(input.key) ?? {
          latest: generation,
          latestStrong: false,
          active: 0,
        };
        // 旧整次检查可能较晚才到目录阶段；它不能夺取仍在保护中的强刷新写权限。
        if (input.forceRefresh === true || !state.latestStrong) {
          state.latest = generation;
          state.latestStrong = input.forceRefresh === true;
        }
        state.active += 1;
        generations.set(input.key, state);
        return { state, generation };
      }),
      ({ state, generation }) =>
        Effect.gen(function* () {
          const previous = completed.get(input.key);
          const value = yield* input.load;
          const finishedAt = DateTime.toEpochMillis(yield* DateTime.now);
          // 普通加载晚完成不能覆盖后启动的手动刷新，失败新代也不恢复旧代写权限。
          if (state.latest === generation && options.capacity > 0 && options.shouldCache(value)) {
            completed.delete(input.key);
            completed.set(input.key, { value, expiresAt: finishedAt + options.ttlMs });
            for (const key of completed.keys()) {
              if (completed.size <= options.capacity) break;
              completed.delete(key);
            }
          }
          return { value, cached: false, ...(previous ? { previous: previous.value } : {}) };
        }),
      ({ state }) =>
        Effect.sync(() => {
          state.active -= 1;
          if (state.active === 0 && generations.get(input.key) === state)
            generations.delete(input.key);
        }),
    );
    const shared = Effect.acquireUseRelease(
      Effect.sync(() => {
        const request = active.get(input.key) ?? new CatalogRequest(input.key, load);
        active.set(input.key, request);
        request.waiters += 1;
        return request;
      }),
      (request) => Cache.get(inFlight, request),
      (request) =>
        Effect.gen(function* () {
          request.waiters -= 1;
          // 同步加载可能早于 Cache 安装条目完成；必须在等待返回后清理该对象。
          // 零等待者同时覆盖登记后、Cache.get 启动前取消的窗口。
          if (request.settled || request.waiters === 0) {
            if (active.get(request.key) === request) active.delete(request.key);
            yield* Cache.invalidate(inFlight, request);
          }
        }),
    );
    const fetch = input.shareInFlight === false ? load : shared;
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

  return {
    fetchCatalog,
    hasInFlight: (key: string) => Effect.sync(() => active.has(key)),
  };
});
