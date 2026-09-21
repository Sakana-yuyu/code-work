// @effect-diagnostics nodeBuiltinImport:off - 直接拉起用户全局安装的 codegraph CLI。
// @effect-diagnostics globalTimers:off - 独立 Promise/Node 回调边界保留原生计时器，超时不终止索引进程。
/**
 * CodeGraph CLI 维护链路：一键安装（npm 全局包）、`status --json` 投影读取、
 * `sync` 增量同步、`init` 首建与 `index` 全量重建。全部是对上游 CLI 的
 * 一次性子进程调用，失败一律返回结果对象（fail-open），绝不把 CLI 缺失上升
 * 为服务器错误。
 *
 * @module codeGraphMaintenance
 */
import * as DateTime from "effect/DateTime";
import * as NodeChildProcess from "node:child_process";

import type { CodeGraphInstallState } from "@codework/contracts";

import { hasCodeGraphIndex, isCodeGraphInitInFlight } from "./codeGraphIndex.ts";
import {
  applyCodeGraphOutput,
  getCodeGraphIndexProgress,
  setCodeGraphProgress,
} from "./codeGraphProgress.ts";

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const STATUS_TIMEOUT_MS = 20_000;
const SYNC_TIMEOUT_MS = 5 * 60_000;
// 首建索引在大仓库上远慢于增量 sync；超时不杀进程，索引会继续在后台推进。
const REINDEX_TIMEOUT_MS = 30 * 60_000;
const VERSION_TIMEOUT_MS = 8_000;
const OUTPUT_MAX_BYTES = 256 * 1024;

/** 安装状态与 lockKey 语义对齐 providerMaintenance：同锁在飞不重复拉起。 */
let installState: CodeGraphInstallState = {
  status: "idle",
  message: null,
  updatedAt: 0,
};

export const getCodeGraphInstallState = (): CodeGraphInstallState => installState;

const setInstallState = (status: CodeGraphInstallState["status"], message?: string): void => {
  installState = {
    status,
    message: message ?? null,
    updatedAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
  };
};

/** spawn 结果只用到流监听与退出码；最小结构便于测试注入。 */
export interface CodeGraphMaintSpawnedChild {
  on(event: "error", listener: (cause: unknown) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  stdout: { on(event: "data", listener: (chunk: unknown) => void): unknown };
  stderr: { on(event: "data", listener: (chunk: unknown) => void): unknown };
}

export type CodeGraphMaintSpawnImpl = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly shell: boolean;
    readonly windowsHide: boolean;
    readonly cwd?: string;
    readonly stdio: ReadonlyArray<"ignore" | "pipe">;
  },
) => CodeGraphMaintSpawnedChild;

export interface CodeGraphCommandOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnFailed: boolean;
}

const defaultSpawn: CodeGraphMaintSpawnImpl = (command, args, options) =>
  NodeChildProcess.spawn(command, args, {
    ...options,
    stdio: [...options.stdio],
  }) as unknown as CodeGraphMaintSpawnedChild;

const decode = (chunk: unknown): string =>
  typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";

const collect = (stream: { on(event: "data", listener: (chunk: unknown) => void): unknown }) => {
  let text = "";
  return {
    promise: new Promise<string>(() => {
      stream.on("data", (chunk: unknown) => {
        text += decode(chunk);
        if (text.length > OUTPUT_MAX_BYTES) {
          text = text.slice(-OUTPUT_MAX_BYTES);
        }
      });
    }),
    // 监听器同步注册；promise 在 close 之后才能落定，这里只保证流被消费。
    get: () => text,
  };
};

