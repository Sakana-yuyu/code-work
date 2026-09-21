// @effect-diagnostics nodeBuiltinImport:off
/**
 * 代码符号索引的实时进度共享存储。首扫（Layer 构建内的 reconcile）与增量
 * flush 都把进度写进这张按工作区根目录键控的内存表；状态 RPC 在表命中时
 * 直接返回、不再等 Layer 构建完成，纯内存不落盘。
 *
 * @module codeIndexProgress
 */
import * as DateTime from "effect/DateTime";
import * as NodePath from "node:path";

import type { CodeIndexProgress } from "@codework/contracts";

export interface CodeIndexProgressEntry extends CodeIndexProgress {
  readonly updatedAt: number;
}

const progressByRoot = new Map<string, CodeIndexProgressEntry>();

const normalizeRootKey = (root: string, platform: NodeJS.Platform): string => {
  const resolved = NodePath.resolve(root);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
};

/**
 * 仍在推进的进度才可信：reconcile 在扫描/统计阶段无法逐文件刷新时间戳，
 * 中途失败的残余条目靠这条时限自然失效，不被误读成持续索引中。
 */
const PROGRESS_FRESH_MS = 120_000;

export const setCodeIndexProgress = (
  root: string,
  progress: Omit<CodeIndexProgressEntry, "updatedAt">,
  platform: NodeJS.Platform,
): void => {
  progressByRoot.set(normalizeRootKey(root, platform), {
    ...progress,
    updatedAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
  });
};

export const clearCodeIndexProgress = (root: string, platform: NodeJS.Platform): void => {
  progressByRoot.delete(normalizeRootKey(root, platform));
};

/** 未在推进（缺失或超时未刷新）时返回 null，状态行回落到常规 status。 */
export const readActiveCodeIndexProgress = (
  root: string,
  platform: NodeJS.Platform,
): CodeIndexProgress | null => {
  const entry = progressByRoot.get(normalizeRootKey(root, platform));
  if (entry === undefined) return null;
  if (DateTime.toEpochMillis(DateTime.nowUnsafe()) - entry.updatedAt > PROGRESS_FRESH_MS)
    return null;
  return { phase: entry.phase, processedFiles: entry.processedFiles, totalFiles: entry.totalFiles };
};
