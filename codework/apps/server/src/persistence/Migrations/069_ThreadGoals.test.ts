import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const migrationLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

migrationLayer("069_ThreadGoals", (it) => {
  it.effect("创建线程 Goal 表、唯一索引和状态约束，并保持重复迁移幂等", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 68 });

      const executed = yield* runMigrations({ toMigrationInclusive: 69 });
      const repeated = yield* runMigrations({ toMigrationInclusive: 69 });
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info('thread_goals')
      `;
      const indexes = yield* sql<{ readonly name: string; readonly sql: string }>`
        SELECT name, sql
        FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_thread_goals_status'
      `;
      const invalidStatus = yield* Effect.result(sql`
        INSERT INTO thread_goals (
          thread_id, goal_id, objective, status, token_budget, tokens_used,
          time_used_seconds, created_at_unix_ms, updated_at_unix_ms,
          active_started_at_unix_ms, revision
        ) VALUES ('thread-1', 'goal-1', 'Ship it', 'unknown', NULL, 0, 0, 1, 1, 1, 1)
      `);

      assert.deepEqual(executed, [[69, "ThreadGoals"]]);
      assert.deepEqual(repeated, []);
      assert.deepEqual(
        columns.map((column) => column.name),
        [
          "thread_id",
          "goal_id",
          "objective",
          "status",
          "token_budget",
          "tokens_used",
          "time_used_seconds",
          "created_at_unix_ms",
          "updated_at_unix_ms",
          "active_started_at_unix_ms",
          "revision",
        ],
      );
      assert.equal(indexes.length, 1);
      assert.isTrue(indexes[0]?.sql.includes("status"));
      assert.equal(invalidStatus._tag, "Failure");
    }),
  );
});
