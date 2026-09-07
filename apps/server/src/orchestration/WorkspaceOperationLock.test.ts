import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as WorkspaceOperationLock from "./WorkspaceOperationLock.ts";

it.layer(WorkspaceOperationLock.layer.pipe(Layer.provideMerge(NodeServices.layer)))(
  "工作区操作占用",
  (it) => {
    it.effect("普通操作可共享，回退冲突立即拒绝，结束后可再次使用", () =>
      Effect.gen(function* () {
        const lock = yield* WorkspaceOperationLock.WorkspaceOperationLock;
        const cwd = process.cwd();
        yield* lock.withLock(
          cwd,
          Effect.gen(function* () {
            expect(yield* lock.withLock(cwd, Effect.succeed("steer"))).toBe("steer");
            expect((yield* lock.withRevertLock(cwd, Effect.void).pipe(Effect.result))._tag).toBe(
              "Failure",
            );
          }),
        );
        yield* lock.withRevertLock(
          cwd,
          Effect.gen(function* () {
            expect((yield* lock.withLock(cwd, Effect.void).pipe(Effect.result))._tag).toBe(
              "Failure",
            );
          }),
        );
        expect(yield* lock.withLock(cwd, Effect.succeed("released"))).toBe("released");
      }),
    );

    it.effect("被中断的普通操作释放占用", () =>
      Effect.gen(function* () {
        const lock = yield* WorkspaceOperationLock.WorkspaceOperationLock;
        const entered = yield* Deferred.make<void>();
        const fiber = yield* lock
          .withLock(
            process.cwd(),
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        expect(yield* lock.withRevertLock(process.cwd(), Effect.succeed("released"))).toBe(
          "released",
        );
      }),
    );
    it.effect("同一 Git worktree 的子目录共享保护边界，独立 worktree 可并行", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const lock = yield* WorkspaceOperationLock.WorkspaceOperationLock;
        const base = yield* fs.makeTempDirectoryScoped();
        const first = path.join(base, "repo", "first");
        const second = path.join(base, "repo", "second");
        const worktree = path.join(base, "worktree");
        for (const directory of [first, second, worktree])
          yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(path.join(base, "repo", ".git"), "gitdir: common");
        yield* fs.writeFileString(path.join(worktree, ".git"), "gitdir: common/worktrees/other");
        yield* lock.withLock(
          first,
          Effect.gen(function* () {
            expect((yield* lock.withRevertLock(second, Effect.void).pipe(Effect.result))._tag).toBe(
              "Failure",
            );
            expect(yield* lock.withRevertLock(worktree, Effect.succeed("independent"))).toBe(
              "independent",
            );
          }),
        );
      }),
    );
  },
);
