// @effect-diagnostics globalDate:off -- UTC month keys for rotation, not wall-clock reads.
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Append-only usage log for the built-in BYOK engine.
 *
 * The usage page scans the provider CLIs' own transcripts; BYOK is in-process
 * and writes none, so every completed model response appends one
 * self-describing JSONL line here. Files rotate monthly under
 * `<stateDir>/usage/` so a warm scan only reparses the current month, and the
 * scan reads them back through the same reader pipeline as the CLIs' files.
 *
 * Fire-and-forget by design: a usage logging failure must never fail a turn,
 * so appends are serialized on a module-level promise chain and errors are
 * swallowed. The scan side owns the raw-`node:fs` isolation in
 * `usageTranscriptReader`; this module only writes.
 *
 * @module byokUsageLog
 */
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

export const BYOK_USAGE_DIRNAME = "usage";
export const BYOK_USAGE_FILE_PREFIX = "byok-usage-";

export interface ByokUsageLogRecord {
  readonly type: "byok_model_usage";
  readonly timestampMs: number;
  /** Thread the response belongs to; becomes the record's session id. */
  readonly threadId: string;
  readonly model: string;
  /** Total input tokens, inclusive of the cached portion (OpenAI style). */
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  /** Subset of `outputTokens`, never added on top. */
  readonly reasoningTokens: number;
}

/** `YYYY-MM` in UTC; a rotation boundary needs no time-zone precision. */
export function byokUsageMonthKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 7);
}

export function byokUsageLogFilePath(stateDir: string, timestampMs: number): string {
  return NodePath.join(
    stateDir,
    BYOK_USAGE_DIRNAME,
    `${BYOK_USAGE_FILE_PREFIX}${byokUsageMonthKey(timestampMs)}.jsonl`,
  );
}

export function serializeByokUsageLogRecord(record: ByokUsageLogRecord): string {
  return `${JSON.stringify(record)}\n`;
}

let appendChain: Promise<void> = Promise.resolve();

/**
 * Queues one record for append and returns the tail of the append chain.
 *
 * Fire-and-forget for callers (the turn never awaits it), but the promise is
 * returned so tests can drain the chain instead of sleeping. A failed append
 * drops that record's usage from the page rather than surfacing an error.
 */
export function appendByokUsageRecord(stateDir: string, record: ByokUsageLogRecord): Promise<void> {
  const filePath = byokUsageLogFilePath(stateDir, record.timestampMs);
  const line = serializeByokUsageLogRecord(record);
  // Serialized so concurrent model responses cannot interleave partial lines.
  appendChain = appendChain
    .then(() =>
      NodeFS.mkdir(NodePath.dirname(filePath), { recursive: true }).then(() =>
        NodeFS.appendFile(filePath, line, "utf8"),
      ),
    )
    .catch(() => {
      // Best-effort log: the turn that produced this usage keeps running.
    });
  return appendChain;
}
