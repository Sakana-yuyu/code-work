// @effect-diagnostics nodeBuiltinImport:off - 内嵌运行时解析用 node:url 取模块目录。
import { fileURLToPath } from "node:url";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/**
 * ZCode 内嵌运行时：仓库随带的 `vendor/zcode/zcode.cjs` 是从上游 ZCode 源码
 * （apps/zcode-cli/packages/cli，`pnpm cli:build`）构建的单文件 bundle，让用户
 * 无需自行安装 zcode CLI 即可使用 ZCode agent。解析顺序：
 * 显式 `binaryPath` 配置 → 内嵌 bundle → PATH 上的 `zcode`。
 *
 * 打包形态（server.asar / Electron）里 bundle 落在虚拟文件系统内，无法直接 spawn，
 * 因此在首次使用时整体释放到 `<stateDir>/bin/zcode/`；`source.sha` 记录
 * `size-mtimeMs` 标记，避免每次启动重复拷贝 30MB。
 *
 * bundle 由 node 系运行时执行：`process.execPath` 在桌面端是 Electron 可执行文件，
 * 需要 `ELECTRON_RUN_AS_NODE=1`；开发态下 execPath 本身就是 node，附加该环境变量无害。
 */

export interface ZCodeSpawnTarget {
  /** 实际 spawn 的可执行文件（zcode 二进制 / node 系运行时）。 */
  readonly command: string;
  /** 需要前置在业务参数之前的参数（如 bundle 路径）。 */
  readonly argsPrefix: ReadonlyArray<string>;
  /** 出错时展示给用户的标识。 */
  readonly displayPath: string;
  readonly source: "configured" | "bundled" | "path";
}

const BUNDLE_DIR_NAME = "zcode";
const BUNDLE_FILE_NAME = "zcode.cjs";
const BUNDLE_MARKER_NAME = "source.sha";

/** `binaryPath` 是显式用户配置（非默认命令名）时尊重配置。 */
const isExplicitBinaryPath = (binaryPath: string): boolean =>
  binaryPath.trim() !== "" &&
  binaryPath.trim() !== "zcode" &&
  binaryPath.trim() !== "zcode.exe" &&
  binaryPath.trim() !== "zcode.cmd";

/** vendored bundle 的候选目录：dev(src) 与 dist/打包(server.asar) 两种布局。 */
const bundledSourceCandidates = (): ReadonlyArray<string> => {
  const dirname = fileURLToPath(new URL(".", import.meta.url));
  return [
    // dev：`apps/server/src/provider/zcode` → `apps/server/vendor/zcode`
    `${dirname}../../../vendor/zcode`,
    // dist/打包：`apps/server/dist`（vite bundle 后模块目录即 dist）→ `apps/server/vendor/zcode`
    `${dirname}../vendor/zcode`,
    // 兜底：工作区根布局（`apps/server` 作为 cwd 或直接可得的仓库根）
    `${process.cwd()}/apps/server/vendor/zcode`,
    `${process.cwd()}/vendor/zcode`,
  ];
};

const bundleFingerprint = (stats: {
  readonly size: number;
  readonly mtime: Option.Option<Date>;
}): string => `${stats.size}-${Option.isSome(stats.mtime) ? stats.mtime.value.getTime() : 0}`;

/**
 * 释放 vendored bundle 到 `<stateDir>/bin/zcode/` 并返回入口路径；
 * 源不存在（未 vendor、远程裁剪构建）时返回 none。
 */
export const extractBundledZCode = Effect.fn("extractBundledZCode")(function* (
  stateDir: string,
): Effect.fn.Return<Option.Option<string>, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let sourceDir: string | undefined;
  for (const candidate of bundledSourceCandidates()) {
    const stats = yield* fs.stat(path.join(candidate, BUNDLE_FILE_NAME)).pipe(Effect.option);
    if (Option.isSome(stats) && stats.value.type === "File") {
      sourceDir = candidate;
      break;
    }
  }
  if (sourceDir === undefined) return Option.none();

  const sourceFile = path.join(sourceDir, BUNDLE_FILE_NAME);
  const sourceStats = yield* fs.stat(sourceFile).pipe(Effect.option);
  if (Option.isNone(sourceStats)) return Option.none();
  const fingerprint = bundleFingerprint({
    size: Number(sourceStats.value.size),
    mtime: sourceStats.value.mtime,
  });

  const targetDir = path.join(stateDir, "bin", BUNDLE_DIR_NAME);
  const targetFile = path.join(targetDir, BUNDLE_FILE_NAME);
  const markerFile = path.join(targetDir, BUNDLE_MARKER_NAME);
  const marker = yield* fs.readFileString(markerFile).pipe(Effect.option);
  const targetStats = yield* fs.stat(targetFile).pipe(Effect.option);
  const ready =
    Option.isSome(marker) &&
    marker.value.trim() === fingerprint &&
    Option.isSome(targetStats) &&
    targetStats.value.type === "File";

  if (!ready) {
    yield* fs.makeDirectory(targetDir, { recursive: true }).pipe(Effect.orElseSucceed(() => null));
    // 整个目录拷贝，保证 `provider/zcode-builtin.json` 相对 bundle 的路径形状不变。
    yield* fs
      .copy(sourceDir, targetDir, { overwrite: true })
      .pipe(Effect.orElseSucceed(() => null));
    yield* fs.writeFileString(markerFile, fingerprint).pipe(Effect.orElseSucceed(() => undefined));
  }
  return Option.some(targetFile);
});

/**
 * 解析 zcode 的 spawn 目标。`stateDir === undefined` 时（无持久化目录的场景）跳过释放、
 * 直接尝试源目录内的 bundle（dev 布局可直接 spawn）。
 */
export const resolveZCodeSpawnTarget = Effect.fn("resolveZCodeSpawnTarget")(function* (input: {
  readonly binaryPath: string;
  readonly stateDir: string;
}): Effect.fn.Return<ZCodeSpawnTarget, never, FileSystem.FileSystem | Path.Path> {
  if (isExplicitBinaryPath(input.binaryPath)) {
    return {
      command: input.binaryPath,
      argsPrefix: [],
      displayPath: input.binaryPath,
      source: "configured",
    };
  }
  const extracted = yield* extractBundledZCode(input.stateDir);
  if (Option.isSome(extracted)) {
    return {
      command: process.execPath,
      argsPrefix: [extracted.value],
      displayPath: "内置 ZCode 运行时",
      source: "bundled",
    };
  }
  return {
    command: input.binaryPath.trim() || "zcode",
    argsPrefix: [],
    displayPath: input.binaryPath,
    source: "path",
  };
});

/** bundled 目标经 node 系运行时执行；Electron 下需 RUN_AS_NODE，node 下为无害冗余。 */
export const zcodeSpawnEnv = (target: ZCodeSpawnTarget): Readonly<Record<string, string>> =>
  target.source === "bundled" ? { ELECTRON_RUN_AS_NODE: "1" } : {};
