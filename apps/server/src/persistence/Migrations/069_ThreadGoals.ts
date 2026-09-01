import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE thread_goals (
      thread_id TEXT PRIMARY KEY
        CHECK (length(trim(thread_id)) > 0 AND length(thread_id) <= 512),
      goal_id TEXT NOT NULL UNIQUE
        CHECK (length(trim(goal_id)) > 0 AND length(goal_id) <= 512),
      objective TEXT NOT NULL
        CHECK (length(trim(objective)) > 0 AND length(objective) <= 4000),
      status TEXT NOT NULL
        CHECK (status IN ('active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete')),
      token_budget INTEGER
        CHECK (token_budget IS NULL OR token_budget >= 0),
      tokens_used INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
      time_used_seconds INTEGER NOT NULL DEFAULT 0 CHECK (time_used_seconds >= 0),
      created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
      updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= created_at_unix_ms),
      active_started_at_unix_ms INTEGER
        CHECK (active_started_at_unix_ms IS NULL OR active_started_at_unix_ms >= created_at_unix_ms),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
    )
  `;

  yield* sql`
    CREATE INDEX idx_thread_goals_status
    ON thread_goals(status, updated_at_unix_ms DESC)
  `;
});