const runCodeGraphCommand = async (input: {
  readonly args: ReadonlyArray<string>;
  readonly platform: NodeJS.Platform;
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly onOutput?: (chunk: unknown) => void;
  readonly spawnImpl?: CodeGraphMaintSpawnImpl;
}): Promise<CodeGraphCommandOutcome> => {
  const useShell = input.platform === "win32";
  const args = input.args.map((arg) => (useShell ? `"${arg}"` : arg));
  const spawnImpl = input.spawnImpl ?? defaultSpawn;
  return await new Promise<CodeGraphCommandOutcome>((resolve) => {
    let settled = false;
    let child: CodeGraphMaintSpawnedChild;
    try {
      child = spawnImpl("codegraph", args, {
        shell: useShell,
        windowsHide: true,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      return resolve({ code: null, stdout: "", stderr: String(cause), spawnFailed: true });
    }
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    child.stdout.on("data", (chunk: unknown) => input.onOutput?.(chunk));
    child.stderr.on("data", (chunk: unknown) => input.onOutput?.(chunk));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({
        code: null,
        stdout: stdout.get(),
        stderr: `${stderr.get()}\ncodegraph ${input.args[0] ?? ""} 超时（${input.timeoutMs}ms）`,
        spawnFailed: false,
      });
      // 超时不杀进程：索引构建不值得半途kill；结果按超时失败呈现。
    }, input.timeoutMs);
    child.on("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: null,
        stdout: stdout.get(),
        stderr: `${stderr.get()}${String(cause)}`,
        spawnFailed: true,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: stdout.get(), stderr: stderr.get(), spawnFailed: false });
    });
    void stdout.promise;
    void stderr.promise;
  });
};

export interface CodeGraphMaintenanceOptions {
  /** 宿主平台：Effect 侧 yield HostProcessPlatform，测试显式给定。 */
  readonly platform: NodeJS.Platform;
  readonly spawnImpl?: CodeGraphMaintSpawnImpl;
}

const CLI_MISSING_HINT = "未找到 codegraph CLI，可 npm i -g @colbymchenry/codegraph 后重试。";

/** `codegraph --version`；结果缓存 60s，避免设置页轮询反复拉子进程。 */
let versionCache: { readonly version: string | null; readonly expiresAt: number } | null = null;

export const readCodeGraphCliVersion = async (
  options: CodeGraphMaintenanceOptions,
): Promise<string | null> => {
  const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
  if (versionCache !== null && versionCache.expiresAt > now) {
    return versionCache.version;
  }
  const outcome = await runCodeGraphCommand({
    args: ["--version"],
    platform: options.platform,
    timeoutMs: VERSION_TIMEOUT_MS,
    ...(options.spawnImpl === undefined ? {} : { spawnImpl: options.spawnImpl }),
  });
  const version = outcome.spawnFailed || outcome.code !== 0 ? null : firstLine(outcome.stdout);
  versionCache = { version, expiresAt: now + 60_000 };
  return version;
};

const firstLine = (text: string): string | null => {
  const line = text.split(/\r\n|\r|\n/u).find((candidate) => candidate.trim().length > 0);
  return line === undefined ? null : line.trim();
};

/**
 * npm 全局安装最新版 CLI。npm 是上游唯一官方分发渠道；npm 缺失时按失败
 * 返回并提示手动安装。同锁在飞时直接返回当前状态。
 */
export const installCodeGraphCli = async (
  options: CodeGraphMaintenanceOptions,
): Promise<CodeGraphInstallState> => {
  if (installState.status === "queued" || installState.status === "running") {
    return installState;
  }
  setInstallState("queued");
  const useShell = options.platform === "win32";
  const spawnImpl = options.spawnImpl;
  let child: ReturnType<CodeGraphMaintSpawnImpl> | null = null;
  try {
    child = (spawnImpl ?? defaultSpawn)(
      "npm",
      ["install", "-g", "@colbymchenry/codegraph@latest"].map((arg) =>
        useShell ? `"${arg}"` : arg,
      ),
      { shell: useShell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (cause) {
    setInstallState("failed", `npm 启动失败：${String(cause)}`);
    return installState;
  }
  setInstallState("running");
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (status: CodeGraphInstallState["status"], message?: string) => {
      if (settled) return;
      settled = true;
      setInstallState(status, message);
      resolve();
    };
    const timer = setTimeout(() => finish("failed", "npm 安装超时（10 分钟）"), INSTALL_TIMEOUT_MS);
    child!.on("error", (cause) => {
      clearTimeout(timer);
      finish("failed", `npm 启动失败（本机缺少 npm？）：${String(cause)}`);
    });
    child!.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        versionCache = null;
        finish("succeeded");
        return;
      }
      finish("failed", `npm install -g @colbymchenry/codegraph 退出码 ${code ?? "null"}`);
    });
  });
  return installState;
};

