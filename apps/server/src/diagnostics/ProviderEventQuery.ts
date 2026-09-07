/**
 * ProviderEventQuery — provider 事件日志（Request Lab 底座）的只读查询。
 *
 * 日志由 EventNdjsonLogger 落盘：每个线程一个 `events.<threadSegment>.log`，
 * 行格式为 `[ISO] NTIVE|CANON|ORCH: <json>`，三种流混在同一文件里。这里只做
 * 解析、过滤、脱敏和限量读取；不提供任何写路径或重放入口。
 *
 * @module diagnostics/ProviderEventQuery
 */
import type {
  ProviderEventLogEntry,
  ProviderEventQueryInput,
  ProviderEventQueryResult,
  ProviderEventQueryStream,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
/** 单行超过该字节数时跳过解析（防坏行/超大行拖垮诊断路径）。 */
const MAX_LINE_LENGTH = 256 * 1024;

const STREAM_LABELS: Record<ProviderEventQueryStream, string> = {
  native: "NTIVE",
  canonical: "CANON",
  orchestration: "ORCH",
};
const LABEL_TO_STREAM = new Map<string, ProviderEventQueryStream>(
  Object.entries(STREAM_LABELS).map(([stream, label]) => [
    label,
    stream as ProviderEventQueryStream,
  ]),
);

/** 值按敏感键递归脱敏；只认凭据形状的键，避免误伤 tokensUsed 这类计数字段。 */
const SENSITIVE_KEY_PATTERN =
  /(^|[-_])(api[-_]?key|authorization|secret|password|credential|access[-_]token|refresh[-_]token|id[-_]token)([-_]|$)/i;

export function redactSensitiveValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveValues);
  }
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(source)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redactSensitiveValues(child);
    }
    return result;
  }
  return value;
}

export interface ParsedEventLogLine {
  readonly loggedAt: string | null;
  readonly stream: ProviderEventQueryStream;
  readonly entry: ProviderEventLogEntry;
}

const stringAt = (source: Record<string, unknown>, key: string): string | null => {
  const value = Reflect.get(source, key);
  return typeof value === "string" && value.length > 0 ? value : null;
};

/** 解析单行；坏行/非本查询关心的行返回 null。 */
export function parseProviderEventLogLine(
  line: string,
  streamFilter: ProviderEventQueryStream | undefined,
): ParsedEventLogLine | null {
  const headerMatch = /^\[([^\]]+)\] (NTIVE|CANON|ORCH): /u.exec(line);
  if (headerMatch === null) return null;
  const [fullLine, loggedAtLabel, streamLabel] = headerMatch;
  const stream = streamLabel !== undefined ? LABEL_TO_STREAM.get(streamLabel) : undefined;
  if (fullLine === undefined || loggedAtLabel === undefined || stream === undefined) return null;
  if (streamFilter !== undefined && stream !== streamFilter) return null;
  const jsonText = line.slice(fullLine.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    return null;
  }
  const event =
    typeof parsed === "object" && parsed !== null
      ? (redactSensitiveValues(parsed) as Record<string, unknown>)
      : {};
  return {
    loggedAt: loggedAtLabel,
    stream,
    entry: {
      loggedAt: loggedAtLabel,
      stream,
      eventId: stringAt(event, "eventId"),
      type: stringAt(event, "type"),
      threadId: stringAt(event, "threadId"),
      turnId: stringAt(event, "turnId"),
      requestId: stringAt(event, "requestId"),
      provider: stringAt(event, "provider"),
      providerRequestId: stringAt(event, "providerRequestId"),
      // 对外只返回脱敏后的副本，不透出落盘原文。
      event,
    },
  };
}

export interface ParsedEventLogFile {
  readonly entries: ReadonlyArray<ParsedEventLogLine>;
  readonly truncated: boolean;
}

/** 从整份日志文本取最新 limit 条（按文件顺序，末尾为最新）。 */
export function parseProviderEventLogFile(
  text: string,
  streamFilter: ProviderEventQueryStream | undefined,
  limit: number,
): ParsedEventLogFile {
  const lines = text.split("\n");
  const kept: Array<ParsedEventLogLine> = [];
  let truncated = false;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || line.length === 0 || line.length > MAX_LINE_LENGTH) continue;
    const parsed = parseProviderEventLogLine(line, streamFilter);
    if (parsed === null) continue;
    if (kept.length >= limit) {
      truncated = true;
      break;
    }
    kept.push(parsed);
  }
  return { entries: kept.toReversed(), truncated };
}

export interface ProviderEventQueryOptions {
  readonly providerLogsDir: string;
}

export const readProviderEvents = (options: ProviderEventQueryOptions) => {
  const { providerLogsDir } = options;
  return (
    input: ProviderEventQueryInput,
  ): Effect.Effect<ProviderEventQueryResult, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const limit = Math.min(
        MAX_LIMIT,
        input.limit !== undefined && input.limit > 0 ? input.limit : DEFAULT_LIMIT,
      );
      const segment = toSafeThreadAttachmentSegment(input.threadId);
      if (segment === null) {
        return {
          threadSegment: "",
          scannedFileNames: [],
          events: [],
          truncated: false,
        };
      }
      const directory = path.resolve(providerLogsDir);
      const fileNames = [
        `events.${segment}.log`,
        // EventNdjsonLogger 轮转出的历史文件（.1 .2 …），一并回溯。
        ...Array.from({ length: 4 }, (_, index) => `events.${segment}.${index + 1}.log`),
      ];
      const events: Array<ProviderEventLogEntry> = [];
      const scannedFileNames: Array<string> = [];
      let truncated = false;
      for (const fileName of fileNames) {
        if (events.length >= limit) break;
        const filePath = path.join(directory, fileName);
        const exists = yield* fs
          .exists(filePath)
          .pipe(Effect.catchCause(() => Effect.succeed(false)));
        if (!exists) continue;
        const content = yield* fs
          .readFileString(filePath)
          .pipe(Effect.catchCause(() => Effect.succeed(null)));
        if (content === null) continue;
        scannedFileNames.push(fileName);
        const parsed = parseProviderEventLogFile(content, input.stream, limit - events.length);
        events.push(...parsed.entries.map((entry) => entry.entry));
        truncated = truncated || parsed.truncated;
      }
      return {
        threadSegment: segment,
        scannedFileNames,
        events,
        truncated,
      };
    });
};

// 供调用方探测文件是否落盘（诊断页提示"日志目录"用），保留 Option 语义。
export const findEventLogFile = (directory: string, threadId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const segment = toSafeThreadAttachmentSegment(threadId);
    if (segment === null) return Option.none<string>();
    const filePath = path.join(directory, `events.${segment}.log`);
    return (yield* fs.exists(filePath)) ? Option.some(filePath) : Option.none<string>();
  });
