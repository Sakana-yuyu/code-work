import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE composition_squad_execution_bindings (
      execution_id TEXT NOT NULL,
      identity_kind TEXT NOT NULL CHECK (identity_kind IN ('task', 'run')),
      identity_id TEXT NOT NULL CHECK (length(trim(identity_id)) > 0),
      role TEXT NOT NULL CHECK (
        role IN ('goal_task', 'leader_task', 'leader_run', 'node_task', 'node_run')
      ),
      node_id TEXT CHECK (node_id IS NULL OR length(trim(node_id)) > 0),
      PRIMARY KEY (identity_kind, identity_id),
      FOREIGN KEY (execution_id)
        REFERENCES composition_squad_executions(execution_id)
        ON DELETE CASCADE,
      CHECK (
        (role = 'goal_task' AND identity_kind = 'task' AND node_id IS NULL) OR
        (role = 'leader_task' AND identity_kind = 'task' AND node_id IS NULL) OR
        (role = 'leader_run' AND identity_kind = 'run' AND node_id IS NULL) OR
        (role = 'node_task' AND identity_kind = 'task' AND node_id IS NOT NULL) OR
        (role = 'node_run' AND identity_kind = 'run' AND node_id IS NOT NULL)
      )
    )
  `;

  yield* sql`
    CREATE INDEX idx_composition_squad_execution_bindings_execution
    ON composition_squad_execution_bindings(execution_id, role, node_id)
  `;
  yield* sql`
    CREATE UNIQUE INDEX uq_composition_squad_execution_bindings_top_level_slot
    ON composition_squad_execution_bindings(execution_id, role)
    WHERE node_id IS NULL
  `;
  yield* sql`
    CREATE UNIQUE INDEX uq_composition_squad_execution_bindings_node_slot
    ON composition_squad_execution_bindings(execution_id, role, node_id)
    WHERE node_id IS NOT NULL
  `;

  yield* sql`
    INSERT INTO composition_squad_execution_bindings (
      execution_id, identity_kind, identity_id, role, node_id
    )
    SELECT execution_id, 'task', goal_task_id, 'goal_task', NULL
    FROM composition_squad_executions
    UNION ALL
    SELECT execution_id, 'task', leader_task_id, 'leader_task', NULL
    FROM composition_squad_executions
    UNION ALL
    SELECT execution_id, 'run', leader_run_id, 'leader_run', NULL
    FROM composition_squad_executions
  `;

  yield* sql`
    INSERT INTO composition_squad_execution_bindings (
      execution_id, identity_kind, identity_id, role, node_id
    )
    SELECT
      execution.execution_id,
      'task',
      json_extract(node.value, '$.taskId'),
      'node_task',
      json_extract(node.value, '$.nodeId')
    FROM composition_squad_executions AS execution
    JOIN json_each(COALESCE(execution.nodes_json, '[]')) AS node
    UNION ALL
    SELECT
      execution.execution_id,
      'run',
      json_extract(node.value, '$.runId'),
      'node_run',
      json_extract(node.value, '$.nodeId')
    FROM composition_squad_executions AS execution
    JOIN json_each(COALESCE(execution.nodes_json, '[]')) AS node
  `;
});
