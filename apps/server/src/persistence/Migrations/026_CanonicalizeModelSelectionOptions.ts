import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Canonicalize `modelSelection.options` / `defaultModelSelection.options` from
 * the legacy object shape (`{ effort: "max", fastMode: true, ... }`) to the
 * current array-of-selections shape (`[{ id: "effort", value: "max" }, ...]`).
 *
 * Migration 016 introduced `modelSelection` with `options` stored as a
 * per-provider object. Later the schema was reshaped so that options are a
 * generic `Array<{ id, value }>` of user-selected option entries. Stored rows
 * from before the reshape still have the object shape and fail to decode.
 *
 * For each value in the legacy object:
 *   - string values are kept if non-empty after trim
 *   - boolean values are always kept (true | false)
 *   - any other value type (number, null, nested object/array) is dropped,
 *     matching the permissive client-side normalizer in composerDraftStore.
 *
 * The rewrite happens in JavaScript and writes the whole JSON column back as
 * a bound parameter. An earlier version nested `json_group_array` inside a
 * scalar subquery of `json_set`, which silently double-encoded the array as a
 * JSON string on SQLite builds whose subtype propagation loses the JSON flag
 * through subqueries (the bundled SQLite differs per node:sqlite release).
 * Only `json_type` remains in SQL: it is a plain read predicate with no
 * subtype involvement and has been stable across every SQLite we ship against.
 *
 * Touched storage:
 *   - `projection_threads.model_selection_json.options`
 *   - `projection_projects.default_model_selection_json.options`
 *   - `orchestration_events.payload_json.$.modelSelection.options`
 *     (thread.created | thread.meta-updated | thread.turn-start-requested)
 *   - `orchestration_events.payload_json.$.defaultModelSelection.options`
 *     (project.created | project.meta-updated)
 */

interface CanonicalOption {
  readonly id: string;
  readonly value: string | boolean;
}

/** Legacy object → array of scalar selections; non-objects return undefined (row left untouched). */
const canonicalizeOptions = (options: unknown): ReadonlyArray<CanonicalOption> | undefined => {
  if (options === null || typeof options !== "object" || Array.isArray(options)) return undefined;
  const canonical: Array<CanonicalOption> = [];
  for (const [id, value] of Object.entries(options as Record<string, unknown>)) {
    // 与 SQL 语义一致：文本按 trim 后非空保留（值本身不裁剪），布尔全保留，其余丢弃。
    if (typeof value === "string") {
      if (value.trim() !== "") canonical.push({ id, value });
    } else if (typeof value === "boolean") {
      canonical.push({ id, value });
    }
  }
  return canonical;
};

const parseJsonObject = (text: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    // 损坏的 JSON 行跳过不写回——宁可保守也别让整个迁移失败。
    return undefined;
  }
};

const rewriteSelectionJson = (text: string): string | undefined => {
  const record = parseJsonObject(text);
  if (record === undefined) return undefined;
  const canonical = canonicalizeOptions(record.options);
  if (canonical === undefined) return undefined;
  return JSON.stringify({ ...record, options: canonical });
};

const rewriteEventPayloadJson = (
  text: string,
  path: "modelSelection" | "defaultModelSelection",
): string | undefined => {
  const record = parseJsonObject(text);
  if (record === undefined) return undefined;
  const container = record[path];
  if (container === null || typeof container !== "object" || Array.isArray(container)) {
    return undefined;
  }
  const canonical = canonicalizeOptions((container as Record<string, unknown>).options);
  if (canonical === undefined) return undefined;
  return JSON.stringify({
    ...record,
    [path]: { ...(container as Record<string, unknown>), options: canonical },
  });
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadRows = yield* sql<{ readonly threadId: string; readonly selectionJson: string }>`
    SELECT thread_id AS "threadId", model_selection_json AS "selectionJson"
    FROM projection_threads
    WHERE model_selection_json IS NOT NULL
      AND json_type(model_selection_json, '$.options') = 'object'
  `;
  yield* Effect.forEach(
    threadRows,
    (row) => {
      const next = rewriteSelectionJson(row.selectionJson);
      return next === undefined
        ? Effect.void
        : sql`
            UPDATE projection_threads
            SET model_selection_json = ${next}
            WHERE thread_id = ${row.threadId}
          `;
    },
    { concurrency: 1 },
  );

  const projectRows = yield* sql<{ readonly projectId: string; readonly selectionJson: string }>`
    SELECT project_id AS "projectId", default_model_selection_json AS "selectionJson"
    FROM projection_projects
    WHERE default_model_selection_json IS NOT NULL
      AND json_type(default_model_selection_json, '$.options') = 'object'
  `;
  yield* Effect.forEach(
    projectRows,
    (row) => {
      const next = rewriteSelectionJson(row.selectionJson);
      return next === undefined
        ? Effect.void
        : sql`
            UPDATE projection_projects
            SET default_model_selection_json = ${next}
            WHERE project_id = ${row.projectId}
          `;
    },
    { concurrency: 1 },
  );

  const threadEventRows = yield* sql<{
    readonly eventId: string;
    readonly payloadJson: string;
  }>`
    SELECT event_id AS "eventId", payload_json AS "payloadJson"
    FROM orchestration_events
    WHERE event_type IN (
      'thread.created',
      'thread.meta-updated',
      'thread.turn-start-requested'
    )
      AND json_type(payload_json, '$.modelSelection.options') = 'object'
  `;
  yield* Effect.forEach(
    threadEventRows,
    (row) => {
      const next = rewriteEventPayloadJson(row.payloadJson, "modelSelection");
      return next === undefined
        ? Effect.void
        : sql`
            UPDATE orchestration_events
            SET payload_json = ${next}
            WHERE event_id = ${row.eventId}
          `;
    },
    { concurrency: 1 },
  );

  const projectEventRows = yield* sql<{
    readonly eventId: string;
    readonly payloadJson: string;
  }>`
    SELECT event_id AS "eventId", payload_json AS "payloadJson"
    FROM orchestration_events
    WHERE event_type IN ('project.created', 'project.meta-updated')
      AND json_type(payload_json, '$.defaultModelSelection.options') = 'object'
  `;
  yield* Effect.forEach(
    projectEventRows,
    (row) => {
      const next = rewriteEventPayloadJson(row.payloadJson, "defaultModelSelection");
      return next === undefined
        ? Effect.void
        : sql`
            UPDATE orchestration_events
            SET payload_json = ${next}
            WHERE event_id = ${row.eventId}
          `;
    },
    { concurrency: 1 },
  );
});
