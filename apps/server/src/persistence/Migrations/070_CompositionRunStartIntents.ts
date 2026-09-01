import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE composition_run_start_intents (
      run_id TEXT PRIMARY KEY CHECK (length(trim(run_id)) > 0 AND length(run_id) <= 512),
      task_id TEXT NOT NULL CHECK (length(trim(task_id)) > 0 AND length(task_id) <= 512),
      previous_run_id TEXT CHECK (
        previous_run_id IS NULL OR
        (length(trim(previous_run_id)) > 0 AND length(previous_run_id) <= 512)
      ),
      agent_id TEXT NOT NULL CHECK (length(trim(agent_id)) > 0 AND length(agent_id) <= 512),
      runtime_id TEXT NOT NULL CHECK (length(trim(runtime_id)) > 0 AND length(runtime_id) <= 512),
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      payload_digest TEXT NOT NULL CHECK (
        length(trim(payload_digest)) > 0 AND length(payload_digest) <= 512
      ),
      capability_digest TEXT NOT NULL CHECK (
        length(trim(capability_digest)) > 0 AND length(capability_digest) <= 512
      ),
      state TEXT NOT NULL CHECK (
        state IN ('prepared', 'preparing', 'dispatching', 'accepted', 'settled', 'quarantined')
      ),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      claim_id TEXT CHECK (
        claim_id IS NULL OR (length(trim(claim_id)) > 0 AND length(claim_id) <= 512)
      ),
      runtime_task_id TEXT CHECK (
        runtime_task_id IS NULL OR
        (length(trim(runtime_task_id)) > 0 AND length(runtime_task_id) <= 1024)
      ),
      capability_handshake_id TEXT CHECK (
        capability_handshake_id IS NULL OR
        (length(trim(capability_handshake_id)) > 0 AND length(capability_handshake_id) <= 1024)
      ),
      outcome_code TEXT CHECK (
        outcome_code IS NULL OR
        (length(trim(outcome_code)) > 0 AND length(outcome_code) <= 128)
      ),
      outcome_detail TEXT CHECK (
        outcome_detail IS NULL OR
        (length(trim(outcome_detail)) > 0 AND length(outcome_detail) <= 1024)
      ),
      created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
      updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= 0),
      CHECK (updated_at_unix_ms >= created_at_unix_ms),
      CHECK (
        (
          state = 'prepared' AND claim_id IS NULL AND runtime_task_id IS NULL AND
          capability_handshake_id IS NULL AND outcome_code IS NULL AND outcome_detail IS NULL
        ) OR
        (
          state IN ('preparing', 'dispatching') AND claim_id IS NOT NULL AND
          runtime_task_id IS NULL AND capability_handshake_id IS NULL AND
          outcome_code IS NULL AND outcome_detail IS NULL
        ) OR
        (
          state = 'accepted' AND claim_id IS NULL AND
          outcome_code IS NULL AND outcome_detail IS NULL
        ) OR
        (state = 'settled' AND claim_id IS NULL) OR
        (
          state = 'quarantined' AND claim_id IS NULL AND outcome_code IS NOT NULL
        )
      )
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX uq_composition_run_start_task_attempt
    ON composition_run_start_intents(task_id, attempt)
  `;
  yield* sql`
    CREATE INDEX idx_composition_run_start_recoverable
    ON composition_run_start_intents(updated_at_unix_ms ASC, run_id ASC)
    WHERE state IN ('prepared', 'preparing', 'dispatching', 'accepted')
  `;
});