export interface CodeGraphProjectStatusRead {
  readonly initialized: boolean;
  readonly cliVersion: string | null;
  readonly fileCount: number | null;
  readonly nodeCount: number | null;
  readonly edgeCount: number | null;
  readonly dbSizeBytes: number | null;
  readonly languages: ReadonlyArray<string>;
  readonly lastIndexed: string | null;
  readonly pendingChanges: {
    readonly added: number;
    readonly modified: number;
    readonly removed: number;
  } | null;
  readonly reindexRecommended: boolean;
}

type StatusJson = {
  initialized?: unknown;
  version?: unknown;
  fileCount?: unknown;
  nodeCount?: unknown;
  edgeCount?: unknown;
  dbSizeBytes?: unknown;
  languages?: unknown;
  lastIndexed?: unknown;
  pendingChanges?: unknown;
  index?: unknown;
};

const asCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** 宽松解析 `codegraph status --json`；字段缺失按 null 降级，绝不抛错。 */
export const parseCodeGraphStatusJson = (text: string): CodeGraphProjectStatusRead => {
  const fallback: CodeGraphProjectStatusRead = {
    initialized: false,
    cliVersion: null,
    fileCount: null,
    nodeCount: null,
    edgeCount: null,
    dbSizeBytes: null,
    languages: [],
    lastIndexed: null,
    pendingChanges: null,
    reindexRecommended: false,
  };
  let payload: StatusJson;
  try {
    payload = JSON.parse(text) as StatusJson;
  } catch {
    return fallback;
  }
  const pending = payload.pendingChanges;
  const pendingShape =
    typeof pending === "object" && pending !== null
      ? {
          added: asCount((pending as { added?: unknown }).added) ?? 0,
          modified: asCount((pending as { modified?: unknown }).modified) ?? 0,
          removed: asCount((pending as { removed?: unknown }).removed) ?? 0,
        }
      : null;
  const index = typeof payload.index === "object" && payload.index !== null ? payload.index : {};
  return {
    initialized: payload.initialized === true,
    cliVersion: typeof payload.version === "string" ? payload.version : null,
    fileCount: asCount(payload.fileCount),
    nodeCount: asCount(payload.nodeCount),
    edgeCount: asCount(payload.edgeCount),
    dbSizeBytes: asCount(payload.dbSizeBytes),
    languages: Array.isArray(payload.languages)
      ? payload.languages.filter((item): item is string => typeof item === "string")
      : [],
    lastIndexed: typeof payload.lastIndexed === "string" ? payload.lastIndexed : null,
    pendingChanges: pendingShape,
    reindexRecommended: (index as { reindexRecommended?: unknown }).reindexRecommended === true,
  };
};

export const readCodeGraphProjectStatus = async (
  workspaceRoot: string,
  options: CodeGraphMaintenanceOptions,
): Promise<CodeGraphProjectStatusRead> => {
  const outcome = await runCodeGraphCommand({
    args: ["status", "--json"],
    platform: options.platform,
    cwd: workspaceRoot,
    timeoutMs: STATUS_TIMEOUT_MS,
    ...(options.spawnImpl === undefined ? {} : { spawnImpl: options.spawnImpl }),
  });
  if (outcome.spawnFailed || outcome.code !== 0) {
    // CLI 缺失或 status 失败：仅反映 CLI 版本信息缺失，项目按未初始化降级。
    return parseCodeGraphStatusJson("");
  }
  return parseCodeGraphStatusJson(outcome.stdout);
};

