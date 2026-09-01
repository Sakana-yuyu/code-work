import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

interface FrozenMigration {
  readonly id: number;
  readonly name: string;
  readonly statements: ReadonlyArray<string>;
}

// 该夹具冻结自 main 提交 c1e9a751c 中已经发布的 Composition-first 042-059。
// 它不得导入当前迁移实现，否则迁移与测试可能同时漂移而产生假阳性。
export const frozenLegacyCompositionMigrations = [
  {
    id: 42,
    name: "CompositionTasks",
    statements: [
      `CREATE TABLE IF NOT EXISTS composition_tasks (
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
      )`,
      `CREATE TABLE IF NOT EXISTS composition_task_runs (
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
      )`,
      `CREATE TABLE IF NOT EXISTS composition_task_events (
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
      )`,
      `CREATE TABLE IF NOT EXISTS composition_task_dependencies (
        task_id TEXT NOT NULL,
        depends_on_task_id TEXT NOT NULL,
        condition TEXT NOT NULL,
        created_at_unix_ms INTEGER NOT NULL,
        PRIMARY KEY (task_id, depends_on_task_id)
      )`,
      `CREATE TABLE IF NOT EXISTS composition_runtime_leases (
        lease_id TEXT PRIMARY KEY,
        runtime_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        workspace_root_digest TEXT NOT NULL,
        heartbeat_at_unix_ms INTEGER NOT NULL,
        expires_at_unix_ms INTEGER NOT NULL,
        state TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS composition_squads (
        squad_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        leader_agent_id TEXT NOT NULL,
        member_agent_ids_json TEXT NOT NULL,
        instructions TEXT,
        archived_at_unix_ms INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_composition_tasks_project_status
        ON composition_tasks(project_id, status, updated_at_unix_ms)`,
      `CREATE INDEX IF NOT EXISTS idx_composition_runs_task
        ON composition_task_runs(task_id, attempt)`,
      `CREATE INDEX IF NOT EXISTS idx_composition_events_task_run
        ON composition_task_events(task_id, run_id, sequence)`,
      `CREATE INDEX IF NOT EXISTS idx_composition_leases_workspace_state
        ON composition_runtime_leases(workspace_root_digest, state, expires_at_unix_ms)`,
    ],
  },
  {
    id: 43,
    name: "CompositionTaskEventSourceId",
    statements: [
      `ALTER TABLE composition_task_events ADD COLUMN source_event_id TEXT`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_composition_events_source_event
        ON composition_task_events(task_id, run_id, source_event_id)
        WHERE source_event_id IS NOT NULL`,
    ],
  },
  {
    id: 44,
    name: "CompositionTaskRunCapabilityGrants",
    statements: [
      `ALTER TABLE composition_task_runs
        ADD COLUMN capability_grant_ids_json TEXT NOT NULL DEFAULT '[]'`,
    ],
  },
  {
    id: 45,
    name: "CompositionCapabilityGrants",
    statements: [
      `CREATE TABLE IF NOT EXISTS composition_capability_grants (
        grant_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        issued_at_unix_ms INTEGER NOT NULL,
        expires_at_unix_ms INTEGER NOT NULL,
        revoked_at_unix_ms INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_composition_capability_grants_scope
        ON composition_capability_grants(task_id, agent_id, capability_id, expires_at_unix_ms)`,
      `CREATE TABLE IF NOT EXISTS composition_capability_audit (
        audit_id TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        outcome TEXT NOT NULL,
        error_code TEXT,
        occurred_at_unix_ms INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_composition_capability_audit_task
        ON composition_capability_audit(task_id, occurred_at_unix_ms, audit_id)`,
    ],
  },
  {
    id: 46,
    name: "CompositionTaskRunCapabilityHandshake",
    statements: [`ALTER TABLE composition_task_runs ADD COLUMN capability_handshake_id TEXT`],
  },
  {
    id: 47,
    name: "CompositionTaskInputs",
    statements: [
      `CREATE TABLE IF NOT EXISTS composition_task_inputs (
        task_id TEXT PRIMARY KEY,
        encrypted_payload TEXT NOT NULL,
        created_at_unix_ms INTEGER NOT NULL,
        updated_at_unix_ms INTEGER NOT NULL
      )`,
    ],
  },
  {
    id: 48,
    name: "CompositionTaskRunRuntimeTaskIndex",
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_composition_runs_runtime_task
        ON composition_task_runs(runtime_id, runtime_task_id, attempt, run_id)
        WHERE runtime_task_id IS NOT NULL`,
    ],
  },
  {
    id: 49,
    name: "CompositionTaskRunCancelRequestedAt",
    statements: [
      `ALTER TABLE composition_task_runs ADD COLUMN cancel_requested_at_unix_ms INTEGER`,
    ],
  },
  {
    id: 50,
    name: "CompositionTaskRunLastRuntimeEventAt",
    statements: [
      `ALTER TABLE composition_task_runs ADD COLUMN last_runtime_event_at_unix_ms INTEGER`,
    ],
  },
  {
    id: 51,
    name: "CompositionMulticaQuickCreateIntents",
    statements: [
      `CREATE TABLE IF NOT EXISTS composition_multica_quick_create_intents (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('prepared', 'sending', 'accepted')),
        remote_task_id TEXT,
        created_at_unix_ms INTEGER NOT NULL,
        updated_at_unix_ms INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_composition_multica_quick_create_pending
        ON composition_multica_quick_create_intents(runtime_id, state, updated_at_unix_ms)
        WHERE state IN ('prepared', 'sending')`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_composition_multica_quick_create_idempotency_key
        ON composition_multica_quick_create_intents(runtime_id, idempotency_key)`,
    ],
  },
  {
    id: 52,
    name: "CompositionMulticaQuickCreateIdempotencyKey",
    statements: [
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_composition_multica_quick_create_idempotency_key
        ON composition_multica_quick_create_intents(runtime_id, idempotency_key)`,
    ],
  },
  {
    id: 53,
    name: "CompositionTaskOutputCheckpoints",
    statements: [
      `ALTER TABLE composition_task_events ADD COLUMN output_delta TEXT`,
      `ALTER TABLE composition_task_events ADD COLUMN output_offset_bytes INTEGER`,
      `ALTER TABLE composition_task_events ADD COLUMN output_digest TEXT`,
    ],
  },
  {
    id: 54,
    name: "ProjectionThreadLinkedPullRequest",
    statements: [`ALTER TABLE projection_threads ADD COLUMN linked_pull_request_json TEXT`],
  },
  {
    id: 55,
    name: "ProjectionThreadsUnsettledAt",
    statements: [`ALTER TABLE projection_threads ADD COLUMN unsettled_at TEXT`],
  },
  {
    id: 56,
    name: "CompositionSquadConfiguration",
    statements: [
      `ALTER TABLE composition_squads
        ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)`,
      `ALTER TABLE composition_squads ADD COLUMN configuration_json TEXT`,
      `ALTER TABLE composition_squads
        ADD COLUMN created_at_unix_ms INTEGER NOT NULL DEFAULT 0
        CHECK (created_at_unix_ms >= 0)`,
      `ALTER TABLE composition_squads
        ADD COLUMN updated_at_unix_ms INTEGER NOT NULL DEFAULT 0
        CHECK (updated_at_unix_ms >= 0)`,
      `CREATE TABLE composition_squad_revisions (
        squad_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        configuration_json TEXT,
        created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
        PRIMARY KEY (squad_id, revision)
      )`,
      `INSERT INTO composition_squad_revisions (
        squad_id, revision, configuration_json, created_at_unix_ms
      )
      SELECT squad_id, revision, configuration_json, updated_at_unix_ms
      FROM composition_squads`,
      `CREATE INDEX idx_composition_squad_revisions_latest
        ON composition_squad_revisions(squad_id, revision DESC)`,
    ],
  },
  {
    id: 57,
    name: "CompositionAutomations",
    statements: [
      `CREATE TABLE composition_automations (
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
      )`,
      `CREATE TABLE composition_automation_revisions (
        automation_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        snapshot_json TEXT NOT NULL,
        created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
        PRIMARY KEY (automation_id, revision)
      )`,
      `CREATE TABLE composition_automation_runs (
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
      )`,
      `CREATE INDEX idx_composition_automations_due
        ON composition_automations(next_run_at_unix_ms, automation_id)
        WHERE status = 'active'`,
      `CREATE INDEX idx_composition_automations_project_status
        ON composition_automations(project_id, status, updated_at_unix_ms DESC)`,
      `CREATE INDEX idx_composition_automation_revisions_latest
        ON composition_automation_revisions(automation_id, revision DESC)`,
      `CREATE INDEX idx_composition_automation_runs_history
        ON composition_automation_runs(
          automation_id, requested_at_unix_ms DESC, automation_run_id DESC
        )`,
      `CREATE INDEX idx_composition_automation_runs_active
        ON composition_automation_runs(status, requested_at_unix_ms)
        WHERE status IN ('queued', 'running')`,
    ],
  },
  {
    id: 58,
    name: "CompositionAutomationOperations",
    statements: [
      `ALTER TABLE composition_automation_runs
        ADD COLUMN operation_id TEXT
        CHECK (operation_id IS NULL OR length(trim(operation_id)) > 0)`,
      `ALTER TABLE composition_automation_runs
        ADD COLUMN source_automation_run_id TEXT
        CHECK (
          source_automation_run_id IS NULL OR
          length(trim(source_automation_run_id)) > 0
        )`,
      `CREATE UNIQUE INDEX idx_composition_automation_runs_operation
        ON composition_automation_runs(automation_id, operation_id)
        WHERE operation_id IS NOT NULL`,
      `CREATE TRIGGER composition_automation_runs_operation_insert
        BEFORE INSERT ON composition_automation_runs
        WHEN
          (NEW.trigger IN ('run_once', 'retry') AND NEW.operation_id IS NULL) OR
          (NEW.trigger IN ('scheduled', 'recovery') AND (
            NEW.operation_id IS NOT NULL OR NEW.source_automation_run_id IS NOT NULL
          )) OR
          (NEW.trigger = 'run_once' AND NEW.source_automation_run_id IS NOT NULL) OR
          (NEW.trigger = 'retry' AND NEW.source_automation_run_id IS NULL)
        BEGIN
          SELECT RAISE(ABORT, 'invalid composition automation operation identity');
        END`,
      `CREATE TRIGGER composition_automation_runs_operation_update
        BEFORE UPDATE OF trigger, operation_id, source_automation_run_id
        ON composition_automation_runs
        WHEN
          (NEW.trigger IN ('run_once', 'retry') AND NEW.operation_id IS NULL) OR
          (NEW.trigger IN ('scheduled', 'recovery') AND (
            NEW.operation_id IS NOT NULL OR NEW.source_automation_run_id IS NOT NULL
          )) OR
          (NEW.trigger = 'run_once' AND NEW.source_automation_run_id IS NOT NULL) OR
          (NEW.trigger = 'retry' AND NEW.source_automation_run_id IS NULL)
        BEGIN
          SELECT RAISE(ABORT, 'invalid composition automation operation identity');
        END`,
    ],
  },
  {
    id: 59,
    name: "WorkspaceScriptRuns",
    statements: [
      `CREATE TABLE workspace_script_runs (
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
      )`,
      `CREATE UNIQUE INDEX idx_workspace_script_runs_stop_operation
        ON workspace_script_runs(stop_operation_id)
        WHERE stop_operation_id IS NOT NULL`,
      `CREATE INDEX idx_workspace_script_runs_project_history
        ON workspace_script_runs(
          project_id, requested_at_unix_ms DESC, workspace_script_run_id DESC
        )`,
      `CREATE INDEX idx_workspace_script_runs_thread_history
        ON workspace_script_runs(
          thread_id, requested_at_unix_ms DESC, workspace_script_run_id DESC
        )`,
      `CREATE INDEX idx_workspace_script_runs_active
        ON workspace_script_runs(project_id, thread_id, script_id, updated_at_unix_ms DESC)
        WHERE status IN ('starting', 'running', 'stopping')`,
    ],
  },
] as const satisfies ReadonlyArray<FrozenMigration>;

export const frozenUpstreamProjectionMigrations = [
  {
    id: 42,
    name: "ProjectionThreadLinkedPullRequest",
    statements: [`ALTER TABLE projection_threads ADD COLUMN linked_pull_request_json TEXT`],
  },
  {
    id: 43,
    name: "ProjectionThreadsUnsettledAt",
    statements: [`ALTER TABLE projection_threads ADD COLUMN unsettled_at TEXT`],
  },
] as const satisfies ReadonlyArray<FrozenMigration>;

const applyFrozenMigrations = Effect.fn("applyFrozenCompositionMigrationHistory")(function* (
  migrations: ReadonlyArray<FrozenMigration>,
  throughId: number,
) {
  const sql = yield* SqlClient.SqlClient;

  for (const migration of migrations) {
    if (migration.id > throughId) break;
    for (const statement of migration.statements) {
      yield* sql.unsafe(statement).unprepared;
    }
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (${migration.id}, ${migration.name})
    `;
  }
});

export const applyFrozenLegacyCompositionMigrations = (throughId: number) =>
  applyFrozenMigrations(frozenLegacyCompositionMigrations, throughId);

export const applyFrozenUpstreamProjectionMigrations = (throughId: 42 | 43) =>
  applyFrozenMigrations(frozenUpstreamProjectionMigrations, throughId);
