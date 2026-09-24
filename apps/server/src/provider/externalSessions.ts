// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as DateTime from "effect/DateTime";

import { listTranscriptFiles } from "../usage/usageTranscriptReader.ts";

export type ExternalSessionProvider = "codex" | "claudeAgent";

export interface ExternalSessionCandidate {
  readonly id: string;
  readonly provider: ExternalSessionProvider;
  readonly title: string;
  readonly createdAt: string;
  readonly modifiedAt: string;
  readonly canResume: boolean;
}

export interface ExternalSessionMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

interface LocatedSession extends ExternalSessionCandidate {
  readonly nativeSessionId: string;
  readonly filePath: string;
  readonly providerInstanceId: string;
}

const MAX_CANDIDATE_FILES = 600;
const MAX_IMPORT_MESSAGES = 1_000;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_IMPORT_CHARS = 2_000_000;
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    return object(JSON.parse(line));
  } catch {
    return null;
  }
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const block = object(part);
      return block?.type === "text" || block?.type === "input_text" || block?.type === "output_text"
        ? typeof block.text === "string"
          ? block.text
          : ""
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function readMessage(
  record: Record<string, unknown>,
  provider: ExternalSessionProvider,
): { role: "user" | "assistant"; text: string } | null {
  if (provider === "codex") {
    if (record.type !== "response_item") return null;
    const payload = object(record.payload);
    if (payload?.type !== "message") return null;
    const role = payload.role;
    if (role !== "user" && role !== "assistant") return null;
    return { role, text: textContent(payload.content) };
  }
  if (record.type !== "user" && record.type !== "assistant") return null;
  const message = object(record.message);
  if (!message) return null;
  return { role: record.type, text: textContent(message.content) };
}

function sameWorkspace(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string) => {
    const resolved = NodePath.resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function sessionKey(provider: ExternalSessionProvider, nativeSessionId: string): string {
  return NodeCrypto.createHash("sha256")
    .update(`${provider}\0${nativeSessionId}`)
    .digest("hex")
    .slice(0, 32);
}

async function header(
  filePath: string,
  provider: ExternalSessionProvider,
  projectRoot: string,
  platform: NodeJS.Platform,
): Promise<{ nativeSessionId: string; title: string; createdAt: string } | null> {
  let nativeSessionId = "";
  let cwd = "";
  let title = "";
  let createdAt = "";
  let bytes = 0;
  const codexFileId =
    provider === "codex"
      ? /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
          NodePath.basename(filePath),
        )?.[1]
      : undefined;
  const lines = NodeReadline.createInterface({
    input: NodeFS.createReadStream(filePath, { encoding: "utf8", end: 512 * 1024 - 1 }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line) + 1;
      if (bytes > 512 * 1024) break;
      const record = parseLine(line);
      if (!record) continue;
      if (provider === "codex" && record.type === "session_meta") {
        const payload = object(record.payload);
        if (
          typeof payload?.id === "string" &&
          typeof payload.cwd === "string" &&
          (codexFileId === undefined || payload.id.toLowerCase() === codexFileId.toLowerCase())
        ) {
          nativeSessionId = payload.id;
          cwd = payload.cwd;
          title = "";
          if (typeof record.timestamp === "string") createdAt = record.timestamp;
        }
      } else if (provider === "claudeAgent") {
        if (typeof record.sessionId === "string") nativeSessionId = record.sessionId;
        if (typeof record.cwd === "string") cwd = record.cwd;
        if (!createdAt && typeof record.timestamp === "string") createdAt = record.timestamp;
      }
      if (!title && (provider !== "codex" || nativeSessionId !== "")) {
        const message = readMessage(record, provider);
        if (message?.role === "user")
          title = message.text.trim().replace(/\s+/g, " ").slice(0, 100);
      }
      if (nativeSessionId && cwd && title) break;
    }
  } catch {
    return null;
  } finally {
    lines.close();
  }
  if (!nativeSessionId || !cwd || !sameWorkspace(cwd, projectRoot, platform)) return null;
  return {
    nativeSessionId,
    title:
      title || `${provider === "codex" ? "Codex" : "Claude Code"} ${nativeSessionId.slice(0, 8)}`,
    createdAt: Number.isNaN(Date.parse(createdAt))
      ? DateTime.formatIso(DateTime.makeUnsafe(0))
      : createdAt,
  };
}

/** 只扫描服务端配置的 CLI 日志，返回不含原始路径的候选项。 */
export async function scanExternalSessions(input: {
  readonly projectRoot: string;
  readonly sources: ReadonlyArray<{
    readonly provider: ExternalSessionProvider;
    readonly dir: string;
    readonly providerInstanceId: string;
  }>;
  readonly platform: NodeJS.Platform;
}): Promise<readonly LocatedSession[]> {
  const found: LocatedSession[] = [];
  for (const root of input.sources) {
    const files = (await listTranscriptFiles(root.dir, 0))
      .toSorted((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_CANDIDATE_FILES);
    for (const file of files) {
      const meta = await header(file.path, root.provider, input.projectRoot, input.platform);
      if (!meta) continue;
      found.push({
        id: sessionKey(root.provider, meta.nativeSessionId),
        provider: root.provider,
        title: meta.title,
        createdAt: meta.createdAt,
        modifiedAt: DateTime.formatIso(DateTime.makeUnsafe(file.mtimeMs)),
        canResume: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          meta.nativeSessionId,
        ),
        nativeSessionId: meta.nativeSessionId,
        filePath: file.path,
        providerInstanceId: root.providerInstanceId,
      });
    }
  }
  return [...new Map(found.map((candidate) => [candidate.id, candidate])).values()].toSorted(
    (a, b) => b.modifiedAt.localeCompare(a.modifiedAt),
  );
}

export async function readExternalSession(
  candidate: LocatedSession,
): Promise<{ messages: readonly ExternalSessionMessage[]; truncated: boolean }> {
  const stats = await NodeFSP.stat(candidate.filePath);
  if (stats.size > MAX_IMPORT_BYTES) throw new Error("External session exceeds the import limit");
  const messages: ExternalSessionMessage[] = [];
  let totalChars = 0;
  let truncated = false;
  const seenClaudeIds = new Set<string>();
  const lines = NodeReadline.createInterface({
    input: NodeFS.createReadStream(candidate.filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const record = parseLine(line);
    if (!record) continue;
    if (candidate.provider === "claudeAgent") {
      const uuid = typeof record.uuid === "string" ? record.uuid : null;
      if (uuid && seenClaudeIds.has(uuid)) continue;
      if (uuid) seenClaudeIds.add(uuid);
    }
    const message = readMessage(record, candidate.provider);
    if (!message || !message.text.trim()) continue;
    const createdAt =
      typeof record.timestamp === "string" && !Number.isNaN(Date.parse(record.timestamp))
        ? record.timestamp
        : candidate.createdAt;
    if (message.text.length > MAX_MESSAGE_CHARS) truncated = true;
    const boundedText = message.text.slice(0, MAX_MESSAGE_CHARS);
    messages.push({
      role: message.role,
      text: boundedText,
      createdAt,
    });
    totalChars += boundedText.length;
    while (messages.length > MAX_IMPORT_MESSAGES || totalChars > MAX_IMPORT_CHARS) {
      const oldest = messages.shift();
      totalChars -= oldest?.text.length ?? 0;
      truncated = true;
    }
  }
  return { messages, truncated };
}
