// @effect-diagnostics nodeBuiltinImport:off
/**
 * CodeGraph 建索引阶段进度的共享存储。init（后台拉起）与 index（重建）
 * 都把阶段写入这张按工作区根目录键控的内存表；设置页经 RPC 读取展示，
 * 只反应阶段不做百分比，纯内存不落盘。
 *
 * @module codeGraphProgress
 */
import * as DateTime from "effect/DateTime";
import * as NodePath from "node:path";

import type { CodeGraphIndexPhase, CodeGraphIndexProgress } from "@codework/contracts";

/** 上游 init/reindex 输出的阶段行 → 本地阶段枚举。 */
const PHASE_LINE_MATCHERS: ReadonlyArray<{
  readonly phase: CodeGraphIndexPhase;
  readonly needle: string;
}> = [
  { phase: "scanning", needle: "Scanning files" },
  { phase: "parsing", needle: "Parsing code" },
  { phase: "resolving", needle: "Resolving refs" },
  { phase: "linking", needle: "Linking dynamic dispatch" },
];

const ANSI_ESCAPE = /\x1b\[[0-9;]*[A-Za-z]/gu;

const stripAnsi = (text: string): string => text.replace(ANSI_ESCAPE, "");

/** 单行输出 → 阶段更新；不是阶段/摘要行时返回 null。 */
export const parseCodeGraphProgressLine = (
  line: string,
): { readonly phase: CodeGraphIndexPhase; readonly detail?: string } | null => {
  const plain = stripAnsi(line).trim();
  if (plain.length === 0) return null;
  for (const matcher of PHASE_LINE_MATCHERS) {
    if (plain.includes(matcher.needle)) return { phase: matcher.phase };
  }
  // 完成摘要：「● 13 nodes, 10 edges in 948ms」带统计；「└ Done」只作完成
  // 信号（不带 detail，避免把已有统计摘要拼上无信息的尾巴）。
  if (/\bnodes?,\s+\d+\s+edges?\s+in\b/iu.test(plain)) {
    return { phase: "complete", detail: plain };
  }
  if (/\bDone\b/iu.test(plain)) {
    return { phase: "complete" };
  }
  return null;
};

const progressByRoot = new Map<string, CodeGraphIndexProgress>();

const normalizeRootKey = (root: string): string => {
  const resolved = NodePath.resolve(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

export const getCodeGraphIndexProgress = (root: string): CodeGraphIndexProgress | null =>
  progressByRoot.get(normalizeRootKey(root)) ?? null;

export const setCodeGraphProgress = (
  root: string,
  phase: CodeGraphIndexPhase,
  detail?: string,
): void => {
  progressByRoot.set(normalizeRootKey(root), {
    phase,
    detail: detail ?? null,
    updatedAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
  });
};

/** 把一段 CLI 输出应用到某个 root 的进度上；返回是否出现了完成摘要。 */
export const applyCodeGraphOutput = (root: string, chunk: unknown): boolean => {
  const text =
    typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
  if (text.length === 0) return false;
  let sawComplete = false;
  // 展示用途不做行缓冲：chunk 边界把一行劈开的概率极低，且下一个阶段行
  // 仍会正常落位；\r 与 \n 都按行界处理（上游 spinner 会回车重绘）。
  for (const line of text.split(/\r\n|\r|\n/u)) {
    const parsed = parseCodeGraphProgressLine(line);
    if (parsed === null) continue;
    if (parsed.phase === "complete") {
      sawComplete = true;
      const existing = progressByRoot.get(normalizeRootKey(root));
      const merged =
        parsed.detail === undefined
          ? (existing?.detail ?? null)
          : existing?.phase === "complete" && existing.detail !== null
            ? `${existing.detail}; ${parsed.detail}`
            : parsed.detail;
      setCodeGraphProgress(root, "complete", merged ?? undefined);
      continue;
    }
    setCodeGraphProgress(root, parsed.phase);
  }
  return sawComplete;
};
