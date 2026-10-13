import { HostProcessPlatform } from "@codework/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";

// 只保存正在持有或等待的 home；最后一个 Scope 退出即移除，不保留实例或账号数据。
const activeHomes = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>();

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
