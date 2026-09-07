import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import { HostProcessPlatform } from "@codework/shared/hostProcess";

export class WorkspaceBusyError extends Schema.TaggedErrorClass<WorkspaceBusyError>()(
  "WorkspaceBusyError",
  {
    cwd: Schema.String,
  },
) {
  override get message() {
    return `工作区正在回退检查点或执行任务，请在当前操作结束后重试：${this.cwd}`;
  }
}

export class WorkspaceOperationLock extends Context.Service<
  WorkspaceOperationLock,
  {
    readonly key: (cwd: string) => Effect.Effect<string>;
    readonly waitUntilAvailable: (cwd: string) => Effect.Effect<void>;
    readonly withLock: <A, E, R>(
      cwd: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | WorkspaceBusyError, R>;
    readonly withRevertLock: <A, E, R>(
      cwd: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | WorkspaceBusyError, R>;
  }
>()("codework/orchestration/WorkspaceOperationLock") {}

export const layer = Layer.effect(
  WorkspaceOperationLock,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcessPlatform;
    const locks = new Map<
      string,
      { users: number; reverting: boolean; readonly released: Deferred.Deferred<void> }
    >();
    const key = Effect.fn("WorkspaceOperationLock.key")(function* (cwd: string) {
      const resolved = yield* fs.realPath(cwd).pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
      let directory = resolved;
      // 同一 worktree 的子目录共用 Git index，必须按最近的 .git 入口统一保护。
      while (
        !(yield* fs.exists(path.join(directory, ".git")).pipe(Effect.orElseSucceed(() => false)))
      ) {
        const parent = path.dirname(directory);
        if (parent === directory) {
          directory = resolved;
          break;
        }
        directory = parent;
      }
      return platform === "win32" ? directory.toLowerCase() : directory;
    });
    const withOperation = <A, E, R>(
      cwd: string,
      reverting: boolean,
      effect: Effect.Effect<A, E, R>,
    ) =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          const resolved = yield* key(cwd);
          const entry = locks.get(resolved) ?? {
            users: 0,
            reverting: false,
            released: Deferred.makeUnsafe<void>(),
          };
          if (entry.reverting || (reverting && entry.users > 0))
            return yield* new WorkspaceBusyError({ cwd });
          entry.users++;
          entry.reverting = reverting;
          locks.set(resolved, entry);
          // 普通发送共享占用，只有回退排他；冲突立即拒绝，不能阻塞 interrupt 的命令队列。
          return { resolved, entry };
        }),
        () => effect,
        ({ resolved, entry }) =>
          Effect.gen(function* () {
            if (--entry.users === 0) {
              locks.delete(resolved);
              yield* Deferred.succeed(entry.released, undefined);
            }
          }),
      );
    return WorkspaceOperationLock.of({
      key,
      waitUntilAvailable: Effect.fn("WorkspaceOperationLock.waitUntilAvailable")(function* (
        cwd: string,
      ) {
        const entry = locks.get(yield* key(cwd));
        if (entry?.reverting) yield* Deferred.await(entry.released);
      }),
      withLock: (cwd, effect) => withOperation(cwd, false, effect),
      withRevertLock: (cwd, effect) => withOperation(cwd, true, effect),
    });
  }),
);
