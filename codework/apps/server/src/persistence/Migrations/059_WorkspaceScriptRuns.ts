import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE workspace_script_runs (
      workspace_script_run_id TEXT PRIMARY KEY
        CHECK (length(trim(workspace_script_run_id)) > 0),
      idempotency_key TEXT NOT NULL UNIQUE
        CHECK (length(trim(idempotency_key)) > 0),
      project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
      thread_id TEXT NOT NULL CHECK (length(trim(thread_id)) > 0),
      script_id TEXT NOT NULL CHECK (length(trim(script_id)) > 0),
      script_name TEXT NOT NULL CHECK (length(trim(script_name)) > 0),
      terminal_id TEXT NOT NULL CHECK (length(trim(terminal_id)) > 0),
      cwd TEXT NOT NULL CHECK (length(trim(cwd)) > 0),
      worktree_path TEXT CHECK (worktree_path IS NULL OR length(trim(worktree_path)) > 0),
      status TEXT NOT NULL
        CHECK (status IN ('starting', 'running', 'stopping', 'stopped', 'exited', 'failed')),
      health_status TEXT NOT NULL
        CHECK (health_status IN ('unknown', 'healthy', 'unhealthy')),
      health_checked_at_unix_ms INTEGER
        CHECK (health_checked_at_unix_ms IS NULL OR health_checked_at_unix_ms >= 0),
      health_detail TEXT CHECK (health_detail IS NULL OR length(trim(health_detail)) > 0),
      ports_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(ports_json) AND json_type(ports_json) = 'array'),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      requested_at_unix_ms INTEGER NOT NULL CHECK (requested_at_unix_ms >= 0),
      started_at_unix_ms INTEGER CHECK (started_at_unix_ms IS NULL OR started_at_unix_ms >= 0),
      finished_at_unix_ms INTEGER CHECK (finished_at_unix_ms IS NULL OR finished_at_unix_ms >= 0),
      exit_code INTEGER,
      exit_signal INTEGER,
      error_code TEXT CHECK (error_code IS NULL OR length(trim(error_code)) > 0),
      error_detail TEXT CHECK (error_detail IS NULL OR length(trim(error_detail)) > 0),
      composition_task_id TEXT
        CHECK (composition_task_id IS NULL OR length(trim(composition_task_id)) > 0),
      composition_run_id TEXT
        CHECK (composition_run_id IS NULL OR length(trim(composition_run_id)) > 0),
      stop_operation_id TEXT
        CHECK (stop_operation_id IS NULL OR length(trim(stop_operation_id)) > 0),
      updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= 0),
      CHECK (updated_at_unix_ms >= requested_at_unix_ms),
      CHECK (
        started_at_unix_ms IS NULL OR
        (started_at_unix_ms >= requested_at_unix_ms AND started_at_unix_ms <= updated_at_unix_ms)
      ),
      CHECK (
        finished_at_unix_ms IS NULL OR
        (
          finished_at_unix_ms >= COALESCE(started_at_unix_ms, requested_at_unix_ms) AND
          finished_at_unix_ms <= updated_at_unix_ms
        )
      ),
      CHECK (
        (status = 'starting' AND started_at_unix_ms IS NULL AND finished_at_unix_ms IS NULL) OR
        (
          status IN ('running', 'stopping') AND
          started_at_unix_ms IS NOT NULL AND
          finished_at_unix_ms IS NULL
        ) OR
        (
          status IN ('stopped', 'exited') AND
          started_at_unix_ms IS NOT NULL AND
          finished_at_unix_ms IS NOT NULL
        ) OR
        (status = 'failed' AND finished_at_unix_ms IS NOT NULL)
      ),
      CHECK (
        (error_code IS NULL AND error_detail IS NULL AND status <> 'failed') OR
        (error_code IS NOT NULL AND error_detail IS NOT NULL AND status = 'failed')
      ),
      CHECK (
        (health_status = 'unknown' AND health_checked_at_unix_ms IS NULL AND health_detail IS NULL) OR
        (
          health_status = 'healthy' AND
          health_checked_at_unix_ms IS NOT NULL AND
          health_detail IS NULL
        ) OR
        (
          health_status = 'unhealthy' AND
          health_checked_at_unix_ms IS NOT NULL AND
          health_detail IS NOT NULL
        )
      ),
      CHECK (
        health_checked_at_unix_ms IS NULL OR
        (
          health_checked_at_unix_ms >= requested_at_unix_ms AND
          health_checked_at_unix_ms <= updated_at_unix_ms
        )
      ),
      CHECK (status NOT IN ('stopped', 'exited', 'failed') OR health_status = 'unknown'),
      CHECK ((composition_task_id IS NULL) = (composition_run_id IS NULL))
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX idx_workspace_script_runs_stop_operation
    ON workspace_script_runs(stop_operation_id)
    WHERE stop_operation_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX idx_workspace_script_runs_project_history
    ON workspace_script_runs(project_id, requested_at_unix_ms DESC, workspace_script_run_id DESC)
  `;
  yield* sql`
    CREATE INDEX idx_workspace_script_runs_thread_history
    ON workspace_script_runs(thread_id, requested_at_unix_ms DESC, workspace_script_run_id DESC)
  `;
  yield* sql`
    CREATE INDEX idx_workspace_script_runs_active
    ON workspace_script_runs(project_id, thread_id, script_id, updated_at_unix_ms DESC)
    WHERE status IN ('starting', 'running', 'stopping')
  `;
});