/** `codegraph sync`：把自上次索引以来的变更并入索引；返回结果摘要。 */
export const syncCodeGraphIndex = async (
  workspaceRoot: string,
  options: CodeGraphMaintenanceOptions,
): Promise<{ readonly succeeded: boolean; readonly message: string | null }> => {
  const outcome = await runCodeGraphCommand({
    args: ["sync"],
    platform: options.platform,
    cwd: workspaceRoot,
    timeoutMs: SYNC_TIMEOUT_MS,
    ...(options.spawnImpl === undefined ? {} : { spawnImpl: options.spawnImpl }),
  });
  if (outcome.spawnFailed) {
    return { succeeded: false, message: CLI_MISSING_HINT };
  }
  if (outcome.code !== 0) {
    return {
      succeeded: false,
      message: firstLine(outcome.stderr) ?? `sync 退出码 ${outcome.code ?? "null"}`,
    };
  }
  return { succeeded: true, message: firstLine(outcome.stdout) };
};

/**
 * `init`（首建）与 `index`（全量重建）共用的完整构建：输出与 init 同族，
 * 阶段进度写入同一张进度表供设置页展示；完成后返回摘要。
 */
const runFullIndexBuild = async (
  workspaceRoot: string,
  commandLabel: string,
  args: ReadonlyArray<string>,
  options: CodeGraphMaintenanceOptions,
): Promise<{ readonly succeeded: boolean; readonly message: string | null }> => {
  const outcome = await runCodeGraphCommand({
    args,
    platform: options.platform,
    cwd: workspaceRoot,
    timeoutMs: REINDEX_TIMEOUT_MS,
    onOutput: (chunk) => applyCodeGraphOutput(workspaceRoot, chunk, options.platform),
    ...(options.spawnImpl === undefined ? {} : { spawnImpl: options.spawnImpl }),
  });
  if (outcome.spawnFailed) {
    return { succeeded: false, message: CLI_MISSING_HINT };
  }
  if (outcome.code !== 0) {
    return {
      succeeded: false,
      message: firstLine(outcome.stderr) ?? `${commandLabel} 退出码 ${outcome.code ?? "null"}`,
    };
  }
  // 输出解析已经落了 complete；输出缺失时在这里兜底。
  if (getCodeGraphIndexProgress(workspaceRoot, options.platform)?.phase !== "complete") {
    setCodeGraphProgress(workspaceRoot, "complete", undefined, options.platform);
  }
  return { succeeded: true, message: firstLine(outcome.stdout) };
};

/**
 * 面板上的「建立/重建索引」：已初始化的项目跑 `codegraph index` 全量重建；
 * 未初始化的项目上游会直接报 "[ERR] CodeGraph not initialized"，首建必须走
 * `codegraph init <path>`——与 agent 回合的自动建索引同一条命令（实测
 * init 本身就是非交互的：初始化并默认建索引；1.6.0 新增的 --yes 不需要）。auto-init
 * 在飞时绝不并行拉起第二个构建进程，进度由在飞进程写入的进度表展示。
 */
export const reindexCodeGraph = async (
  workspaceRoot: string,
  options: CodeGraphMaintenanceOptions,
): Promise<{ readonly succeeded: boolean; readonly message: string | null }> => {
  if (!hasCodeGraphIndex(workspaceRoot)) {
    if (isCodeGraphInitInFlight(workspaceRoot, options.platform)) {
      return { succeeded: true, message: "索引正在后台建立中。" };
    }
    return runFullIndexBuild(workspaceRoot, "init", ["init", workspaceRoot], options);
  }
  return runFullIndexBuild(workspaceRoot, "index", ["index"], options);
};
