// @effect-diagnostics nodeBuiltinImport:off - Windows 夹具使用 junction 验证真实目录别名，只写 scoped 临时目录。
import * as NodeFSP from "node:fs/promises";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { GrokSettings } from "@codework/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";

import { acquireGrokHomeAccess, resolveGrokHomePath } from "./GrokHomeAccess.ts";
import { fetchGrokCatalog } from "./Layers/GrokProvider.ts";
import { makeNativeProviderCatalog } from "./NativeProviderCatalog.ts";

const decodeSettings = Schema.decodeSync(GrokSettings);

it.layer(NodeServices.layer)("Grok home 占用生命周期", (it) => {
  it.effect("同一 home 在先前 owner 的清理回执完成后才交给下一 owner", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "codework-grok-lease-" });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const cleaning = yield* Deferred.make<void>();
      const cleaned = yield* Deferred.make<void>();
      const trace: string[] = [];
      const first = yield* Effect.gen(function* () {
        yield* acquireGrokHomeAccess(home);
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(cleaning, undefined);
            yield* Deferred.await(cleaned);
            trace.push("清理完成");
          }),
        );
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
      }).pipe(Effect.scoped, Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(cleaning);
      const second = yield* acquireGrokHomeAccess(home).pipe(
        Effect.andThen(
          Effect.sync(() => {
            trace.push("下一owner");
          }),
        ),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(cleaned, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(trace).toEqual(["清理完成", "下一owner"]);
    }),
  );

  it.effect("取消排队者不释放持有者，末持有者退出后新一轮仍可获得占用", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "codework-grok-cancel-" });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const first = yield* acquireGrokHomeAccess(home).pipe(
        Effect.andThen(Deferred.succeed(entered, undefined)),
        Effect.andThen(Deferred.await(release)),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(entered);
      let secondAcquired = false;
      const second = yield* acquireGrokHomeAccess(home).pipe(
        Effect.andThen(
          Effect.sync(() => {
            secondAcquired = true;
          }),
        ),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Fiber.interrupt(second);
      expect(secondAcquired).toBe(false);
      const next = yield* acquireGrokHomeAccess(home).pipe(
        Effect.as("获得占用"),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      expect(yield* Fiber.join(next)).toBe("获得占用");
      yield* acquireGrokHomeAccess(home).pipe(Effect.scoped);
    }),
  );

  it.effect("不同 home 并行，Windows 大小写别名在同一占用后消费", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "codework-grok-case-" });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const fakeFs = { ...fs, realPath: (file: string) => Effect.succeed(path.resolve(file)) };
      const trace: string[] = [];
      const first = yield* acquireGrokHomeAccess(home).pipe(
        Effect.andThen(Deferred.succeed(entered, undefined)),
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(
          Effect.sync(() => {
            trace.push("持有者结束");
          }),
        ),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(entered);
      const alias = yield* acquireGrokHomeAccess(home.toUpperCase()).pipe(
        Effect.andThen(
          Effect.sync(() => {
            trace.push("别名获得占用");
          }),
        ),
        Effect.scoped,
        Effect.provideService(FileSystem.FileSystem, fakeFs),
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* acquireGrokHomeAccess(path.join(home, "other")).pipe(
        Effect.andThen(
          Effect.sync(() => {
            trace.push("不同home");
          }),
        ),
        Effect.scoped,
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(alias);
      expect(trace).toEqual(["不同home", "持有者结束", "别名获得占用"]);
    }).pipe(Effect.provideService(HostProcessPlatform, "win32")),
  );

  it.effect("真实目录别名及尚未创建的子目录保持一致身份", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "codework-grok-alias-" });
      const platform = yield* HostProcessPlatform;
      const home = path.join(root, "actual");
      const alias = path.join(root, "alias");
      yield* fs.makeDirectory(home);
      yield* Effect.promise(() =>
        NodeFSP.symlink(home, alias, platform === "win32" ? "junction" : "dir"),
      );
      const resolved = yield* resolveGrokHomePath(path.join(alias, "new", "nested"));
      expect(resolved).toBe(path.join(yield* fs.realPath(home), "new", "nested"));
      yield* fs.makeDirectory(path.join(home, "new", "nested"), { recursive: true });
      expect(yield* resolveGrokHomePath(path.join(alias, "new", "nested"))).toBe(resolved);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const trace: string[] = [];
      const first = yield* acquireGrokHomeAccess(home).pipe(
        Effect.andThen(Deferred.succeed(entered, undefined)),
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(
          Effect.sync(() => {
            trace.push("实际目录结束");
          }),
        ),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(entered);
      const second = yield* acquireGrokHomeAccess(alias).pipe(
        Effect.andThen(
          Effect.sync(() => {
            trace.push("别名消费");
          }),
        ),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(trace).toEqual(["实际目录结束", "别名消费"]);
    }),
  );

  it.effect("等待同一 home 的队列计入十五秒预算，超时不执行配置准备", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "codework-grok-queue-" });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* acquireGrokHomeAccess(home).pipe(
        Effect.andThen(Deferred.succeed(entered, undefined)),
        Effect.andThen(Deferred.await(release)),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(entered);
      const native = yield* makeNativeProviderCatalog();
      const queued = yield* Deferred.make<void>();
      let writes = 0;
      let signal: AbortSignal | undefined;
      const refresh = fetchGrokCatalog({
        settings: decodeSettings({ enabled: false }),
        nativeCatalog: native,
        preparationIdentity: { home, source: "queued" },
        prepare: (sharedSignal) =>
          Effect.gen(function* () {
            signal = sharedSignal;
            yield* Deferred.succeed(queued, undefined);
            yield* acquireGrokHomeAccess(home);
            writes++;
            return {};
          }),
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("停用探针不能启动CLI")),
        ),
        Effect.provide(NodeCrypto.layer),
      );
      const pending = yield* refresh.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(queued);
      yield* TestClock.adjust("15 seconds");
      expect((yield* Fiber.join(pending)).message).toContain("15000ms");
      expect(writes).toBe(0);
      expect(signal?.aborted).toBe(true);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      expect((yield* refresh).message).not.toContain("15000ms");
      expect(writes).toBe(1);
    }),
  );
});
