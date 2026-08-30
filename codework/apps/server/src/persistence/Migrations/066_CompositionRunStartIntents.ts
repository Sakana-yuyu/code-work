import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE composition_run_start_intents (
      run_id TEXT PRIMARY KEY CHECK (length(trim(run_id)) > 0 AND length(run_id) <= 512),
      task_id TEXT NOT NULL CHECK (length(trim(task_id)) > 0 AND length(task_id) <= 512),
      agent_id TEXT NOT NULL CHECK (length(trim(agent_id)) > 0 AND length(agent_id) <= 512),
      runtime_id TEXT NOT NULL CHECK (length(trim(runtime_id)) > 0 AND length(runtime_id) <= 512),
      attempt INTEGER NOT NULL CHECK (
        typeof(attempt) = 'integer' AND attempt > 0 AND attempt <= 9007199254740991
      ),
      payload_digest TEXT NOT NULL CHECK (
        length(payload_digest) = 71 AND substr(payload_digest, 1, 7) = 'sha256:' AND
        substr(payload_digest, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      capability_digest TEXT NOT NULL CHECK (
        length(capability_digest) = 71 AND substr(capability_digest, 1, 7) = 'sha256:' AND
        substr(capability_digest, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      state TEXT NOT NULL CHECK (
        state IN ('prepared', 'dispatching', 'accepted', 'settled', 'indeterminate')
      ),
      revision INTEGER NOT NULL CHECK (
        typeof(revision) = 'integer' AND revision > 0 AND revision <= 9007199254740991
      ),
      claim_id TEXT CHECK (
        claim_id IS NULL OR (length(trim(claim_id)) > 0 AND length(claim_id) <= 512)
      ),
      claimed_at_unix_ms INTEGER CHECK (
        claimed_at_unix_ms IS NULL OR (
          typeof(claimed_at_unix_ms) = 'integer' AND
          claimed_at_unix_ms >= 0 AND claimed_at_unix_ms <= 9007199254740991
        )
      ),
      last_release_claim_id TEXT CHECK (
        last_release_claim_id IS NULL OR
        (length(trim(last_release_claim_id)) > 0 AND length(last_release_claim_id) <= 512)
      ),
      last_release_operation_id TEXT CHECK (
        last_release_operation_id IS NULL OR
        (
          length(trim(last_release_operation_id)) > 0 AND
          length(last_release_operation_id) <= 512
        )
      ),
      last_released_at_unix_ms INTEGER CHECK (
        last_released_at_unix_ms IS NULL OR (
          typeof(last_released_at_unix_ms) = 'integer' AND
          last_released_at_unix_ms >= 0 AND last_released_at_unix_ms <= 9007199254740991
        )
      ),
      runtime_task_id TEXT CHECK (
        runtime_task_id IS NULL OR
        (length(trim(runtime_task_id)) > 0 AND length(runtime_task_id) <= 2048)
      ),
      capability_handshake_id TEXT CHECK (
        capability_handshake_id IS NULL OR
        (
          length(trim(capability_handshake_id)) > 0 AND
          length(capability_handshake_id) <= 2048
        )
      ),
      accepted_at_unix_ms INTEGER CHECK (
        accepted_at_unix_ms IS NULL OR (
          typeof(accepted_at_unix_ms) = 'integer' AND
          accepted_at_unix_ms >= 0 AND accepted_at_unix_ms <= 9007199254740991
        )
      ),
      outcome_code TEXT CHECK (
        outcome_code IS NULL OR
        (length(trim(outcome_code)) > 0 AND length(outcome_code) <= 128)
      ),
      settled_at_unix_ms INTEGER CHECK (
        settled_at_unix_ms IS NULL OR (
          typeof(settled_at_unix_ms) = 'integer' AND
          settled_at_unix_ms >= 0 AND settled_at_unix_ms <= 9007199254740991
        )
      ),
      created_at_unix_ms INTEGER NOT NULL CHECK (
        typeof(created_at_unix_ms) = 'integer' AND
        created_at_unix_ms >= 0 AND created_at_unix_ms <= 9007199254740991
      ),
      updated_at_unix_ms INTEGER NOT NULL CHECK (
        typeof(updated_at_unix_ms) = 'integer' AND
        updated_at_unix_ms >= created_at_unix_ms AND updated_at_unix_ms <= 9007199254740991
      ),
      CHECK (
        claimed_at_unix_ms IS NULL OR claimed_at_unix_ms >= created_at_unix_ms
      ),
      CHECK (
        (
          last_release_claim_id IS NULL AND
          last_release_operation_id IS NULL AND last_released_at_unix_ms IS NULL
        ) OR
        (
          last_release_claim_id IS NOT NULL AND
          last_release_operation_id IS NOT NULL AND last_released_at_unix_ms IS NOT NULL AND
          last_released_at_unix_ms >= created_at_unix_ms
        )
      ),
      CHECK (
        accepted_at_unix_ms IS NULL OR
        (claimed_at_unix_ms IS NOT NULL AND accepted_at_unix_ms >= claimed_at_unix_ms)
      ),
      CHECK (
        settled_at_unix_ms IS NULL OR
        (accepted_at_unix_ms IS NOT NULL AND settled_at_unix_ms >= accepted_at_unix_ms)
      ),
      CHECK (
        updated_at_unix_ms >= COALESCE(claimed_at_unix_ms, created_at_unix_ms)
      ),
      CHECK (
        updated_at_unix_ms >= COALESCE(last_released_at_unix_ms, created_at_unix_ms)
      ),
      CHECK (
        updated_at_unix_ms >= COALESCE(accepted_at_unix_ms, created_at_unix_ms)
      ),
      CHECK (
        updated_at_unix_ms >= COALESCE(settled_at_unix_ms, created_at_unix_ms)
      ),
      CHECK (
        (
          state = 'prepared' AND
          claim_id IS NULL AND claimed_at_unix_ms IS NULL AND
          runtime_task_id IS NULL AND capability_handshake_id IS NULL AND
          accepted_at_unix_ms IS NULL AND outcome_code IS NULL AND settled_at_unix_ms IS NULL
        ) OR (
          state = 'dispatching' AND
          claim_id IS NOT NULL AND claimed_at_unix_ms IS NOT NULL AND
          runtime_task_id IS NULL AND capability_handshake_id IS NULL AND
          accepted_at_unix_ms IS NULL AND outcome_code IS NULL AND settled_at_unix_ms IS NULL
        ) OR (
          state = 'accepted' AND
          claim_id IS NOT NULL AND claimed_at_unix_ms IS NOT NULL AND
          accepted_at_unix_ms IS NOT NULL AND outcome_code IS NULL AND settled_at_unix_ms IS NULL
        ) OR (
          state = 'settled' AND
          claim_id IS NOT NULL AND claimed_at_unix_ms IS NOT NULL AND
          accepted_at_unix_ms IS NOT NULL AND outcome_code IS NULL AND settled_at_unix_ms IS NOT NULL
        ) OR (
          state = 'indeterminate' AND
          claim_id IS NOT NULL AND claimed_at_unix_ms IS NOT NULL AND
          runtime_task_id IS NULL AND capability_handshake_id IS NULL AND
          accepted_at_unix_ms IS NULL AND outcome_code IS NOT NULL AND settled_at_unix_ms IS NULL
        )
      )
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX composition_run_start_intents_task_attempt_unique
    ON composition_run_start_intents(task_id, attempt)
  `;
  yield* sql`
    CREATE UNIQUE INDEX composition_run_start_intents_claim_id_unique
    ON composition_run_start_intents(claim_id)
    WHERE claim_id IS NOT NULL
  `;
  yield* sql`
    CREATE UNIQUE INDEX composition_run_start_intents_release_operation_unique
    ON composition_run_start_intents(last_release_operation_id)
    WHERE last_release_operation_id IS NOT NULL
  `;
  yield* sql`
    CREATE UNIQUE INDEX composition_run_start_intents_runtime_task_unique
    ON composition_run_start_intents(runtime_id, runtime_task_id)
    WHERE runtime_task_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX composition_run_start_intents_unsettled_scan
    ON composition_run_start_intents(state, updated_at_unix_ms, run_id)
  `;
});
