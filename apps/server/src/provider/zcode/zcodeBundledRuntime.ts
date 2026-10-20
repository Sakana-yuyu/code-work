// @effect-diagnostics nodeBuiltinImport:off - 内嵌运行时解析用 node:url 取模块目录。
import * as NodeURL from "node:url";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

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
/** `scripts/vendor-zcode.mjs` 在 vendor 目录写下的上游版本清单。 */
export const BUNDLE_MANIFEST_NAME = "VERSION.json";
/** Electron asar 对单文件 readFile/writeFile 支持稳定；不要递归复制虚拟目录。 */
const BUNDLE_FILES = [
  BUNDLE_FILE_NAME,
  "provider/zcode-builtin.json",
  "LICENSE",
  "NOTICE.md",
  "THIRD-PARTY-NOTICES.md",
  BUNDLE_MANIFEST_NAME,
] as const;

/** `binaryPath` 是显式用户配置（非默认命令名）时尊重配置。 */
const isExplicitBinaryPath = (binaryPath: string): boolean =>
  binaryPath.trim() !== "" &&
  binaryPath.trim() !== "zcode" &&
  binaryPath.trim() !== "zcode.exe" &&
  binaryPath.trim() !== "zcode.cmd";

/** vendored bundle 的候选目录：dev(src) 与 dist/打包(server.asar) 两种布局。 */
const bundledSourceCandidates = (): ReadonlyArray<string> => {
  const dirname = NodeURL.fileURLToPath(new URL(".", import.meta.url));
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
  return yield* Effect.gen(function* () {
    let sourceDir: string | undefined;
    for (const candidate of bundledSourceCandidates()) {
      const stats = yield* fs.stat(path.join(candidate, BUNDLE_FILE_NAME)).pipe(Effect.option);
      if (Option.isSome(stats) && stats.value.type === "File") {
        sourceDir = candidate;
        break;
      }
    }
    if (sourceDir === undefined) return Option.none<string>();

    const sourceFile = path.join(sourceDir, BUNDLE_FILE_NAME);
    const sourceStats = yield* fs.stat(sourceFile).pipe(Effect.option);
    if (Option.isNone(sourceStats) || sourceStats.value.type !== "File") {
      return Option.none<string>();
    }
    const fingerprint = bundleFingerprint({
      size: Number(sourceStats.value.size),
      mtime: sourceStats.value.mtime,
    });

    const targetDir = path.join(stateDir, "bin", BUNDLE_DIR_NAME);
    const targetFile = path.join(targetDir, BUNDLE_FILE_NAME);
    const markerFile = path.join(targetDir, BUNDLE_MARKER_NAME);
    const marker = yield* fs.readFileString(markerFile).pipe(Effect.option);
    const targetFiles = yield* Effect.forEach(BUNDLE_FILES, (relativePath) =>
      fs.stat(path.join(targetDir, relativePath)).pipe(Effect.option),
    );
    const ready =
      Option.isSome(marker) &&
      marker.value.trim() === fingerprint &&
      targetFiles.every(
        (stats, index) =>
          Option.isSome(stats) &&
          stats.value.type === "File" &&
          (index !== 0 || Number(stats.value.size) === Number(sourceStats.value.size)),
      );

    if (!ready) {
      yield* fs.makeDirectory(targetDir, { recursive: true });
      for (const relativePath of BUNDLE_FILES) {
        const sourcePath = path.join(sourceDir, relativePath);
        const targetPath = path.join(targetDir, relativePath);
        const targetParent = path.dirname(targetPath);
        yield* fs.makeDirectory(targetParent, { recursive: true });
        const contents = yield* fs.readFile(sourcePath);
        const temporaryPath = `${targetPath}.tmp`;
        yield* fs.writeFile(temporaryPath, contents);
        yield* fs.rename(temporaryPath, targetPath);
      }
      const writtenStats = yield* fs.stat(targetFile);
      if (
        writtenStats.type !== "File" ||
        Number(writtenStats.size) !== Number(sourceStats.value.size)
      ) {
        return Option.none<string>();
      }
      const markerTemp = `${markerFile}.tmp`;
      yield* fs.writeFileString(markerTemp, fingerprint);
      yield* fs.rename(markerTemp, markerFile);
    }
    return Option.some(targetFile);
  }).pipe(Effect.orElseSucceed(() => Option.none<string>()));
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

/** 随包清单里记录的上游版本；只读 vendored 目录（不依赖释放结果）。 */
export interface ZCodeBundleVersion {
  readonly productVersion: string;
  readonly cliVersion: string;
  readonly builtinConfigRevision?: number;
  /** 上游来源标识（分支/提交或 tarball）。历史清单里的 `commit` 也归一到这个字段。 */
  readonly sourceRef?: string;
}

const decodeBundleManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      productVersion: Schema.optional(Schema.String),
      cliVersion: Schema.optional(Schema.String),
      builtinConfigRevision: Schema.optional(Schema.Number),
      sourceRef: Schema.optional(Schema.String),
      // 早期清单只记裸 commit；仍可读，但不再写。
      commit: Schema.optional(Schema.String),
    }),
  ),
);

/**
 * 读 vendored 运行时目录里的 `VERSION.json`。内嵌运行时跳过 `--version` 探针，
 * 卡片要显示"内置的是哪一版"就得靠这份随包清单；清单缺失（老 vendor）返回 none。
 */
export const readZCodeBundleVersion = Effect.fn("readZCodeBundleVersion")(
  function* (): Effect.fn.Return<
    Option.Option<ZCodeBundleVersion>,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const candidate of bundledSourceCandidates()) {
      const manifestPath = path.join(candidate, BUNDLE_MANIFEST_NAME);
      const contents = yield* fs.readFileString(manifestPath).pipe(Effect.option);
      if (Option.isNone(contents)) continue;
      const parsed = yield* decodeBundleManifest(contents.value).pipe(Effect.option);
      if (Option.isNone(parsed)) continue;
      const productVersion = parsed.value.productVersion?.trim() ?? "";
      const cliVersion = parsed.value.cliVersion?.trim() ?? "";
      if (productVersion === "") continue;
      const sourceRef = parsed.value.sourceRef?.trim() ?? parsed.value.commit?.trim() ?? "";
      return Option.some({
        productVersion,
        cliVersion,
        ...(parsed.value.builtinConfigRevision === undefined
          ? {}
          : { builtinConfigRevision: parsed.value.builtinConfigRevision }),
        ...(sourceRef === "" ? {} : { sourceRef }),
      });
    }
    return Option.none<ZCodeBundleVersion>();
  },
);
