/**
 * pi-family JSONL 帧解码器（Pi / OhMyPi 共用）。
 *
 * 子进程 stdout 按行输出 JSON 帧。协议 v1 是单行单帧；OMP 自 17.x 起协商
 * v2 chunked 传输——超过 1 MiB 的帧会被拆成若干 `rpc_chunk` 帧以 base64
 * 传输，客户端必须按 chunkId 重组后才能解析。
 *
 * 纯逻辑、无 Effect 依赖：{@link push} 吃任意切割的文本 chunk，同步返回
 * 本次解码出的完整帧（含重组后的大帧），坏帧经 onProblem 上报并丢弃，
 * 不中断流（协议对端版本漂移时不能拖垮整个会话）。
 *
 * @module provider/pifamily/jsonlFrameDecoder
 */

/** 单帧上限；`ready` 帧以此声明 v2 能力。 */
export const JSONL_RPC_V2_FRAME_BYTES = 1024 * 1024;
/** 重组后单帧上限。 */
export const JSONL_RPC_V2_REASSEMBLED_BYTES = 64 * 1024 * 1024;
/** 单个 chunk 的 base64 载荷上限。 */
export const JSONL_RPC_V2_CHUNK_BYTES = 256 * 1024;

export type JsonlFrameProblemKind =
  | "invalid-json"
  | "invalid-chunk"
  | "invalid-base64"
  | "chunk-length-mismatch"
  | "invalid-chunk-payload"
  | "chunk-too-large";

export interface JsonlFrameProblem {
  readonly kind: JsonlFrameProblemKind;
  /** 问题帧的原文（截断到 500 字符），只用于诊断，不进入事件流。 */
  readonly detail: string;
}

interface PendingChunkGroup {
  readonly count: number;
  readonly parts: Map<number, Buffer>;
  receivedBytes: number;
}

/**
 * `ready` 帧是否声明了 v2 chunked 传输能力。OMP 服务器就绪时发送：
 * `{type:"ready", supportedProtocolVersions:[1,2], maxFrameBytes:1MiB, maxReassembledFrameBytes:64MiB}`。
 */
export function supportsJsonlRpcProtocolV2(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const record = message as Record<string, unknown>;
  if (record.type !== "ready") return false;
  const versions = Array.isArray(record.supportedProtocolVersions)
    ? record.supportedProtocolVersions
    : [];
  return (
    versions.includes(2) &&
    record.maxFrameBytes === JSONL_RPC_V2_FRAME_BYTES &&
    record.maxReassembledFrameBytes === JSONL_RPC_V2_REASSEMBLED_BYTES
  );
}

function isChunkFrame(message: unknown): message is JsonlRpcChunkFrame {
  if (typeof message !== "object" || message === null) return false;
  const record = message as Record<string, unknown>;
  return (
    record.type === "rpc_chunk" &&
    typeof record.chunkId === "string" &&
    typeof record.index === "number" &&
    Number.isInteger(record.index) &&
    record.index >= 0 &&
    typeof record.count === "number" &&
    Number.isInteger(record.count) &&
    record.count > 0 &&
    typeof record.byteLength === "number" &&
    typeof record.data === "string"
  );
}

interface JsonlRpcChunkFrame {
  readonly type: "rpc_chunk";
  readonly chunkId: string;
  readonly index: number;
  readonly count: number;
  readonly byteLength: number;
  readonly data: string;
}

export interface JsonlFrameDecoderOptions {
  /** 坏帧/坏 chunk 上报；不解码、不重组、不中断。 */
  readonly onProblem?: ((problem: JsonlFrameProblem) => void) | undefined;
}

/**
 * 行缓冲 JSONL 解码器。把任意切割的文本 chunk 喂给 {@link push}，
 * 返回本次成功解码的完整帧（按序）。
 */
export class JsonlFrameDecoder {
  private readonly onProblem: ((problem: JsonlFrameProblem) => void) | undefined;
  private buffer = "";
  private readonly pendingChunks = new Map<string, PendingChunkGroup>();

  constructor(options: JsonlFrameDecoderOptions = {}) {
    this.onProblem = options.onProblem;
  }

  push(chunk: string): ReadonlyArray<unknown> {
    this.buffer += chunk;
    const frames: unknown[] = [];
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.trim().length > 0) {
        this.dispatchLine(line, frames);
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
    return frames;
  }

  /** 流结束时调用；残行仍尝试解码一次。 */
  finish(): ReadonlyArray<unknown> {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest.length === 0) return [];
    const frames: unknown[] = [];
    this.dispatchLine(rest, frames);
    return frames;
  }

  private dispatchLine(line: string, frames: ReadonlyArray<unknown>): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.report("invalid-json", line);
      return;
    }
    if (isChunkFrame(parsed)) {
      this.dispatchChunk(parsed, line, frames);
      return;
    }
    (frames as unknown[]).push(parsed);
  }

  private dispatchChunk(
    chunk: JsonlRpcChunkFrame,
    rawLine: string,
    frames: ReadonlyArray<unknown>,
  ): void {
    if (chunk.data.length > JSONL_RPC_V2_CHUNK_BYTES) {
      this.report("chunk-too-large", rawLine);
      return;
    }
    if (chunk.index >= chunk.count) {
      this.report("invalid-chunk", rawLine);
      return;
    }

    let decoded: Buffer;
    try {
      const asBuffer = Buffer.from(chunk.data, "base64");
      if (asBuffer.toString("base64").replace(/=+$/u, "") !== chunk.data.replace(/=+$/u, "")) {
        this.report("invalid-base64", rawLine);
        return;
      }
      decoded = asBuffer;
    } catch {
      this.report("invalid-base64", rawLine);
      return;
    }
    if (decoded.byteLength !== chunk.byteLength) {
      this.report("chunk-length-mismatch", rawLine);
      return;
    }

    let group = this.pendingChunks.get(chunk.chunkId);
    if (group === undefined) {
      group = { count: chunk.count, parts: new Map(), receivedBytes: 0 };
      this.pendingChunks.set(chunk.chunkId, group);
    }
    if (group.count !== chunk.count || group.parts.has(chunk.index)) {
      this.pendingChunks.delete(chunk.chunkId);
      this.report("invalid-chunk", rawLine);
      return;
    }
    group.parts.set(chunk.index, decoded);
    group.receivedBytes += decoded.byteLength;
    if (group.receivedBytes > JSONL_RPC_V2_REASSEMBLED_BYTES) {
      this.pendingChunks.delete(chunk.chunkId);
      this.report("chunk-too-large", rawLine);
      return;
    }
    if (group.parts.size < group.count) {
      return;
    }

    this.pendingChunks.delete(chunk.chunkId);
    const parts: Uint8Array[] = [];
    for (let index = 0; index < group.count; index += 1) {
      const part = group.parts.get(index);
      if (part === undefined) {
        this.report("invalid-chunk", `chunk group ${chunk.chunkId} is incomplete`);
        return;
      }
      parts.push(part);
    }
    const reassembled = Buffer.concat(parts);
    const text = reassembled.toString("utf8");
    try {
      (frames as unknown[]).push(JSON.parse(text) as unknown);
    } catch {
      this.report("invalid-chunk-payload", text.slice(0, 200));
    }
  }

  private report(kind: JsonlFrameProblemKind, detail: string): void {
    this.onProblem?.({ kind, detail: detail.slice(0, 500) });
  }
}
