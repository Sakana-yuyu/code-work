// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";

import { listTranscriptFiles, readTranscriptRecords } from "./usageTranscriptReader.ts";
import {
  appendByokUsageRecord,
  byokUsageLogFilePath,
  byokUsageMonthKey,
  serializeByokUsageLogRecord,
} from "./byokUsageLog.ts";

describe("byokUsageMonthKey", () => {
  it("formats UTC year-month for monthly rotation", () => {
    expect(byokUsageMonthKey(Date.UTC(2026, 8, 20, 15))).toBe("2026-09");
  });
});

describe("byokUsageLogFilePath", () => {
  it("nests monthly files under the state directory", () => {
    expect(byokUsageLogFilePath("/state", Date.UTC(2026, 8, 1))).toBe(
      NodePath.join("/state", "usage", "byok-usage-2026-09.jsonl"),
    );
  });
});

describe("serializeByokUsageLogRecord", () => {
  it("emits one self-describing JSONL line", () => {
    const line = serializeByokUsageLogRecord({
      type: "byok_model_usage",
      timestampMs: 1,
      threadId: "t",
      model: "m",
      inputTokens: 2,
      cachedInputTokens: 0,
      outputTokens: 3,
      reasoningTokens: 0,
    });
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toMatchObject({ type: "byok_model_usage", model: "m" });
  });
});

describe("appendByokUsageRecord", () => {
  const stateDir = NodePath.join(NodeOS.tmpdir(), "byok-usage-log-test");

  afterAll(async () => {
    await NodeFSP.rm(stateDir, { recursive: true, force: true });
  });

  it("appends records the usage scan reads back as byok records", async () => {
    // Fire-and-forget for the adapter, but the returned chain promise lets
    // tests drain the appends without sleeping.
    await appendByokUsageRecord(stateDir, {
      type: "byok_model_usage",
      timestampMs: Date.UTC(2026, 8, 20, 12),
      threadId: "thread-1",
      model: "deepseek-chat",
      inputTokens: 12000,
      cachedInputTokens: 4000,
      outputTokens: 800,
      reasoningTokens: 300,
    });
    await appendByokUsageRecord(stateDir, {
      type: "byok_model_usage",
      timestampMs: Date.UTC(2026, 8, 20, 13),
      threadId: "thread-1",
      model: "deepseek-chat",
      inputTokens: 600,
      cachedInputTokens: 0,
      outputTokens: 40,
      reasoningTokens: 0,
    });
    await appendByokUsageRecord(stateDir, {
      type: "byok_model_usage",
      timestampMs: Date.UTC(2026, 8, 20, 14),
      threadId: "thread-1",
      model: "deepseek-chat",
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
    });

    const dir = NodePath.join(stateDir, "usage");
    const files = await listTranscriptFiles(dir, 0, { filePrefix: "byok-usage-" });
    expect(files).toHaveLength(1);

    const records = await readTranscriptRecords(files[0]!.path, "byok");
    expect(records).toHaveLength(3);
    expect(records?.[0]).toMatchObject({
      provider: "byok",
      model: "deepseek-chat",
      sessionId: "thread-1",
    });
    expect(records?.[0]?.totals.uncachedInputTokens).toBe(8000);
  });
});
