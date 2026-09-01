import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import {
  applyFrozenLegacyCompositionMigrations,
  applyFrozenUpstreamProjectionMigrations,
} from "./CompositionMigrationHistory.fixture.ts";

const withFreshDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

const seedLegacyCompositionHistory = (throughId: number) =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 41 });
    yield* applyFrozenLegacyCompositionMigrations(throughId);
  });

const seedUpstreamProjectionHistory = (throughId: 42 | 43) =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 41 });
    yield* applyFrozenUpstreamProjectionMigrations(throughId);
  });

const assertCanonicalSchema = Effect.fn("assertCanonicalCompositionSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const taskRunColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(composition_task_runs)
  `;
  const taskEventColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(composition_task_events)
  `;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
  `;
  const indexes = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'index'
  `;
  const triggers = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'trigger'
  `;
  const sourceEventIndexes = yield* sql<{
    readonly name: string;
    readonly unique: number;
    readonly partial: number;
  }>`
    PRAGMA index_list(composition_task_events)
  `;
  const multicaIndexes = yield* sql<{
    readonly name: string;
    readonly unique: number;
    readonly partial: number;
  }>`
    PRAGMA index_list(composition_multica_quick_create_intents)
  `;
  const automationRunIndexes = yield* sql<{
    readonly name: string;
    readonly unique: number;
    readonly partial: number;
  }>`
    PRAGMA index_list(composition_automation_runs)
  `;
  const workspaceScriptIndexes = yield* sql<{
    readonly name: string;
    readonly unique: number;
    readonly partial: number;
  }>`
    PRAGMA index_list(workspace_script_runs)
  `;
  const runtimeTaskIndexColumns = yield* sql<{ readonly name: string }>`
    PRAGMA index_info('idx_composition_runs_runtime_task')
  `;
  const squadRevisionColumns = yield* sql<{
    readonly name: string;
    readonly pk: number;
  }>`
    PRAGMA table_info(composition_squad_revisions)
  `;
  const migrations = yield* sql<{ readonly migrationId: number; readonly name: string }>`
    SELECT migration_id AS "migrationId", name
    FROM effect_sql_migrations
    WHERE migration_id = 60
  `;

  const projectionNames = new Set(projectionColumns.map((column) => column.name));
  const taskRunNames = new Set(taskRunColumns.map((column) => column.name));
  const taskEventNames = new Set(taskEventColumns.map((column) => column.name));
  const tableNames = new Set(tables.map((table) => table.name));
  const indexNames = new Set(indexes.map((index) => index.name));
  const triggerNames = new Set(triggers.map((trigger) => trigger.name));

  assert.ok(projectionNames.has("linked_pull_request_json"));
  assert.ok(projectionNames.has("unsettled_at"));
  assert.ok(taskRunNames.has("capability_grant_ids_json"));
  assert.ok(taskRunNames.has("capability_handshake_id"));
  assert.ok(taskRunNames.has("cancel_requested_at_unix_ms"));
  assert.ok(taskRunNames.has("last_runtime_event_at_unix_ms"));
  assert.ok(taskEventNames.has("source_event_id"));
  assert.ok(taskEventNames.has("output_delta"));
  assert.ok(taskEventNames.has("output_offset_bytes"));
  assert.ok(taskEventNames.has("output_digest"));
  assert.ok(tableNames.has("composition_capability_grants"));
  assert.ok(tableNames.has("composition_task_inputs"));
  assert.ok(tableNames.has("composition_multica_quick_create_intents"));
  assert.ok(tableNames.has("composition_squad_revisions"));
  assert.ok(tableNames.has("composition_automations"));
  assert.ok(tableNames.has("workspace_script_runs"));
  for (const indexName of [
    "idx_composition_runs_runtime_task",
    "idx_composition_events_source_event",
    "idx_composition_capability_grants_scope",
    "idx_composition_capability_audit_task",
    "idx_composition_multica_quick_create_idempotency_key",
    "idx_composition_squad_revisions_latest",
    "idx_composition_automations_due",
    "idx_composition_automations_project_status",
    "idx_composition_automation_revisions_latest",
    "idx_composition_automation_runs_history",
    "idx_composition_automation_runs_active",
    "idx_composition_automation_runs_operation",
    "idx_workspace_script_runs_stop_operation",
    "idx_workspace_script_runs_project_history",
    "idx_workspace_script_runs_thread_history",
    "idx_workspace_script_runs_active",
  ]) {
    assert.ok(indexNames.has(indexName), `缺少索引 ${indexName}`);
  }
  assert.equal(
    sourceEventIndexes.find((index) => index.name === "idx_composition_events_source_event")
      ?.unique,
    1,
  );
  assert.equal(
    sourceEventIndexes.find((index) => index.name === "idx_composition_events_source_event")
      ?.partial,
    1,
  );
  assert.equal(
    multicaIndexes.find(
      (index) => index.name === "idx_composition_multica_quick_create_idempotency_key",
    )?.unique,
    1,
  );
  assert.equal(
    automationRunIndexes.find((index) => index.name === "idx_composition_automation_runs_operation")
      ?.unique,
    1,
  );
  assert.equal(
    automationRunIndexes.find((index) => index.name === "idx_composition_automation_runs_operation")
      ?.partial,
    1,
  );
  assert.equal(
    workspaceScriptIndexes.find(
      (index) => index.name === "idx_workspace_script_runs_stop_operation",
    )?.unique,
    1,
  );
  assert.equal(
    workspaceScriptIndexes.find(
      (index) => index.name === "idx_workspace_script_runs_stop_operation",
    )?.partial,
    1,
  );
  assert.deepEqual(
    runtimeTaskIndexColumns.map((column) => column.name),
    ["runtime_id", "runtime_task_id", "attempt", "run_id"],
  );
  assert.deepEqual(
    squadRevisionColumns
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name),
    ["squad_id", "revision"],
  );
  assert.ok(triggerNames.has("composition_automation_runs_operation_insert"));
  assert.ok(triggerNames.has("composition_automation_runs_operation_update"));
  assert.deepEqual(migrations, [
    { migrationId: 60, name: "CompositionMigrationHistoryReconciliation" },
  ]);
});

describe("060_CompositionMigrationHistoryReconciliation", () => {
  for (const throughId of [42, 43, 44, 46, 49, 50, 53, 54, 55, 59] as const) {
    it.effect(`兼容旧 Composition 迁移历史停在 ${throughId}`, () =>
      withFreshDatabase(
        Effect.gen(function* () {
          yield* seedLegacyCompositionHistory(throughId);
          yield* runMigrations({ toMigrationInclusive: 60 });
          yield* assertCanonicalSchema();
        }),
      ),
    );
  }

  for (const throughId of [42, 43] as const) {
    it.effect(`兼容 upstream Projection 迁移历史停在 ${throughId}`, () =>
      withFreshDatabase(
        Effect.gen(function* () {
          yield* seedUpstreamProjectionHistory(throughId);
          yield* runMigrations({ toMigrationInclusive: 60 });
          yield* assertCanonicalSchema();
        }),
      ),
    );
  }

  it.effect("保留旧 Task、Run、Event 与 Squad 数据", () =>
    withFreshDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedLegacyCompositionHistory(53);

        yield* sql`
        INSERT INTO composition_tasks (
          task_id, project_id, assignee_kind, assignee_id, mode, status,
          prompt_digest, depends_on_task_ids_json, created_at_unix_ms, updated_at_unix_ms
        ) VALUES (
          'legacy-task', 'project-legacy', 'agent', 'agent-legacy', 'parallel', 'running',
          'sha256:legacy-task', '[]', 100, 120
        )
      `;
        yield* sql`
        INSERT INTO composition_task_runs (
          run_id, task_id, agent_id, runtime_id, status, attempt,
          capability_grant_ids_json, capability_handshake_id,
          cancel_requested_at_unix_ms, last_runtime_event_at_unix_ms
        ) VALUES (
          'legacy-run', 'legacy-task', 'agent-legacy', 'runtime-legacy', 'running', 1,
          '["grant-legacy"]', 'handshake-legacy', 130, 140
        )
      `;
        yield* sql`
        INSERT INTO composition_task_events (
          task_id, run_id, source_event_id, agent_id, runtime_id, status, sequence,
          event_type, summary, output_delta, output_offset_bytes, output_digest
        ) VALUES (
          'legacy-task', 'legacy-run', 'event-legacy', 'agent-legacy', 'runtime-legacy',
          'running', 0, 'message', '旧事件', '旧输出', 9, 'sha256:legacy-output'
        )
      `;
        yield* sql`
        INSERT INTO composition_squads (
          squad_id, name, leader_agent_id, member_agent_ids_json, instructions
        ) VALUES (
          'legacy-squad', '旧 Squad', 'agent-leader', '["agent-leader","agent-legacy"]',
          '保留旧协同配置'
        )
      `;

        yield* runMigrations({ toMigrationInclusive: 60 });

        const tasks = yield* sql<{ readonly taskId: string; readonly status: string }>`
        SELECT task_id AS "taskId", status
        FROM composition_tasks
        WHERE task_id = 'legacy-task'
      `;
        const runs = yield* sql<{
          readonly runId: string;
          readonly capabilityGrantIdsJson: string;
          readonly capabilityHandshakeId: string;
          readonly cancelRequestedAtUnixMs: number;
          readonly lastRuntimeEventAtUnixMs: number;
        }>`
        SELECT run_id AS "runId", capability_grant_ids_json AS "capabilityGrantIdsJson",
          capability_handshake_id AS "capabilityHandshakeId",
          cancel_requested_at_unix_ms AS "cancelRequestedAtUnixMs",
          last_runtime_event_at_unix_ms AS "lastRuntimeEventAtUnixMs"
        FROM composition_task_runs
        WHERE run_id = 'legacy-run'
      `;
        const events = yield* sql<{
          readonly sourceEventId: string;
          readonly outputDelta: string;
          readonly outputOffsetBytes: number;
          readonly outputDigest: string;
        }>`
        SELECT source_event_id AS "sourceEventId", output_delta AS "outputDelta",
          output_offset_bytes AS "outputOffsetBytes", output_digest AS "outputDigest"
        FROM composition_task_events
        WHERE task_id = 'legacy-task'
      `;
        const squads = yield* sql<{
          readonly squadId: string;
          readonly revision: number;
          readonly configurationJson: string | null;
        }>`
        SELECT squad_id AS "squadId", revision, configuration_json AS "configurationJson"
        FROM composition_squads
        WHERE squad_id = 'legacy-squad'
      `;

        assert.deepEqual(tasks, [{ taskId: "legacy-task", status: "running" }]);
        assert.deepEqual(runs, [
          {
            runId: "legacy-run",
            capabilityGrantIdsJson: '["grant-legacy"]',
            capabilityHandshakeId: "handshake-legacy",
            cancelRequestedAtUnixMs: 130,
            lastRuntimeEventAtUnixMs: 140,
          },
        ]);
        assert.deepEqual(events, [
          {
            sourceEventId: "event-legacy",
            outputDelta: "旧输出",
            outputOffsetBytes: 9,
            outputDigest: "sha256:legacy-output",
          },
        ]);
        assert.deepEqual(squads, [
          { squadId: "legacy-squad", revision: 1, configurationJson: null },
        ]);
      }),
    ),
  );

  it.effect("只追加 reconciliation 历史并保持重复运行为空操作", () =>
    withFreshDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedLegacyCompositionHistory(59);
        const before = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id IN (42, 43)
        ORDER BY migration_id
      `;

        const firstRun = yield* runMigrations({ toMigrationInclusive: 60 });
        const secondRun = yield* runMigrations({ toMigrationInclusive: 60 });
        const after = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id IN (42, 43, 60)
        ORDER BY migration_id
      `;

        assert.deepEqual(before, [
          { migrationId: 42, name: "CompositionTasks" },
          { migrationId: 43, name: "CompositionTaskEventSourceId" },
        ]);
        assert.deepEqual(firstRun, [[60, "CompositionMigrationHistoryReconciliation"]]);
        assert.deepEqual(secondRun, []);
        assert.deepEqual(after, [
          { migrationId: 42, name: "CompositionTasks" },
          { migrationId: 43, name: "CompositionTaskEventSourceId" },
          { migrationId: 60, name: "CompositionMigrationHistoryReconciliation" },
        ]);
      }),
    ),
  );

  it.effect("保留 Source Event、Multica 与 Squad 的关键唯一约束", () =>
    withFreshDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedLegacyCompositionHistory(59);
        yield* runMigrations({ toMigrationInclusive: 60 });

        yield* sql`
          INSERT INTO composition_task_events (
            task_id, run_id, source_event_id, agent_id, runtime_id, status,
            sequence, event_type, summary
          ) VALUES (
            'constraint-task', 'constraint-run', 'constraint-source',
            'constraint-agent', 'constraint-runtime', 'running',
            0, 'message', '第一条来源事件'
          )
        `;
        const duplicateSourceEvent = yield* Effect.result(sql`
          INSERT INTO composition_task_events (
            task_id, run_id, source_event_id, agent_id, runtime_id, status,
            sequence, event_type, summary
          ) VALUES (
            'constraint-task', 'constraint-run', 'constraint-source',
            'constraint-agent', 'constraint-runtime', 'running',
            1, 'message', '重复来源事件'
          )
        `);

        yield* sql`
          INSERT INTO composition_multica_quick_create_intents (
            run_id, task_id, runtime_id, idempotency_key, state,
            created_at_unix_ms, updated_at_unix_ms
          ) VALUES (
            'constraint-multica-run-1', 'constraint-task', 'constraint-multica-runtime',
            'constraint-idempotency-key', 'prepared', 1, 1
          )
        `;
        const duplicateMulticaKey = yield* Effect.result(sql`
          INSERT INTO composition_multica_quick_create_intents (
            run_id, task_id, runtime_id, idempotency_key, state,
            created_at_unix_ms, updated_at_unix_ms
          ) VALUES (
            'constraint-multica-run-2', 'constraint-task', 'constraint-multica-runtime',
            'constraint-idempotency-key', 'prepared', 2, 2
          )
        `);

        yield* sql`
          INSERT INTO composition_squad_revisions (
            squad_id, revision, configuration_json, created_at_unix_ms
          ) VALUES ('constraint-squad', 1, '{}', 1)
        `;
        const duplicateSquadRevision = yield* Effect.result(sql`
          INSERT INTO composition_squad_revisions (
            squad_id, revision, configuration_json, created_at_unix_ms
          ) VALUES ('constraint-squad', 1, '{"duplicate":true}', 2)
        `);

        assert.equal(duplicateSourceEvent._tag, "Failure");
        assert.equal(duplicateMulticaKey._tag, "Failure");
        assert.equal(duplicateSquadRevision._tag, "Failure");
      }),
    ),
  );
});
