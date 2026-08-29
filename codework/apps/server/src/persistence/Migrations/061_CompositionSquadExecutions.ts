import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE composition_squad_executions (
      execution_id TEXT PRIMARY KEY CHECK (length(trim(execution_id)) > 0),
      squad_id TEXT NOT NULL CHECK (length(trim(squad_id)) > 0),
      squad_revision INTEGER NOT NULL CHECK (squad_revision >= 1),
      project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
      thread_id TEXT CHECK (thread_id IS NULL OR length(trim(thread_id)) > 0),
      goal_digest TEXT NOT NULL CHECK (length(trim(goal_digest)) > 0),
      goal_task_id TEXT NOT NULL CHECK (length(trim(goal_task_id)) > 0),
      workspace_root_digest TEXT NOT NULL CHECK (length(trim(workspace_root_digest)) > 0),
      status TEXT NOT NULL CHECK (
        status IN (
          'queued', 'planning', 'awaiting_approval', 'running', 'in_review',
          'paused', 'cancelling', 'completed', 'failed', 'cancelled'
        )
      ),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      nodes_json TEXT CHECK (
        nodes_json IS NULL OR
        (json_valid(nodes_json) AND json_type(nodes_json) = 'array')
      ),
      leader_task_id TEXT NOT NULL CHECK (length(trim(leader_task_id)) > 0),
      leader_run_id TEXT NOT NULL CHECK (length(trim(leader_run_id)) > 0),
      pending_approvals_json TEXT NOT NULL DEFAULT '[]' CHECK (
        json_valid(pending_approvals_json) AND
        json_type(pending_approvals_json) = 'array'
      ),
      paused_from_status TEXT CHECK (
        paused_from_status IS NULL OR
        paused_from_status IN ('queued', 'planning', 'awaiting_approval', 'running', 'in_review')
      ),
      result_summary TEXT CHECK (
        result_summary IS NULL OR length(trim(result_summary)) > 0
      ),
      failure_code TEXT CHECK (failure_code IS NULL OR length(trim(failure_code)) > 0),
      failure_detail TEXT CHECK (failure_detail IS NULL OR length(trim(failure_detail)) > 0),
      created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
      updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= 0),
      started_at_unix_ms INTEGER CHECK (
        started_at_unix_ms IS NULL OR started_at_unix_ms >= 0
      ),
      paused_at_unix_ms INTEGER CHECK (paused_at_unix_ms IS NULL OR paused_at_unix_ms >= 0),
      cancel_requested_at_unix_ms INTEGER CHECK (
        cancel_requested_at_unix_ms IS NULL OR cancel_requested_at_unix_ms >= 0
      ),
      finished_at_unix_ms INTEGER CHECK (
        finished_at_unix_ms IS NULL OR finished_at_unix_ms >= 0
      ),
      CHECK (updated_at_unix_ms >= created_at_unix_ms),
      CHECK (
        started_at_unix_ms IS NULL OR
        (started_at_unix_ms >= created_at_unix_ms AND started_at_unix_ms <= updated_at_unix_ms)
      ),
      CHECK (
        paused_at_unix_ms IS NULL OR
        (
          paused_at_unix_ms >= COALESCE(started_at_unix_ms, created_at_unix_ms) AND
          paused_at_unix_ms <= updated_at_unix_ms
        )
      ),
      CHECK (
        cancel_requested_at_unix_ms IS NULL OR
        (
          cancel_requested_at_unix_ms >= COALESCE(started_at_unix_ms, created_at_unix_ms) AND
          cancel_requested_at_unix_ms <= updated_at_unix_ms
        )
      ),
      CHECK (
        finished_at_unix_ms IS NULL OR
        (
          finished_at_unix_ms >= COALESCE(cancel_requested_at_unix_ms, paused_at_unix_ms,
            started_at_unix_ms, created_at_unix_ms) AND
          finished_at_unix_ms <= updated_at_unix_ms
        )
      ),
      CHECK (
        (status = 'paused' AND paused_from_status IS NOT NULL AND paused_at_unix_ms IS NOT NULL) OR
        (status <> 'paused' AND paused_from_status IS NULL AND paused_at_unix_ms IS NULL)
      ),
      CHECK (
        (status IN ('completed', 'failed', 'cancelled') AND finished_at_unix_ms IS NOT NULL) OR
        (status NOT IN ('completed', 'failed', 'cancelled') AND finished_at_unix_ms IS NULL)
      ),
      CHECK (
        (status = 'completed' AND result_summary IS NOT NULL) OR
        (status <> 'completed' AND result_summary IS NULL)
      ),
      CHECK (
        (status = 'failed' AND failure_code IS NOT NULL AND failure_detail IS NOT NULL) OR
        (status <> 'failed' AND failure_code IS NULL AND failure_detail IS NULL)
      ),
      CHECK (
        (status IN ('cancelling', 'cancelled') AND cancel_requested_at_unix_ms IS NOT NULL) OR
        (status NOT IN ('cancelling', 'cancelled', 'failed') AND cancel_requested_at_unix_ms IS NULL) OR
        status = 'failed'
      ),
      CHECK (
        (status = 'queued' AND started_at_unix_ms IS NULL) OR
        status = 'cancelled' OR
        (
          status = 'paused' AND
          (
            (paused_from_status = 'queued' AND started_at_unix_ms IS NULL) OR
            (paused_from_status <> 'queued' AND started_at_unix_ms IS NOT NULL)
          )
        ) OR
        (
          status IN (
            'planning', 'awaiting_approval', 'running', 'in_review',
            'cancelling', 'completed', 'failed'
          ) AND
          started_at_unix_ms IS NOT NULL
        )
      ),
      CHECK (
        nodes_json IS NOT NULL OR
        (
          status NOT IN ('awaiting_approval', 'running', 'in_review', 'completed') AND
          NOT (
            status = 'paused' AND
            paused_from_status IN ('awaiting_approval', 'running', 'in_review')
          )
        )
      )
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX uq_composition_squad_executions_goal_task
    ON composition_squad_executions(goal_task_id)
  `;
  yield* sql`
    CREATE UNIQUE INDEX uq_composition_squad_executions_leader_task
    ON composition_squad_executions(leader_task_id)
  `;
  yield* sql`
    CREATE UNIQUE INDEX uq_composition_squad_executions_leader_run
    ON composition_squad_executions(leader_run_id)
  `;
  yield* sql`
    CREATE INDEX idx_composition_squad_executions_project_history
    ON composition_squad_executions(project_id, created_at_unix_ms DESC, execution_id DESC)
  `;
  yield* sql`
    CREATE INDEX idx_composition_squad_executions_thread_history
    ON composition_squad_executions(thread_id, created_at_unix_ms DESC, execution_id DESC)
    WHERE thread_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX idx_composition_squad_executions_squad_history
    ON composition_squad_executions(
      squad_id, squad_revision, created_at_unix_ms DESC, execution_id DESC
    )
  `;
  yield* sql`
    CREATE INDEX idx_composition_squad_executions_unsettled
    ON composition_squad_executions(status, updated_at_unix_ms ASC, execution_id ASC)
    WHERE status NOT IN ('completed', 'failed', 'cancelled')
  `;
});
