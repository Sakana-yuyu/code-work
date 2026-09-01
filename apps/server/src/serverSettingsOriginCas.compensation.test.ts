import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import {
  commitServerSettingsOriginCas,
  readServerSettingsOriginSnapshot,
  ServerSettingsOriginCompensationError,
} from "./serverSettingsOriginCas.ts";

const makeAtomicReplaceFailure = (settingsPath: string) =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "rename",
    pathOrDescriptor: settingsPath,
    description: "拒绝测试中的 settings.json 原子替换。",
  });

it.effect("settings 原子写失败时执行补偿并保留磁盘原文", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "codework-settings-write-compensation-",
    });
    const settingsPath = path.join(tempDir, "settings.json");
    const originalRaw = '{"original":true}\n';
    yield* fileSystem.writeFileString(settingsPath, originalRaw);
    const initial = yield* readServerSettingsOriginSnapshot(settingsPath);
    const renameFailure = makeAtomicReplaceFailure(settingsPath);
    const failingFileSystem = FileSystem.FileSystem.of({
      ...fileSystem,
      rename: (from, to) =>
        path.resolve(String(to)) === path.resolve(settingsPath)
          ? Effect.fail(renameFailure)
          : fileSystem.rename(from, to),
    });
    let secretValue = "before";

    const error = yield* commitServerSettingsOriginCas({
      settingsPath,
      expectedToken: initial.token,
      prepare: Effect.sync(() => {
        secretValue = "after";
        return {
          contents: '{"ours":true}\n',
          value: true,
          compensate: Effect.sync(() => {
            secretValue = "before";
          }),
        };
      }),
    }).pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem), Effect.flip);

    if (error._tag !== "ServerSettingsOriginError") {
      throw new Error("原子写失败且补偿成功时应保留 ServerSettingsOriginError。", {
        cause: error,
      });
    }
    assert.equal(error.operation, "write-origin");
    assert.strictEqual(error.cause, renameFailure);
    assert.equal(secretValue, "before");
    assert.equal(yield* fileSystem.readFileString(settingsPath), originalRaw);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("settings 原子写与补偿同时失败时返回独立组合错误", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "codework-settings-write-compensation-failure-",
    });
    const settingsPath = path.join(tempDir, "settings.json");
    const originalRaw = '{"original":true}\n';
    yield* fileSystem.writeFileString(settingsPath, originalRaw);
    const initial = yield* readServerSettingsOriginSnapshot(settingsPath);
    const renameFailure = makeAtomicReplaceFailure(settingsPath);
    const compensationFailure = new Error("secret compensation failed");
    const failingFileSystem = FileSystem.FileSystem.of({
      ...fileSystem,
      rename: (from, to) =>
        path.resolve(String(to)) === path.resolve(settingsPath)
          ? Effect.fail(renameFailure)
          : fileSystem.rename(from, to),
    });

    const error = yield* commitServerSettingsOriginCas({
      settingsPath,
      expectedToken: initial.token,
      prepare: Effect.succeed({
        contents: '{"ours":true}\n',
        value: true,
        compensate: Effect.fail(compensationFailure),
      }),
    }).pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem), Effect.flip);

    assert.instanceOf(error, ServerSettingsOriginCompensationError);
    if (error.primaryFailure._tag !== "ServerSettingsOriginError") {
      throw new Error("原子写失败应保留 ServerSettingsOriginError 主因。", {
        cause: error.primaryFailure,
      });
    }
    assert.equal(error.primaryFailure.operation, "write-origin");
    assert.strictEqual(error.primaryFailure.cause, renameFailure);
    assert.strictEqual(error.compensationFailure, compensationFailure);
    assert.equal(yield* fileSystem.readFileString(settingsPath), originalRaw);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("最终 token 冲突且补偿失败时同时保留冲突与补偿原因", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "codework-settings-conflict-compensation-failure-",
    });
    const settingsPath = path.join(tempDir, "settings.json");
    const externalRaw = '{"external":true}\n';
    yield* fileSystem.writeFileString(settingsPath, "{}\n");
    const initial = yield* readServerSettingsOriginSnapshot(settingsPath);
    const compensationFailure = new Error("secret conflict compensation failed");

    const error = yield* commitServerSettingsOriginCas({
      settingsPath,
      expectedToken: initial.token,
      prepare: fileSystem.writeFileString(settingsPath, externalRaw).pipe(
        Effect.as({
          contents: '{"ours":true}\n',
          value: true,
          compensate: Effect.fail(compensationFailure),
        }),
      ),
    }).pipe(Effect.flip);

    assert.instanceOf(error, ServerSettingsOriginCompensationError);
    if (error.primaryFailure._tag !== "ServerSettingsOriginConflict") {
      throw new Error("最终 token 冲突应保留 ServerSettingsOriginConflict 主因。", {
        cause: error.primaryFailure,
      });
    }
    assert.equal(error.primaryFailure.expectedToken, initial.token);
    assert.notEqual(error.primaryFailure.actualToken, initial.token);
    assert.strictEqual(error.compensationFailure, compensationFailure);
    assert.equal(yield* fileSystem.readFileString(settingsPath), externalRaw);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
