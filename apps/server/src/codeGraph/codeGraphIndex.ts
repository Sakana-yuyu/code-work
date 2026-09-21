// @effect-diagnostics nodeBuiltinImport:off - 直接拉起用户全局安装的 codegraph CLI。
/**
 * CodeGraph integration - background indexing around the upstream
 * `@colbymchenry/codegraph` CLI (https://github.com/colbymchenry/codegraph).
 *
 * Code Work never bundles the CLI; it shells out to whatever `codegraph` is on
 * PATH. With the feature switch on, a turn on a project without a
 * `.codegraph/` index kicks off `codegraph init` in the background
 * (deduped per root, guarded against unsafe roots, never awaited) and the
 * `codegraph.explore` tool answers from the index once it exists. Everything
 * is fail-open: a missing CLI or failed init just leaves the regular toolset
 * in place, and upstream's own guidance tells agents to keep using it.
 *
 * @module codeGraphIndex
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  applyCodeGraphOutput,
  getCodeGraphIndexProgress,
  setCodeGraphProgress,
} from "./codeGraphProgress.ts";

/**
 * Upstream CLI version this integration was validated against. Before each
 * release, compare against npm `latest` with
 * `node scripts/check-codegraph-upstream.ts` and re-verify the integration
 * when the CLI moved.
 */
// 基线 = 实际跑通 init/index/sync/status/explore 全链路并核实命令面的版本。
export const CODEGRAPH_VALIDATED_CLI_VERSION = "1.6.0";

export const CODEGRAPH_INDEX_DIR_NAME = ".codegraph";

export const codeGraphIndexPath = (root: string): string =>
  NodePath.join(root, CODEGRAPH_INDEX_DIR_NAME);

/** `.codegraph/` 索引目录是否存在（init 幂等门槛 + 指引块开关）。 */
export const hasCodeGraphIndex = (root: string): boolean => {
  try {
    return NodeFS.statSync(codeGraphIndexPath(root)).isDirectory();
  } catch {
    return false;
  }
};

const normalizeRootKey = (root: string, platform: NodeJS.Platform): string => {
  const resolved = NodePath.resolve(root);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
};

/**
 * 拒绝对「根目录级」位置建索引：盘符根、主目录本身。这些位置建出的索引只
 * 会制造超长扫描和噪音，从来不是真正的项目。
 */
export const unsafeCodeGraphIndexRootReason = (input: {
  readonly root: string;
  readonly homeDir?: string | undefined;
  readonly platform: NodeJS.Platform;
}): string | null => {
  const resolved = NodePath.resolve(input.root);
  if (resolved === NodePath.parse(resolved).root) return "盘符根目录";
  const homeDir = NodePath.resolve(input.homeDir ?? NodeOS.homedir());
  if (normalizeRootKey(resolved, input.platform) === normalizeRootKey(homeDir, input.platform))
    return "用户主目录";
  return null;
};

const initInFlight = new Set<string>();
const initFailedRoots = new Set<string>();

export const isCodeGraphInitInFlight = (root: string, platform: NodeJS.Platform): boolean =>
  initInFlight.has(normalizeRootKey(root, platform));

/** spawn 结果只用到事件监听与 unref；最小结构便于测试注入。 */
export interface CodeGraphSpawnedChild {
  on(event: "error" | "close", listener: (cause?: unknown) => void): unknown;
  /** stdio 管道（init 捕获输出用于阶段进度；测试桩可以不提供）。 */
  stdout?: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  stderr?: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  unref(): unknown;
}

export type CodeGraphSpawnImpl = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly shell: boolean;
    readonly windowsHide: boolean;
    readonly detached: boolean;
    readonly stdio: ReadonlyArray<"ignore" | "pipe">;
  },
) => CodeGraphSpawnedChild;

export type SpawnCodeGraphInitOptions = {
  readonly root: string;
  readonly homeDir?: string | undefined;
  /** 宿主平台：Effect 侧 yield HostProcessPlatform，测试显式给定。 */
  readonly platform: NodeJS.Platform;
  readonly logWarning?: (message: string, cause?: unknown) => void;
  /** 测试注入点。 */
  readonly spawnImpl?: CodeGraphSpawnImpl;
};

