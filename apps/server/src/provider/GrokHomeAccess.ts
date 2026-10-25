import { HostProcessPlatform } from "@codework/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";

// 只保存正在持有或等待的 home；最后一个 Scope 退出即移除，不保留实例或账号数据。
const activeHomes = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>();
const activeConfigurations = new Map<
  string,
  {
    readonly routed: boolean;
    readonly source: string | null;
    readonly gatewayOrigin: string | null;
    users: number;
  }
>();

export class GrokHomeConflict extends Schema.TaggedError<GrokHomeConflict>()("GrokHomeConflict", {
  home: Schema.String,
}) {
  override get message() {
    return "此 Grok 目录已由不兼容路由配置的实例使用，请为当前实例设置独立 GROK_HOME。";
  }
}

/** 未创建的 home 按最近存在的父目录解析，保持首次写入前后的路径身份一致。 */
export const resolveGrokHomePath = Effect.fn("resolveGrokHomePath")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let directory = path.resolve(home);
  const remaining: string[] = [];
  for (;;) {
    const resolved = yield* fs.realPath(directory).pipe(Effect.result);
    if (Result.isSuccess(resolved)) return path.join(resolved.success, ...remaining);
    const parent = path.dirname(directory);
    if (resolved.failure.reason._tag !== "NotFound" || parent === directory)
      return yield* resolved.failure;
    remaining.unshift(path.basename(directory));
    directory = parent;
  }
});

/** 从配置准备持有到 CLI 消费及清理结束；排队可取消，不能仅保护一次 rename。 */
export const acquireGrokHomeAccess = Effect.fn("acquireGrokHomeAccess")(function* (home: string) {
  const resolved = yield* resolveGrokHomePath(home);
  const platform = yield* HostProcessPlatform;
  const key = platform === "win32" ? resolved.toLowerCase() : resolved;
  yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const entry = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const entry = activeHomes.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
          entry.users++;
          activeHomes.set(key, entry);
          return entry;
        }),
        (entry) =>
          Effect.sync(() => {
            if (--entry.users === 0 && activeHomes.get(key) === entry) activeHomes.delete(key);
          }),
      );
      yield* restore(entry.semaphore.take(1));
      yield* Effect.addFinalizer(() => entry.semaphore.release(1));
    }),
  );
});

/** CLI 会热重载模型配置，兼容性必须保持到实例关闭，不能只锁住启动握手。 */
export const claimGrokHomeConfiguration = Effect.fn("claimGrokHomeConfiguration")(function* (
  home: string,
  configuration: {
    readonly routed: boolean;
    readonly source?: string | undefined;
    readonly gatewayOrigin?: string | undefined;
  },
) {
  const resolved = yield* resolveGrokHomePath(home);
  const platform = yield* HostProcessPlatform;
  const key = platform === "win32" ? resolved.toLowerCase() : resolved;
  const identity = {
    routed: configuration.routed,
    source: configuration.routed ? (configuration.source ?? null) : null,
    gatewayOrigin: configuration.routed ? (configuration.gatewayOrigin ?? null) : null,
  };
  yield* Effect.acquireRelease(
    Effect.suspend(() => {
      const existing = activeConfigurations.get(key);
      if (
        existing !== undefined &&
        (existing.routed !== identity.routed ||
          existing.source !== identity.source ||
          existing.gatewayOrigin !== identity.gatewayOrigin)
      )
        return Effect.fail(new GrokHomeConflict({ home: resolved }));
      const entry = existing ?? { ...identity, users: 0 };
      entry.users++;
      activeConfigurations.set(key, entry);
      return Effect.succeed(entry);
    }),
    (entry) =>
      Effect.sync(() => {
        if (--entry.users === 0 && activeConfigurations.get(key) === entry)
          activeConfigurations.delete(key);
      }),
  );
});
