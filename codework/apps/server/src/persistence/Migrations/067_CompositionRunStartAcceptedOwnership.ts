import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE composition_run_start_intents
    RENAME TO composition_run_start_intents_legacy_067
  `;
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
        state IN (
          'prepared', 'preparing', 'dispatching', 'accepted', 'manual_pending',
          'settled', 'quarantined'
        )
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
      owner_epoch INTEGER NOT NULL DEFAULT 0 CHECK (owner_epoch >= 0),
      owner_lease_expires_at_unix_ms INTEGER CHECK (
        owner_lease_expires_at_unix_ms IS NULL OR owner_lease_expires_at_unix_ms >= 0
      ),
      CHECK (updated_at_unix_ms >= created_at_unix_ms),
      CHECK (
        (
          state = 'prepared' AND claim_id IS NULL AND owner_lease_expires_at_unix_ms IS NULL AND
          runtime_task_id IS NULL AND capability_handshake_id IS NULL AND
          outcome_code IS NULL AND outcome_detail IS NULL
        ) OR
        (
          state IN ('preparing', 'dispatching') AND claim_id IS NOT NULL AND owner_epoch >= 1 AND
          owner_lease_expires_at_unix_ms IS NOT NULL AND runtime_task_id IS NULL AND
          capability_handshake_id IS NULL AND outcome_code IS NULL AND outcome_detail IS NULL
        ) OR
        (
          state = 'accepted' AND outcome_code IS NULL AND outcome_detail IS NULL AND
          (
            (claim_id IS NULL AND owner_lease_expires_at_unix_ms IS NULL) OR
            (claim_id IS NOT NULL AND owner_epoch >= 1 AND owner_lease_expires_at_unix_ms IS NOT NULL)
          )
        ) OR
        (
          state = 'manual_pending' AND owner_epoch >= 1 AND outcome_code IS NOT NULL AND
          (
            (claim_id IS NULL AND owner_lease_expires_at_unix_ms IS NULL) OR
            (claim_id IS NOT NULL AND owner_epoch >= 1 AND owner_lease_expires_at_unix_ms IS NOT NULL)
          )
        ) OR
        (
          state = 'settled' AND owner_lease_expires_at_unix_ms IS NULL AND
          (
            (outcome_code IS NULL AND outcome_detail IS NULL) OR
            (
              claim_id IS NULL AND runtime_task_id IS NULL AND capability_handshake_id IS NULL AND
              outcome_code IS NOT NULL
            ) OR
            (
              claim_id IS NOT NULL AND owner_epoch >= 1 AND outcome_code IS NOT NULL
            )
          )
        ) OR
        (
          state = 'quarantined' AND claim_id IS NULL AND
          owner_lease_expires_at_unix_ms IS NULL AND outcome_code IS NOT NULL
        )
      )
    )
  `;
  yield* sql`
    INSERT INTO composition_run_start_intents (
      run_id, task_id, previous_run_id, agent_id, runtime_id, attempt,
      payload_digest, capability_digest, state, revision, claim_id,
      runtime_task_id, capability_handshake_id, outcome_code, outcome_detail,
      created_at_unix_ms, updated_at_unix_ms, owner_epoch,
      owner_lease_expires_at_unix_ms
    )
    SELECT
      run_id, task_id, previous_run_id, agent_id, runtime_id, attempt,
      payload_digest, capability_digest,
      CASE
        WHEN state = 'preparing' AND (
          owner_epoch < 1 OR owner_lease_expires_at_unix_ms IS NULL
        ) THEN 'prepared'
        WHEN state = 'dispatching' AND (
          owner_epoch < 1 OR owner_lease_expires_at_unix_ms IS NULL
        ) THEN 'quarantined'
        WHEN state = 'settled' AND (
          (outcome_code IS NULL AND outcome_detail IS NOT NULL) OR
          (
            outcome_code IS NOT NULL AND
            (runtime_task_id IS NOT NULL OR capability_handshake_id IS NOT NULL)
          )
        ) THEN 'quarantined'
        ELSE state
      END,
      CASE
        WHEN state = 'preparing' AND (
          owner_epoch < 1 OR owner_lease_expires_at_unix_ms IS NULL
        ) THEN revision + 1
        WHEN state = 'dispatching' AND (
          owner_epoch < 1 OR owner_lease_expires_at_unix_ms IS NULL
        ) THEN revision + 1
        WHEN state = 'settled' AND (
          (outcome_code IS NULL AND outcome_detail IS NOT NULL) OR
          (
            outcome_code IS NOT NULL AND
            (runtime_task_id IS NOT NULL OR capability_handshake_id IS NOT NULL)
          )
        ) THEN revision + 1
        ELSE revision
      END,
      CASE
        WHEN state IN ('preparing', 'dispatching') AND (
          owner_epoch < 1 OR owner_lease_expires_at_unix_ms IS NULL
        ) THEN NULL
        WHEN state = 'settled' AND (
          (outcome_code IS NULL AND outcome_detail IS NOT NULL) OR
          (
            outcome_code IS NOT NULL AND
            (runtime_task_id IS NOT NULL OR capability_handshake_id IS NOT NULL)
          )
        ) THEN NULL
        ELSE claim_id
      END,
      CASE
        WHEN state = 'settled' AND (
          (outcome_code IS NULL AND outcome_detail IS NOT NULL) OR
          (
            outcome_code IS NOT NULL AND
            (runtime_task_id IS NOT NULL OR capability_handshake_id IS NOT NULL)
          )
        ) THEN NULL
        ELSE runtime_task_id
      END,
      CASE
        WHEN state = 'settled' AND (
          (outcome_code IS NULL AND outcome_detail IS NOT NULL) OR
          (
            outcome_code IS NOT NULL AND
            (runtime_task_id IS NOT NULL OR capability_handshake_id IS NOT NULL)
          )
        ) THEN NULL
        ELSE capability_handshake_id
      END,
      CASE
        WHEN state = 'dispatching' AND (
          owner_epoch < 1 OR owner_lease_expires_at_unix_ms IS NULL
        ) THEN 'run_start_legacy_dispatch_unfenced'
        WHEN state = 'settled' AND (
          (outcome_code IS NULL AND outcome_detail IS NOT NULL) OR
          (
            outcome_code IS NOT NULL AND
            (runtime_task_id IS NOT NULL OR capability_handshake_id IS NOT NULL)
          )
        ) THEN 'run_start_legacy_settled_inconsistent'
        ELSE outcome_code
      END,
      CASE
        WHEN state = 'dispatching' AND (
          owner_epoch < 1 OR owner_lease_expires_at_unix_ms IS NULL
        ) THEN '旧 dispatching Run Start 缺少持久 owner 围栏，无法证明外部启动是否发生，已阻止自动重放。'
        WHEN state = 'settled' AND (
          (outcome_code IS NULL AND outcome_detail IS NOT NULL) OR
          (
            outcome_code IS NOT NULL AND
            (runtime_task_id IS NOT NULL OR capability_handshake_id IS NOT NULL)
          )
        ) THEN '旧 settled Run Start 同时包含互相冲突的 receipt 与 outcome，已转入隔离等待人工核对。'
        ELSE outcome_detail
      END,
      created_at_unix_ms, updated_at_unix_ms, owner_epoch,
      CASE
        WHEN state IN ('preparing', 'dispatching') AND owner_epoch >= 1 AND
          owner_lease_expires_at_unix_ms IS NOT NULL
        THEN owner_lease_expires_at_unix_ms
        ELSE NULL
      END
    FROM composition_run_start_intents_legacy_067
  `;
  yield* sql`DROP TABLE composition_run_start_intents_legacy_067`;
  yield* sql`
    CREATE UNIQUE INDEX uq_composition_run_start_task_attempt
    ON composition_run_start_intents(task_id, attempt)
  `;
  yield* sql`
    CREATE INDEX idx_composition_run_start_recoverable
    ON composition_run_start_intents(run_id ASC)
    WHERE state IN ('prepared', 'preparing', 'dispatching', 'accepted')
  `;
  yield* sql`
    CREATE INDEX idx_composition_run_start_manual_recovery
    ON composition_run_start_intents(run_id ASC)
    WHERE state = 'manual_pending'
  `;
});