/**
 * 后台拉起 `codegraph init <root>`：同一 root 去重、绝不抛错、调用方
 * 永不等待。返回是否真的拉起了新的 init 进程。
 */
export const spawnCodeGraphIndexInit = (options: SpawnCodeGraphInitOptions): boolean => {
  const root = NodePath.resolve(options.root);
  const platform = options.platform;
  const logWarning = options.logWarning ?? (() => {});
  const reason = unsafeCodeGraphIndexRootReason({ root, homeDir: options.homeDir, platform });
  if (reason !== null) {
    logWarning(`跳过 CodeGraph 索引：${root} 是${reason}。`, undefined);
    return false;
  }
  if (hasCodeGraphIndex(root)) return false;
  const key = normalizeRootKey(root, platform);
  if (initInFlight.has(key) || initFailedRoots.has(key)) return false;
  initInFlight.add(key);

  const spawnImpl = options.spawnImpl ?? (NodeChildProcess.spawn as unknown as CodeGraphSpawnImpl);
  try {
    // Windows 上全局 npm 垫片是 codegraph.cmd，必须经 shell 拉起；Windows
    // 路径不可能包含双引号，逐参数包裹即为安全的引号处理。POSIX 直接数组
    // 派生并 detached，init 不随 server 退出而被杀。stdout/stderr 保持管道
    // 仅供阶段进度解析；init 期间 server 重启只会丢失进度显示，detached
    // 的 init 本身照常完成。
    const useShell = platform === "win32";
    // 上游 init 本身非交互（初始化并默认建索引）；1.6.0 起提供 --yes 跳过
    // 提示，但本函数只在无 .codegraph 时调用、stdin 又被 ignore，提示无从
    // 触发也无从阻塞，故不传。
    const args = ["init", root].map((arg) => (useShell ? `"${arg}"` : arg));
    const child = spawnImpl("codegraph", args, {
      cwd: root,
      shell: useShell,
      windowsHide: true,
      detached: !useShell,
      stdio: ["ignore", "pipe", "pipe"],
    });
    setCodeGraphProgress(root, "queued", undefined, platform);
    const consume = (chunk: unknown): void => {
      applyCodeGraphOutput(root, chunk, platform);
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.on("error", (cause) => {
      initInFlight.delete(key);
      initFailedRoots.add(key);
      setCodeGraphProgress(
        root,
        "failed",
        "CLI 启动失败（未安装？可 npm i -g @colbymchenry/codegraph）",
        platform,
      );
      logWarning(
        `CodeGraph init 启动失败（CLI 未安装？可 npm i -g @colbymchenry/codegraph）：${root}`,
        cause,
      );
    });
    child.on("close", () => {
      initInFlight.delete(key);
      // 没等到完成摘要就退出：按失败展示。释放 in-flight 的既有语义不变
      // （索引仍不存在时允许下一次回合补建）。
      if (getCodeGraphIndexProgress(root, platform)?.phase !== "complete") {
        setCodeGraphProgress(root, "failed", "init 进程在完成前退出", platform);
      }
    });
    child.unref();
    return true;
  } catch (cause) {
    initInFlight.delete(key);
    initFailedRoots.add(key);
    setCodeGraphProgress(root, "failed", "init 无法启动", platform);
    logWarning(`CodeGraph init 无法启动：${root}`, cause);
    return false;
  }
};

/**
 * 注入 BYOK 系统提示词的 CodeGraph 使用边界（项目已有索引时才注入）。
 * 正面清单来自 CodeGraph 的设计目标（关系型理解），负面清单防止模型把
 * 索引查询当成万金油、把上下文撑爆。
 */
export const CODEGRAPH_GUIDANCE_PROMPT =
  "本项目已建立 CodeGraph 代码索引。涉及跨文件代码理解、调用关系、数据流、功能流程、架构分析、" +
  "Bug 根因定位、核心逻辑修改、重构以及修改影响范围判断时，优先调用 codegraph.explore 获取结构化" +
  "上下文，避免反复用 search_contents 和逐个读取文件重新推导代码关系；对已明确知道文件位置的简单" +
  "修改、字符串查找、配置文件、文档、样式与注释调整、单文件局部任务，不要调用 codegraph.explore，" +
  "直接使用常规工具即可。若 codegraph.explore 返回索引缺失或查询失败，改用常规工具，不要反复重试。";
