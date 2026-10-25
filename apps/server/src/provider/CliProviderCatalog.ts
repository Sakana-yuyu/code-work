import * as NodeCrypto from "node:crypto";

import type {
  ProviderDriverKind,
  ServerProviderModel,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@codework/contracts";
import { stableStringify } from "@codework/shared/relaySigning";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { makeProviderCatalogCache, ProviderCatalogForceRefresh } from "./ProviderCatalogCache.ts";

/** 目录与实例身份、认证、版本和检查时间分离，避免缓存动态健康状态。 */
export interface CliProviderCatalogData {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly skills?: ReadonlyArray<ServerProviderSkill>;
  readonly slashCommands?: ReadonlyArray<ServerProviderSlashCommand>;
  /** 可选目录发现失败时保留成功内容，但不能将残缺目录作为完成缓存。 */
  readonly catalogMessage?: string;
}

export class CliProviderCatalogError extends Schema.TaggedError<CliProviderCatalogError>()(
  "CliProviderCatalogError",
  { cause: Schema.Defect() },
) {}

/** 实际参数只参与摘要；加载仍执行调用者本次传入的 Effect。 */
export const cliProviderCatalogIdentity = (input: {
  readonly driver: ProviderDriverKind;
  readonly operation: string;
  readonly config: unknown;
  /** 纯配置目录没有进程；原生探针必须传入实际工作目录与环境快照。 */
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
}): string => NodeCrypto.createHash("sha256").update(stableStringify(input)).digest("hex");

/** 将同一刷新信号桥接到可中断工作，资源终结仍由工作自己的 Scope 负责。 */
export const withCatalogAbortSignal = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  signal: AbortSignal,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    if (signal.aborted) return Effect.interrupt;
    const aborted = Effect.callback<never>((resume) => {
      const onAbort = () => resume(Effect.interrupt);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      return Effect.sync(() => signal.removeEventListener("abort", onAbort));
    });
    // 先登记 race 的两分支，防止同步工作回执重入 abort 时漏掉工作 fiber。
    return Effect.raceFirst(aborted, Effect.yieldNow.pipe(Effect.andThen(effect)));
  });

export interface CliProviderCatalog {
  readonly fetchCatalog: <E, R>(input: {
    readonly key: string;
    readonly load: Effect.Effect<CliProviderCatalogData, E, R>;
    readonly forceRefresh?: boolean;
    /** 完整原生刷新统一拥有资源时，目录只读写完成缓存，不建立第二个加载 Scope。 */
    readonly shareInFlight?: boolean;
  }) => Effect.Effect<CliProviderCatalogData, CliProviderCatalogError, R>;
}

/** 注册表持有缓存，重建实例只替换加载器，不复用旧实例的执行上下文。 */
export const makeCliProviderCatalog = Effect.fn("makeCliProviderCatalog")(function* () {
  const cache = yield* makeProviderCatalogCache<
    Result.Result<CliProviderCatalogData, CliProviderCatalogError>
  >({
    ttlMs: 60_000,
    capacity: 128,
    shouldCache: (result) => Result.isSuccess(result) && !result.success.catalogMessage,
  });

  const fetchCatalog: CliProviderCatalog["fetchCatalog"] = Effect.fn(
    "CliProviderCatalog.fetchCatalog",
  )(function* <E, R>(input: {
    readonly key: string;
    readonly load: Effect.Effect<CliProviderCatalogData, E, R>;
    readonly forceRefresh?: boolean;
    readonly shareInFlight?: boolean;
  }): Effect.fn.Return<CliProviderCatalogData, CliProviderCatalogError, R> {
    const context = yield* Effect.context<R>();
    const forceRefresh = input.forceRefresh ?? (yield* ProviderCatalogForceRefresh);
    const result = yield* cache.fetchCatalog({
      key: input.key,
      load: input.load.pipe(
        Effect.provide(context),
        Effect.mapError((cause) => new CliProviderCatalogError({ cause })),
        Effect.result,
      ),
      forceRefresh,
      ...(input.shareInFlight === undefined ? {} : { shareInFlight: input.shareInFlight }),
    });
    return Result.isSuccess(result.value) ? result.value.success : yield* result.value.failure;
  });

  return { fetchCatalog } satisfies CliProviderCatalog;
});
