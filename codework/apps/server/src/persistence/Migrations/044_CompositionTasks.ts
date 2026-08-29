import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS composition_tasks (
      task_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      thread_id TEXT,
      parent_task_id TEXT,
      assignee_kind TEXT NOT NULL,
      assignee_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt_digest TEXT NOT NULL,
      depends_on_task_ids_json TEXT NOT NULL,
      created_at_unix_ms INTEGER NOT NULL,
      updated_at_unix_ms INTEGER NOT NULL,
      finished_at_unix_ms INTEGER
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS composition_task_runs (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      runtime_task_id TEXT,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      lease_id TEXT,
      started_at_unix_ms INTEGER,
      finished_at_unix_ms INTEGER,
      failure_code TEXT,
      result_summary TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS composition_task_events (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      parent_task_id TEXT,
      agent_id TEXT NOT NULL,
      runtime_id TEXT,
      status TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      progress INTEGER,
      blocker_code TEXT,
      approval_request_id TEXT,
      child_task_ids_json TEXT,
      UNIQUE (task_id, run_id, sequence)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS composition_task_dependencies (
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      condition TEXT NOT NULL,
      created_at_unix_ms INTEGER NOT NULL,
      PRIMARY KEY (task_id, depends_on_task_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS composition_runtime_leases (
      lease_id TEXT PRIMARY KEY,
      runtime_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      workspace_root_digest TEXT NOT NULL,
      heartbeat_at_unix_ms INTEGER NOT NULL,
      expires_at_unix_ms INTEGER NOT NULL,
      state TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS composition_squads (
      squad_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      leader_agent_id TEXT NOT NULL,
      member_agent_ids_json TEXT NOT NULL,
      instructions TEXT,
      archived_at_unix_ms INTEGER
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_composition_tasks_project_status
    ON composition_tasks(project_id, status, updated_at_unix_ms)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_composition_runs_task
    ON composition_task_runs(task_id, attempt)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_composition_events_task_run
    ON composition_task_events(task_id, run_id, sequence)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_composition_leases_workspace_state
    ON composition_runtime_leases(workspace_root_digest, state, expires_at_unix_ms)
  `;
});
