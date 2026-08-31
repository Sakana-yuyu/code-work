import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE composition_run_start_intents
    RENAME TO composition_run_start_intents_legacy_068
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
          'cancel_pending', 'settled', 'quarantined'
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
      cancel_requested_at_unix_ms INTEGER CHECK (
        cancel_requested_at_unix_ms IS NULL OR cancel_requested_at_unix_ms >= 0
      ),
      cancel_reason TEXT CHECK (
        cancel_reason IS NULL OR
        (length(trim(cancel_reason)) > 0 AND length(cancel_reason) <= 1024)
      ),
      cancel_source_state TEXT CHECK (
        cancel_source_state IS NULL OR
        cancel_source_state IN ('dispatching', 'accepted', 'manual_pending', 'accepted_settled')
      ),
      cancel_source_revision INTEGER CHECK (
        cancel_source_revision IS NULL OR cancel_source_revision >= 1
      ),
      cancel_source_claim_id TEXT CHECK (
        cancel_source_claim_id IS NULL OR
        (length(trim(cancel_source_claim_id)) > 0 AND length(cancel_source_claim_id) <= 512)
      ),
      cancel_source_owner_epoch INTEGER CHECK (
        cancel_source_owner_epoch IS NULL OR cancel_source_owner_epoch >= 1
      ),
      cancel_start_outcome TEXT CHECK (
        cancel_start_outcome IS NULL OR
        cancel_start_outcome IN ('pending', 'accepted', 'rejected')
      ),
      cancel_terminal_status TEXT CHECK (
        cancel_terminal_status IS NULL OR
        cancel_terminal_status IN ('completed', 'failed', 'cancelled', 'timed_out')
      ),
      cancel_terminal_source_event_id TEXT CHECK (
        cancel_terminal_source_event_id IS NULL OR
        (
          length(trim(cancel_terminal_source_event_id)) > 0 AND
          length(cancel_terminal_source_event_id) <= 512
        )
      ),
      cancel_terminal_observed_at_unix_ms INTEGER CHECK (
        cancel_terminal_observed_at_unix_ms IS NULL OR
        cancel_terminal_observed_at_unix_ms >= 0
      ),
      CHECK (updated_at_unix_ms >= created_at_unix_ms),
      CHECK (
        (
          cancel_requested_at_unix_ms IS NULL AND cancel_reason IS NULL AND
          cancel_source_state IS NULL AND cancel_source_revision IS NULL AND
          cancel_source_claim_id IS NULL AND cancel_source_owner_epoch IS NULL AND
          cancel_start_outcome IS NULL AND cancel_terminal_status IS NULL AND
          cancel_terminal_source_event_id IS NULL AND
          cancel_terminal_observed_at_unix_ms IS NULL
        ) OR
        (
          state IN ('cancel_pending', 'settled') AND
          cancel_requested_at_unix_ms IS NOT NULL AND
          cancel_requested_at_unix_ms >= created_at_unix_ms AND
          cancel_requested_at_unix_ms <= updated_at_unix_ms AND
          cancel_reason IS NOT NULL AND cancel_source_state IS NOT NULL AND
          cancel_source_revision IS NOT NULL AND cancel_source_revision < revision AND
          cancel_source_owner_epoch IS NOT NULL AND
          cancel_source_owner_epoch <= owner_epoch AND cancel_start_outcome IS NOT NULL AND
          (
            (
              cancel_terminal_status IS NULL AND
              cancel_terminal_source_event_id IS NULL AND
              cancel_terminal_observed_at_unix_ms IS NULL
            ) OR
            (
              cancel_terminal_status IS NOT NULL AND
              cancel_terminal_source_event_id IS NOT NULL AND
              cancel_terminal_observed_at_unix_ms IS NOT NULL AND
              cancel_terminal_observed_at_unix_ms >= cancel_requested_at_unix_ms AND
              cancel_terminal_observed_at_unix_ms <= updated_at_unix_ms
            )
          )
        )
      ),
      CHECK (
        (
          cancel_requested_at_unix_ms IS NULL AND
          (
            (
              state = 'prepared' AND claim_id IS NULL AND
              owner_lease_expires_at_unix_ms IS NULL AND runtime_task_id IS NULL AND
              capability_handshake_id IS NULL AND outcome_code IS NULL AND outcome_detail IS NULL
            ) OR
            (
              state IN ('preparing', 'dispatching') AND claim_id IS NOT NULL AND
              owner_epoch >= 1 AND owner_lease_expires_at_unix_ms IS NOT NULL AND
              runtime_task_id IS NULL AND capability_handshake_id IS NULL AND
              outcome_code IS NULL AND outcome_detail IS NULL
            ) OR
            (
              state = 'accepted' AND outcome_code IS NULL AND outcome_detail IS NULL AND
              (
                (claim_id IS NULL AND owner_lease_expires_at_unix_ms IS NULL) OR
                (
                  claim_id IS NOT NULL AND owner_epoch >= 1 AND
                  owner_lease_expires_at_unix_ms IS NOT NULL
                )
              )
            ) OR
            (
              state = 'manual_pending' AND owner_epoch >= 1 AND outcome_code IS NOT NULL AND
              (
                (claim_id IS NULL AND owner_lease_expires_at_unix_ms IS NULL) OR
                (
                  claim_id IS NOT NULL AND
                  owner_lease_expires_at_unix_ms IS NOT NULL
                )
              )
            ) OR
            (
              state = 'settled' AND owner_lease_expires_at_unix_ms IS NULL AND
              (
                (outcome_code IS NULL AND outcome_detail IS NULL) OR
                (
                  claim_id IS NULL AND runtime_task_id IS NULL AND
                  capability_handshake_id IS NULL AND outcome_code IS NOT NULL
                ) OR
                (claim_id IS NOT NULL AND owner_epoch >= 1 AND outcome_code IS NOT NULL)
              )
            ) OR
            (
              state = 'quarantined' AND claim_id IS NULL AND
              owner_lease_expires_at_unix_ms IS NULL AND outcome_code IS NOT NULL
            )
          )
        ) OR
        (
          cancel_requested_at_unix_ms IS NOT NULL AND
          (
            (
              state = 'cancel_pending' AND
              (
                (
                  claim_id IS NULL AND owner_lease_expires_at_unix_ms IS NULL AND
                  owner_epoch >= cancel_source_owner_epoch
                ) OR
                (
                  claim_id IS NOT NULL AND owner_lease_expires_at_unix_ms IS NOT NULL AND
                  owner_epoch > cancel_source_owner_epoch
                )
              )
            ) OR
            (
              state = 'settled' AND claim_id IS NOT NULL AND
              owner_lease_expires_at_unix_ms IS NULL AND
              owner_epoch > cancel_source_owner_epoch AND
              (
                (
                  cancel_start_outcome = 'rejected' AND
                  cancel_terminal_status IS NULL
                ) OR
                (
                  cancel_start_outcome = 'accepted' AND
                  cancel_terminal_status IS NOT NULL
                )
              )
            )
          ) AND
          (
            (
              cancel_source_state = 'dispatching' AND
              cancel_source_claim_id IS NOT NULL
            ) OR
            (
              cancel_source_state IN ('accepted', 'manual_pending', 'accepted_settled') AND
              cancel_start_outcome = 'accepted'
            )
          ) AND
          (
            (
              cancel_start_outcome = 'pending' AND
              cancel_source_state = 'dispatching' AND runtime_task_id IS NULL AND
              capability_handshake_id IS NULL AND outcome_code IS NULL AND
              outcome_detail IS NULL AND cancel_terminal_status IS NULL
            ) OR
            (
              cancel_start_outcome = 'rejected' AND
              cancel_source_state = 'dispatching' AND runtime_task_id IS NULL AND
              capability_handshake_id IS NULL AND outcome_code IS NOT NULL AND
              cancel_terminal_status IS NULL
            ) OR
            (
              cancel_start_outcome = 'accepted' AND
              (
                (
                  cancel_source_state = 'manual_pending' AND outcome_code IS NOT NULL
                ) OR
                (
                  cancel_source_state <> 'manual_pending' AND outcome_code IS NULL AND
                  outcome_detail IS NULL
                )
              )
            )
          ) AND
          (
            cancel_terminal_status IS NULL OR cancel_start_outcome = 'accepted'
          )
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
      owner_lease_expires_at_unix_ms,
      cancel_requested_at_unix_ms, cancel_reason, cancel_source_state,
      cancel_source_revision, cancel_source_claim_id, cancel_source_owner_epoch,
      cancel_start_outcome, cancel_terminal_status, cancel_terminal_source_event_id,
      cancel_terminal_observed_at_unix_ms
    )
    SELECT
      run_id, task_id, previous_run_id, agent_id, runtime_id, attempt,
      payload_digest, capability_digest, state, revision, claim_id,
      runtime_task_id, capability_handshake_id, outcome_code, outcome_detail,
      created_at_unix_ms, updated_at_unix_ms,
      CASE
        WHEN (
          state = 'accepted' OR
          (state = 'settled' AND outcome_code IS NULL AND outcome_detail IS NULL)
        ) AND owner_epoch < 1
        THEN 1
        ELSE owner_epoch
      END,
      owner_lease_expires_at_unix_ms,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    FROM composition_run_start_intents_legacy_068
  `;
  yield* sql`DROP TABLE composition_run_start_intents_legacy_068`;
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
  yield* sql`
    CREATE INDEX idx_composition_run_start_cancellation_recovery
    ON composition_run_start_intents(run_id ASC)
    WHERE state = 'cancel_pending'
  `;
});
