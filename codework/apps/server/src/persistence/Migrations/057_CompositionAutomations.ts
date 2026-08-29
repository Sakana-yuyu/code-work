import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE composition_automations (
      automation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      cadence_json TEXT NOT NULL,
      target_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed')),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      max_runs INTEGER CHECK (max_runs IS NULL OR max_runs >= 1),
      run_count INTEGER NOT NULL CHECK (run_count >= 0),
      created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
      updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= created_at_unix_ms),
      next_run_at_unix_ms INTEGER CHECK (next_run_at_unix_ms IS NULL OR next_run_at_unix_ms >= 0),
      last_run_at_unix_ms INTEGER CHECK (
        last_run_at_unix_ms IS NULL OR
        (last_run_at_unix_ms >= created_at_unix_ms AND last_run_at_unix_ms <= updated_at_unix_ms)
      ),
      paused_at_unix_ms INTEGER CHECK (
        paused_at_unix_ms IS NULL OR
        (paused_at_unix_ms >= created_at_unix_ms AND paused_at_unix_ms <= updated_at_unix_ms)
      ),
      expires_at_unix_ms INTEGER CHECK (
        expires_at_unix_ms IS NULL OR expires_at_unix_ms > created_at_unix_ms
      ),
      CHECK (max_runs IS NULL OR run_count <= max_runs),
      CHECK (status != 'active' OR max_runs IS NULL OR run_count < max_runs),
      CHECK (
        (status = 'active' AND next_run_at_unix_ms IS NOT NULL AND paused_at_unix_ms IS NULL) OR
        (status = 'paused' AND next_run_at_unix_ms IS NULL AND paused_at_unix_ms IS NOT NULL) OR
        (status = 'completed' AND next_run_at_unix_ms IS NULL)
      ),
      CHECK (
        next_run_at_unix_ms IS NULL OR
        expires_at_unix_ms IS NULL OR
        next_run_at_unix_ms <= expires_at_unix_ms
      )
    )
  `;

  yield* sql`
    CREATE TABLE composition_automation_revisions (
      automation_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      snapshot_json TEXT NOT NULL,
      created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
      PRIMARY KEY (automation_id, revision)
    )
  `;

  yield* sql`
    CREATE TABLE composition_automation_runs (
      automation_run_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      automation_revision INTEGER NOT NULL CHECK (automation_revision >= 1),
      scheduled_for_unix_ms INTEGER NOT NULL CHECK (scheduled_for_unix_ms >= 0),
      idempotency_key TEXT NOT NULL UNIQUE,
      trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'run_once', 'retry', 'recovery')),
      status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped')
      ),
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      requested_at_unix_ms INTEGER NOT NULL CHECK (requested_at_unix_ms >= scheduled_for_unix_ms),
      started_at_unix_ms INTEGER CHECK (
        started_at_unix_ms IS NULL OR started_at_unix_ms >= requested_at_unix_ms
      ),
      finished_at_unix_ms INTEGER CHECK (
        finished_at_unix_ms IS NULL OR
        finished_at_unix_ms >= COALESCE(started_at_unix_ms, requested_at_unix_ms)
      ),
      composition_task_id TEXT,
      composition_run_id TEXT,
      output_summary TEXT,
      error_code TEXT,
      error_detail TEXT,
      UNIQUE (automation_id, scheduled_for_unix_ms),
      CHECK (
        idempotency_key =
          'composition-automation:' || automation_id || ':' || CAST(scheduled_for_unix_ms AS TEXT)
      ),
      CHECK (
        (status = 'queued' AND started_at_unix_ms IS NULL AND finished_at_unix_ms IS NULL) OR
        (status = 'running' AND started_at_unix_ms IS NOT NULL AND finished_at_unix_ms IS NULL) OR
        (status IN ('succeeded', 'failed') AND
          started_at_unix_ms IS NOT NULL AND finished_at_unix_ms IS NOT NULL) OR
        (status = 'cancelled' AND finished_at_unix_ms IS NOT NULL) OR
        (status = 'skipped' AND started_at_unix_ms IS NULL AND finished_at_unix_ms IS NOT NULL)
      ),
      CHECK (status != 'succeeded' OR (error_code IS NULL AND error_detail IS NULL)),
      CHECK (status != 'failed' OR error_code IS NOT NULL),
      CHECK (
        (composition_task_id IS NULL AND composition_run_id IS NULL) OR
        (composition_task_id IS NOT NULL AND composition_run_id IS NOT NULL)
      )
    )
  `;

  yield* sql`
    CREATE INDEX idx_composition_automations_due
    ON composition_automations(next_run_at_unix_ms, automation_id)
    WHERE status = 'active'
  `;
  yield* sql`
    CREATE INDEX idx_composition_automations_project_status
    ON composition_automations(project_id, status, updated_at_unix_ms DESC)
  `;
  yield* sql`
    CREATE INDEX idx_composition_automation_revisions_latest
    ON composition_automation_revisions(automation_id, revision DESC)
  `;
  yield* sql`
    CREATE INDEX idx_composition_automation_runs_history
    ON composition_automation_runs(
      automation_id, requested_at_unix_ms DESC, automation_run_id DESC
    )
  `;
  yield* sql`
    CREATE INDEX idx_composition_automation_runs_active
    ON composition_automation_runs(status, requested_at_unix_ms)
    WHERE status IN ('queued', 'running')
  `;
});
