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

import { extractBundledZCode } from "./zcodeBundledRuntime.ts";

describe("extractBundledZCode", () => {
  it.effect("逐文件释放 bundle，完整校验后才写 source.sha", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-zcode-runtime-")),
      );
      try {
        const extracted = yield* extractBundledZCode(stateDir);
        expect(Option.isSome(extracted)).toBe(true);
        const targetDir = path.join(stateDir, "bin", "zcode");
        const files = [
          "zcode.cjs",
          "provider/zcode-builtin.json",
          "LICENSE",
          "NOTICE.md",
          "THIRD-PARTY-NOTICES.md",
          "source.sha",
        ];
        for (const file of files) {
          expect((yield* fs.stat(path.join(targetDir, file))).type).toBe("File");
        }
        const source = yield* fs
          .stat(path.join(process.cwd(), "vendor/zcode/zcode.cjs"))
          .pipe(
            Effect.catch(() =>
              fs.stat(path.join(process.cwd(), "apps/server/vendor/zcode/zcode.cjs")),
            ),
          );
        const target = yield* fs.stat(path.join(targetDir, "zcode.cjs"));
        expect(target.size).toBe(source.size);
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(stateDir, { recursive: true, force: true }));
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("目标只有旧标记时会重新释放；写入失败时不伪造 source.sha", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-zcode-runtime-")),
      );
      try {
        const targetDir = path.join(stateDir, "bin", "zcode");
        yield* fs.makeDirectory(targetDir, { recursive: true });
        yield* fs.writeFileString(path.join(targetDir, "source.sha"), "old-marker\n");
        const recovered = yield* extractBundledZCode(stateDir);
        expect(Option.isSome(recovered)).toBe(true);
        expect((yield* fs.stat(path.join(targetDir, "zcode.cjs"))).type).toBe("File");

        yield* fs.remove(targetDir, { recursive: true, force: true });
        yield* fs.writeFileString(targetDir, "阻止目录创建");
        const failed = yield* extractBundledZCode(stateDir);
        expect(Option.isNone(failed)).toBe(true);
        expect(
          Option.isNone(yield* fs.stat(path.join(targetDir, "source.sha")).pipe(Effect.option)),
        ).toBe(true);
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(stateDir, { recursive: true, force: true }));
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
