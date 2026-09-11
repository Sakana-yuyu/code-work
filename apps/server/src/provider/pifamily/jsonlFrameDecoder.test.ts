/**
 * JsonlFrameDecoder 单元测试。
 *
 * 解码器承载 pi-family 子进程的整个 stdout 入口：任意切割的 chunk、
 * CRLF、v2 chunked 重组、坏帧上报不中断。这里逐路径钉死这些约束——
 * 协议对端版本漂移时一个坏帧绝不能拖垮会话。
 *
 * @module provider/pifamily/jsonlFrameDecoder.test
 */
import { describe, expect, it } from "vite-plus/test";

import {
  JSONL_RPC_V2_CHUNK_BYTES,
  JSONL_RPC_V2_FRAME_BYTES,
  JSONL_RPC_V2_REASSEMBLED_BYTES,
  JsonlFrameDecoder,
  type JsonlFrameProblem,
  supportsJsonlRpcProtocolV2,
} from "./jsonlFrameDecoder.ts";

/** 收集 problem 的解码器工厂。 */
const makeDecoder = (): {
  readonly decoder: JsonlFrameDecoder;
  readonly problems: JsonlFrameProblem[];
} => {
  const problems: JsonlFrameProblem[] = [];
  return {
    decoder: new JsonlFrameDecoder({ onProblem: (problem) => problems.push(problem) }),
    problems,
  };
};

/** 把一个 JSON 帧编码成 v2 的 rpc_chunk 帧（按 byte 均分成 count 段）。 */
const chunkFrame = (
  payload: unknown,
  chunkId: string,
  count: number,
  overrides: Record<string, unknown> = {},
): ReadonlyArray<Record<string, unknown>> => {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  const size = Math.ceil(bytes.byteLength / count);
  const frames: Array<Record<string, unknown>> = [];
  for (let index = 0; index < count; index += 1) {
    const part = bytes.subarray(index * size, (index + 1) * size);
    frames.push({
      type: "rpc_chunk",
      chunkId,
      index,
      count,
      byteLength: part.byteLength,
      data: part.toString("base64"),
      ...overrides,
    });
  }
  return frames;
};

