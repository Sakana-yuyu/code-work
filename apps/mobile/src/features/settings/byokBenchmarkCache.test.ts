import { describe, expect, it } from "vite-plus/test";

import { decodeByokBenchmarkCache } from "./byokBenchmarkCache.logic";

const result = {
  adapterId: "adapter-1",
  modelId: "model-a",
  firstTokenMs: 10,
  firstResponseMs: 10,
  totalMs: 100,
  outputTokens: 42,
  tokensEstimated: false,
  visibleTokensPerSecond: 400,
  tokensPerSecond: 466.67,
};

describe("移动端 BYOK 测速缓存", () => {
  it("读取带指纹的有效测速结果", () => {
    expect(
      decodeByokBenchmarkCache(JSON.stringify({ "adapter-1": { fingerprint: "fp", result } })),
    ).toEqual({ "adapter-1": { fingerprint: "fp", result } });
  });

  it("忽略损坏 JSON、负数和缺少必要字段的缓存项", () => {
    expect(decodeByokBenchmarkCache("{broken")).toEqual({});
    expect(
      decodeByokBenchmarkCache(
        JSON.stringify({
          negative: { fingerprint: "fp", result: { ...result, totalMs: -1 } },
          incomplete: { fingerprint: "fp", result: { adapterId: "adapter-2" } },
        }),
      ),
    ).toEqual({});
  });
});
