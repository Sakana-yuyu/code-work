// @effect-diagnostics nodeBuiltinImport:off - 测试读取 vendored bundle 并隔离临时状态目录。
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { extractBundledZCode } from "./zcodeBundledRuntime.ts";

const runExtraction = (stateDir: string) =>
  Effect.runPromise(extractBundledZCode(stateDir).pipe(Effect.provide(NodeServices.layer)));

describe("extractBundledZCode", () => {
  it("逐文件释放 bundle，完整校验后才写 source.sha", async () => {
    const stateDir = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "codework-zcode-runtime-"),
    );
    try {
      const extracted = await runExtraction(stateDir);
      expect(Option.isSome(extracted)).toBe(true);
      const targetDir = NodePath.join(stateDir, "bin", "zcode");
      const files = [
        "zcode.cjs",
        "provider/zcode-builtin.json",
        "LICENSE",
        "NOTICE.md",
        "THIRD-PARTY-NOTICES.md",
        "source.sha",
      ];
      for (const file of files) {
        const stat = await NodeFSP.stat(NodePath.join(targetDir, file));
        expect(stat.isFile()).toBe(true);
      }
      const source = await NodeFSP.stat(NodePath.join(process.cwd(), "vendor/zcode/zcode.cjs"));
      const target = await NodeFSP.stat(NodePath.join(targetDir, "zcode.cjs"));
      expect(target.size).toBe(source.size);
    } finally {
      await NodeFSP.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("目标只有旧标记时会重新释放；写入失败时不伪造 source.sha", async () => {
    const stateDir = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "codework-zcode-runtime-"),
    );
    try {
      const targetDir = NodePath.join(stateDir, "bin", "zcode");
      await NodeFSP.mkdir(targetDir, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(targetDir, "source.sha"), "old-marker\n");
      const recovered = await runExtraction(stateDir);
      expect(Option.isSome(recovered)).toBe(true);
      expect((await NodeFSP.stat(NodePath.join(targetDir, "zcode.cjs"))).isFile()).toBe(true);

      const fileSystem = await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const failure = PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "writeFile",
            pathOrDescriptor: "zcode.cjs.tmp",
          });
          return FileSystem.FileSystem.of({
            ...fs,
            writeFile: (path: string, contents: Uint8Array) =>
              path.endsWith("zcode.cjs.tmp") ? Effect.fail(failure) : fs.writeFile(path, contents),
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      );
      await NodeFSP.rm(NodePath.join(targetDir, "zcode.cjs"), { force: true });
      await NodeFSP.rm(NodePath.join(targetDir, "source.sha"), { force: true });
      const failed = await Effect.runPromise(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          return yield* extractBundledZCode(stateDir).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      );
      expect(Option.isNone(failed)).toBe(true);
      await expect(NodeFSP.stat(NodePath.join(targetDir, "source.sha"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await NodeFSP.rm(stateDir, { recursive: true, force: true });
    }
  });
});
