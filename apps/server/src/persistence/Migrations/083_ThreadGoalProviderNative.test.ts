import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("083_ThreadGoalProviderNative", (it) => {
  it.effect("新增 provider_native 标记列，既有 Goal 默认非原生", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 82 });

      yield* sql`
        INSERT INTO thread_goals (
          thread_id, goal_id, objective, status,
          tokens_used, time_used_seconds, token_budget,
          created_at_unix_ms, updated_at_unix_ms, active_started_at_unix_ms,
          revision
        ) VALUES (
          'thread-legacy', 'goal-legacy', '既有目标', 'active',
          0, 0, NULL, 1, 1, 1, 1
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 83 });

      const rows = yield* sql<{ readonly providerNative: number }>`
        SELECT provider_native AS "providerNative" FROM thread_goals
      `;
      assert.deepEqual(rows, [{ providerNative: 0 }]);

      yield* sql`
        INSERT INTO thread_goals (
          thread_id, goal_id, objective, status,
          tokens_used, time_used_seconds, token_budget,
          created_at_unix_ms, updated_at_unix_ms, active_started_at_unix_ms,
          revision, provider_native
        ) VALUES (
          'thread-native', 'goal-native', '原生目标', 'active',
          0, 0, NULL, 2, 2, 2, 1, 1
        )
      `;
      const nativeRows = yield* sql<{ readonly providerNative: number }>`
        SELECT provider_native AS "providerNative" FROM thread_goals
        WHERE thread_id = 'thread-native'
      `;
      assert.deepEqual(nativeRows, [{ providerNative: 1 }]);
    }),
  );
});
