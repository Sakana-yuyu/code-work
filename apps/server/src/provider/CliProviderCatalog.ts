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
}

export class CliProviderCatalogError extends Schema.TaggedErrorClass<CliProviderCatalogError>()(
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

export interface CliProviderCatalog {
  readonly fetchCatalog: <E, R>(input: {
    readonly key: string;
    readonly load: Effect.Effect<CliProviderCatalogData, E, R>;
    readonly forceRefresh?: boolean;
  }) => Effect.Effect<CliProviderCatalogData, CliProviderCatalogError, R>;
}

/** 注册表持有缓存，重建实例只替换加载器，不复用旧实例的执行上下文。 */
export const makeCliProviderCatalog = Effect.fn("makeCliProviderCatalog")(function* () {
  const cache = yield* makeProviderCatalogCache<
    Result.Result<CliProviderCatalogData, CliProviderCatalogError>
  >({ ttlMs: 60_000, capacity: 128, shouldCache: Result.isSuccess });

  const fetchCatalog: CliProviderCatalog["fetchCatalog"] = Effect.fn(
    "CliProviderCatalog.fetchCatalog",
  )(function* <E, R>(input: {
    readonly key: string;
    readonly load: Effect.Effect<CliProviderCatalogData, E, R>;
    readonly forceRefresh?: boolean;
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
    });
    return Result.isSuccess(result.value) ? result.value.success : yield* result.value.failure;
  });

  return { fetchCatalog } satisfies CliProviderCatalog;
});
