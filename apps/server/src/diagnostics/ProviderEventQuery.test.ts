// @effect-diagnostics nodeBuiltinImport:off
import type { ProviderEventQueryInput } from "@codework/contracts";
import { ThreadId } from "@codework/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { parseProviderEventLogFile, readProviderEvents } from "./ProviderEventQuery.ts";

const canonicalLine = (eventId: string, usedTokens: number) =>
  `[2026-09-07T00:00:00.000Z] CANON: ${JSON.stringify({
    type: "thread.token-usage.updated",
    eventId,
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    requestId: "req-1",
    payload: { usage: { usedTokens } },
  })}`;

const nativeLineWithSecret = `[2026-09-07T00:00:01.000Z] NTIVE: ${JSON.stringify({
  type: "provider.request.failed",
  headers: { Authorization: "Bearer sk-secret", "X-Api-Key": "sk-123" },
  apiKey: "sk-plain",
  tokensUsed: 42,
})}`;

const makeInput = (overrides?: Partial<ProviderEventQueryInput>): ProviderEventQueryInput => ({
  threadId: ThreadId.make("thread-1"),
  ...overrides,
});

describe("parseProviderEventLogFile", () => {
  it("returns the newest entries in chronological order", () => {
    const text = [
      canonicalLine("evt-1", 100),
      canonicalLine("evt-2", 200),
      "not a log line",
      canonicalLine("evt-3", 300),
      "",
    ].join("\n");
    const parsed = parseProviderEventLogFile(text, undefined, 2);
    assert.deepEqual(
      parsed.entries.map((entry) => entry.entry.eventId),
      ["evt-2", "evt-3"],
    );
    assert.isTrue(parsed.truncated);
  });

  it("filters by stream label", () => {
    const text = [canonicalLine("evt-1", 100), nativeLineWithSecret].join("\n");
    const parsed = parseProviderEventLogFile(text, "native", 10);
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.entries[0]?.stream, "native");
  });

  it("redacts sensitive keys while keeping counters", () => {
    const parsed = parseProviderEventLogFile(nativeLineWithSecret, undefined, 10);
    const event = parsed.entries[0]?.entry.event as Record<string, unknown>;
    const headers = event.headers as Record<string, unknown>;
    assert.equal(headers.Authorization, "[REDACTED]");
    assert.equal(headers["X-Api-Key"], "[REDACTED]");
    assert.equal(event.apiKey, "[REDACTED]");
    assert.equal(event.tokensUsed, 42);
  });
});

describe("readProviderEvents", () => {
  const provide = Layer.mergeAll(NodeServices.layer);

  it("reads the thread log across rotated files with a limit", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-events-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
      );
      NodeFS.writeFileSync(
        NodePath.join(dir, "events.thread-1.1.log"),
        [canonicalLine("evt-old-1", 10), canonicalLine("evt-old-2", 20)].join("\n"),
      );
      NodeFS.writeFileSync(
        NodePath.join(dir, "events.thread-1.log"),
        [canonicalLine("evt-new-1", 30), canonicalLine("evt-new-2", 40)].join("\n"),
      );
      const result = yield* readProviderEvents({ providerLogsDir: dir })(makeInput({ limit: 3 }));
      assert.equal(result.threadSegment, "thread-1");
      assert.deepEqual(result.scannedFileNames, ["events.thread-1.log", "events.thread-1.1.log"]);
      assert.deepEqual(
        result.events.map((entry) => entry.eventId),
        ["evt-new-2", "evt-new-1", "evt-old-2"],
      );
      assert.isTrue(result.truncated);
    }).pipe(Effect.provide(provide)));

  it("returns an empty result when the thread has no log", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-events-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
      );
      const result = yield* readProviderEvents({ providerLogsDir: dir })(makeInput());
      assert.deepEqual(result.events, []);
      assert.deepEqual(result.scannedFileNames, []);
      assert.isFalse(result.truncated);
    }).pipe(Effect.provide(provide)));
});