describe("JsonlFrameDecoder", () => {
  describe("v1 line frames", () => {
    it("buffers partial lines until a newline arrives", () => {
      const { decoder } = makeDecoder();
      expect(decoder.push('{"type":"agent_sta')).toEqual([]);
      expect(decoder.push('rt"}\n')).toEqual([{ type: "agent_start" }]);
      expect(decoder.push('{"type":"turn_start"}')).toEqual([]);
      expect(decoder.push("\n")).toEqual([{ type: "turn_start" }]);
    });

    it("decodes multiple frames split across arbitrary chunk boundaries", () => {
      const { decoder } = makeDecoder();
      const wire = '{"type":"agent_start"}\n{"type":"turn_start"}\n{"type":"agent_settled"}\n';
      const frames: unknown[] = [];
      // 按 3 字节一模拟任意切割的 TCP/stdio chunk。
      for (let offset = 0; offset < wire.length; offset += 3) {
        frames.push(...decoder.push(wire.slice(offset, offset + 3)));
      }
      expect(frames).toEqual([
        { type: "agent_start" },
        { type: "turn_start" },
        { type: "agent_settled" },
      ]);
    });

    it("strips trailing \\r from CRLF lines and skips blank lines", () => {
      const { decoder } = makeDecoder();
      expect(decoder.push('{"type":"agent_start"}\r\n\r\n{"type":"turn_start"}\r\n')).toEqual([
        { type: "agent_start" },
        { type: "turn_start" },
      ]);
    });

    it("finish() decodes a trailing frame without a newline", () => {
      const { decoder } = makeDecoder();
      // 第二帧 JSON 完整但缺换行——finish() 仍要解码一次。
      expect(decoder.push('{"type":"agent_start"}\n{"type":"turn_start"}')).toEqual([
        { type: "agent_start" },
      ]);
      expect(decoder.finish()).toEqual([{ type: "turn_start" }]);
      expect(decoder.finish()).toEqual([]);
    });

    it("reports invalid json and keeps decoding subsequent frames", () => {
      const { decoder, problems } = makeDecoder();
      expect(decoder.push('not-json\n{"type":"agent_start"}\n')).toEqual([{ type: "agent_start" }]);
      expect(problems.map((problem) => problem.kind)).toEqual(["invalid-json"]);
      expect(problems[0]?.detail).toBe("not-json");
    });
  });

  describe("v2 chunk reassembly", () => {
    it("reassembles a >1KiB frame split into 3 base64 chunks", () => {
      const { decoder, problems } = makeDecoder();
      const payload = {
        type: "message_update",
        text: "x".repeat(1200),
      };
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(1024);
      const [first, second, third] = chunkFrame(payload, "chunk-1", 3);
      if (first === undefined || second === undefined || third === undefined) {
        throw new Error("chunk fixture incomplete");
      }
      expect(decoder.push(`${JSON.stringify(first)}\n`)).toEqual([]);
      expect(decoder.push(`${JSON.stringify(second)}\n`)).toEqual([]);
      // 最后一个 chunk 到齐后同步返回重组帧。
      expect(decoder.push(`${JSON.stringify(third)}\n`)).toEqual([payload]);
      expect(problems).toEqual([]);
    });

    it("reassembles chunks delivered out of order", () => {
      const { decoder } = makeDecoder();
      const payload = { type: "big_frame", pad: "y".repeat(900) };
      const [index0, index1, index2] = chunkFrame(payload, "chunk-ooo", 3);
      if (index0 === undefined || index1 === undefined || index2 === undefined) {
        throw new Error("chunk fixture incomplete");
      }
      expect(decoder.push(`${JSON.stringify(index1)}\n`)).toEqual([]);
      expect(decoder.push(`${JSON.stringify(index2)}\n`)).toEqual([]);
      expect(decoder.push(`${JSON.stringify(index0)}\n`)).toEqual([payload]);
    });

    it("interleaves plain frames around an in-flight chunk group", () => {
      const { decoder } = makeDecoder();
      const payload = { type: "big_frame", pad: "z".repeat(800) };
      const [first, , third] = chunkFrame(payload, "chunk-mix", 3);
      if (first === undefined || third === undefined) throw new Error("chunk fixture incomplete");
      const [, second] = chunkFrame(payload, "chunk-mix", 3);
      if (second === undefined) throw new Error("chunk fixture incomplete");
      expect(decoder.push(`${JSON.stringify(first)}\n{"type":"agent_start"}\n`)).toEqual([
        { type: "agent_start" },
      ]);
      expect(decoder.push(`${JSON.stringify(third)}\n`)).toEqual([]);
      expect(decoder.push(`${JSON.stringify(second)}\n`)).toEqual([payload]);
    });

    it("reports chunk-length-mismatch and drops the chunk", () => {
      const { decoder, problems } = makeDecoder();
      const bytes = Buffer.from(JSON.stringify({ type: "big" }), "utf8");
      const frame = {
        type: "rpc_chunk",
        chunkId: "chunk-bad",
        index: 0,
        count: 1,
        byteLength: bytes.byteLength + 5,
        data: bytes.toString("base64"),
      };
      expect(decoder.push(`${JSON.stringify(frame)}\n`)).toEqual([]);
      expect(problems.map((problem) => problem.kind)).toEqual(["chunk-length-mismatch"]);
    });

    it("reports invalid-base64 and drops the chunk", () => {
      const { decoder, problems } = makeDecoder();
      const frame = {
        type: "rpc_chunk",
        chunkId: "chunk-b64",
        index: 0,
        count: 1,
        byteLength: 4,
        data: "!!!!not-base64!!!!",
      };
      expect(decoder.push(`${JSON.stringify(frame)}\n`)).toEqual([]);
      expect(problems.map((problem) => problem.kind)).toEqual(["invalid-base64"]);
    });

    it("reports invalid-chunk for index >= count and duplicate indexes", () => {
      const { decoder, problems } = makeDecoder();
      const outOfRange = {
        type: "rpc_chunk",
        chunkId: "chunk-idx",
        index: 2,
        count: 2,
        byteLength: 4,
        data: Buffer.from("abcd").toString("base64"),
      };
      expect(decoder.push(`${JSON.stringify(outOfRange)}\n`)).toEqual([]);

      const [first, second] = chunkFrame({ type: "big", pad: "p".repeat(700) }, "chunk-dup", 2);
      if (first === undefined || second === undefined) throw new Error("chunk fixture incomplete");
      expect(decoder.push(`${JSON.stringify(first)}\n`)).toEqual([]);
      expect(decoder.push(`${JSON.stringify(first)}\n`)).toEqual([]);
      // 组已被丢弃：补上第二段也无法重组。
      expect(decoder.push(`${JSON.stringify(second)}\n`)).toEqual([]);

      expect(problems.map((problem) => problem.kind)).toEqual(["invalid-chunk", "invalid-chunk"]);
    });

    it("reports invalid-chunk when counts disagree within one group", () => {
      const { decoder, problems } = makeDecoder();
      const payload = { type: "big", pad: "q".repeat(700) };
      const [first] = chunkFrame(payload, "chunk-count", 2);
      const [asSingle] = chunkFrame(payload, "chunk-count", 1);
      if (first === undefined || asSingle === undefined)
        throw new Error("chunk fixture incomplete");
      expect(decoder.push(`${JSON.stringify(first)}\n`)).toEqual([]);
      expect(decoder.push(`${JSON.stringify(asSingle)}\n`)).toEqual([]);
      expect(problems.map((problem) => problem.kind)).toEqual(["invalid-chunk"]);
    });

    it("reports chunk-too-large for oversized chunk payloads", () => {
      const { decoder, problems } = makeDecoder();
      const frame = {
        type: "rpc_chunk",
        chunkId: "chunk-huge",
        index: 0,
        count: 1,
        byteLength: 8,
        // base64 文本超过 256 KiB 上限（在解码 base64 之前就拒绝）。
        data: "A".repeat(JSONL_RPC_V2_CHUNK_BYTES + 1),
      };
      expect(decoder.push(`${JSON.stringify(frame)}\n`)).toEqual([]);
      expect(problems.map((problem) => problem.kind)).toEqual(["chunk-too-large"]);
      // 64MiB 重组上限路径不在这里单测：单 chunk ≤256KiB base64（≈192KiB
      // 载荷），触发重组上限需要 340+ chunk / 80MB+ 的 fixture，得不偿失。
      expect(JSONL_RPC_V2_REASSEMBLED_BYTES).toBe(64 * 1024 * 1024);
    });

    it("reports invalid-chunk-payload when the reassembled bytes are not JSON", () => {
      const { decoder, problems } = makeDecoder();
      const raw = Buffer.from("definitely-not-json", "utf8");
      const frame = {
        type: "rpc_chunk",
        chunkId: "chunk-raw",
        index: 0,
        count: 1,
        byteLength: raw.byteLength,
        data: raw.toString("base64"),
      };
      expect(decoder.push(`${JSON.stringify(frame)}\n`)).toEqual([]);
      expect(problems.map((problem) => problem.kind)).toEqual(["invalid-chunk-payload"]);
    });
  });

  describe("supportsJsonlRpcProtocolV2", () => {
    it("accepts the canonical OMP ready frame", () => {
      expect(
        supportsJsonlRpcProtocolV2({
          type: "ready",
          supportedProtocolVersions: [1, 2],
          maxFrameBytes: JSONL_RPC_V2_FRAME_BYTES,
          maxReassembledFrameBytes: JSONL_RPC_V2_REASSEMBLED_BYTES,
        }),
      ).toBe(true);
    });

    it("rejects v1-only ready frames and mismatched limits", () => {
      expect(
        supportsJsonlRpcProtocolV2({
          type: "ready",
          supportedProtocolVersions: [1],
          maxFrameBytes: JSONL_RPC_V2_FRAME_BYTES,
          maxReassembledFrameBytes: JSONL_RPC_V2_REASSEMBLED_BYTES,
        }),
      ).toBe(false);
      expect(
        supportsJsonlRpcProtocolV2({
          type: "ready",
          supportedProtocolVersions: [2],
          maxFrameBytes: 512 * 1024,
          maxReassembledFrameBytes: JSONL_RPC_V2_REASSEMBLED_BYTES,
        }),
      ).toBe(false);
      expect(
        supportsJsonlRpcProtocolV2({
          type: "agent_start",
          supportedProtocolVersions: [2],
          maxFrameBytes: JSONL_RPC_V2_FRAME_BYTES,
          maxReassembledFrameBytes: JSONL_RPC_V2_REASSEMBLED_BYTES,
        }),
      ).toBe(false);
      expect(supportsJsonlRpcProtocolV2(null)).toBe(false);
      expect(supportsJsonlRpcProtocolV2("ready")).toBe(false);
    });
  });
});
