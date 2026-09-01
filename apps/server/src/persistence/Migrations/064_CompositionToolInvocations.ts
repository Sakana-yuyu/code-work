import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE composition_tool_invocations (
      idempotency_key TEXT PRIMARY KEY CHECK (
        length(trim(idempotency_key)) > 0 AND length(idempotency_key) <= 512
      ),
      task_id TEXT NOT NULL CHECK (length(trim(task_id)) > 0 AND length(task_id) <= 512),
      run_id TEXT NOT NULL CHECK (length(trim(run_id)) > 0 AND length(run_id) <= 512),
      agent_id TEXT NOT NULL CHECK (length(trim(agent_id)) > 0 AND length(agent_id) <= 512),
      tool_call_id TEXT NOT NULL CHECK (
        length(trim(tool_call_id)) > 0 AND length(tool_call_id) <= 512
      ),
      canonical_tool_name TEXT NOT NULL CHECK (
        length(trim(canonical_tool_name)) > 0 AND length(canonical_tool_name) <= 256
      ),
      operation TEXT NOT NULL CHECK (
        length(trim(operation)) > 0 AND length(operation) <= 256
      ),
      arguments_digest TEXT NOT NULL CHECK (
        length(trim(arguments_digest)) > 0 AND length(arguments_digest) <= 512
      ),
      scope_digest TEXT NOT NULL CHECK (
        length(trim(scope_digest)) > 0 AND length(scope_digest) <= 512
      ),
      status TEXT NOT NULL CHECK (
        status IN ('prepared', 'executing', 'succeeded', 'failed', 'cancelled', 'unknown')
      ),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      outcome_code TEXT CHECK (
        outcome_code IS NULL OR
        (length(trim(outcome_code)) > 0 AND length(outcome_code) <= 128)
      ),
      created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
      updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= 0),
      claimed_at_unix_ms INTEGER CHECK (
        claimed_at_unix_ms IS NULL OR claimed_at_unix_ms >= 0
      ),
      finished_at_unix_ms INTEGER CHECK (
        finished_at_unix_ms IS NULL OR finished_at_unix_ms >= 0
      ),
      CHECK (updated_at_unix_ms >= created_at_unix_ms),
      CHECK (
        claimed_at_unix_ms IS NULL OR
        (claimed_at_unix_ms >= created_at_unix_ms AND claimed_at_unix_ms <= updated_at_unix_ms)
      ),
      CHECK (
        finished_at_unix_ms IS NULL OR
        (
          claimed_at_unix_ms IS NOT NULL AND
          finished_at_unix_ms >= claimed_at_unix_ms AND
          finished_at_unix_ms <= updated_at_unix_ms
        )
      ),
      CHECK (
        (
          status = 'prepared' AND revision = 1 AND outcome_code IS NULL AND
          updated_at_unix_ms = created_at_unix_ms AND
          claimed_at_unix_ms IS NULL AND finished_at_unix_ms IS NULL
        ) OR
        (
          status = 'executing' AND revision = 2 AND outcome_code IS NULL AND
          claimed_at_unix_ms IS NOT NULL AND updated_at_unix_ms = claimed_at_unix_ms AND
          finished_at_unix_ms IS NULL
        ) OR
        (
          status = 'succeeded' AND revision = 3 AND outcome_code IS NULL AND
          claimed_at_unix_ms IS NOT NULL AND finished_at_unix_ms IS NOT NULL AND
          updated_at_unix_ms = finished_at_unix_ms
        ) OR
        (
          status IN ('failed', 'cancelled', 'unknown') AND revision = 3 AND
          outcome_code IS NOT NULL AND claimed_at_unix_ms IS NOT NULL AND
          finished_at_unix_ms IS NOT NULL AND updated_at_unix_ms = finished_at_unix_ms
        )
      )
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX uq_composition_tool_invocations_run_tool_call
    ON composition_tool_invocations(run_id, tool_call_id)
  `;
  yield* sql`
    CREATE INDEX idx_composition_tool_invocations_unknown
    ON composition_tool_invocations(updated_at_unix_ms ASC, idempotency_key ASC)
    WHERE status = 'unknown'
  `;
});
