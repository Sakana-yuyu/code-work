import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const intentsTable = "composition_run_start_intents";
const legacyIntentsTable = "composition_run_start_intents_legacy_reconciliation";

const canonicalIntentColumns = [
  "run_id",
  "task_id",
  "agent_id",
  "runtime_id",
  "attempt",
  "payload_digest",
  "capability_digest",
  "state",
  "revision",
  "claim_id",
  "claimed_at_unix_ms",
  "last_release_claim_id",
  "last_release_operation_id",
  "last_released_at_unix_ms",
  "runtime_task_id",
  "capability_handshake_id",
  "accepted_at_unix_ms",
  "outcome_code",
  "settled_at_unix_ms",
  "created_at_unix_ms",
  "updated_at_unix_ms",
] as const;

const requiredLegacyColumns = canonicalIntentColumns.filter(
  (column) =>
    column !== "last_release_claim_id" &&
    column !== "last_release_operation_id" &&
    column !== "last_released_at_unix_ms",
);

export const compositionRunStartIntentsTableSql = `CREATE TABLE ${intentsTable} (
  run_id TEXT PRIMARY KEY CHECK (length(trim(run_id)) > 0 AND length(run_id) <= 512),
  task_id TEXT NOT NULL CHECK (length(trim(task_id)) > 0 AND length(task_id) <= 512),
  agent_id TEXT NOT NULL CHECK (length(trim(agent_id)) > 0 AND length(agent_id) <= 512),
  runtime_id TEXT NOT NULL CHECK (length(trim(runtime_id)) > 0 AND length(runtime_id) <= 512),
  attempt INTEGER NOT NULL CHECK (
    typeof(attempt) = 'integer' AND attempt > 0 AND attempt <= 9007199254740991
  ),
  payload_digest TEXT NOT NULL CHECK (
    length(payload_digest) = 71 AND substr(payload_digest, 1, 7) = 'sha256:' AND
    substr(payload_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  capability_digest TEXT NOT NULL CHECK (
    length(capability_digest) = 71 AND substr(capability_digest, 1, 7) = 'sha256:' AND
    substr(capability_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (
    state IN ('prepared', 'dispatching', 'accepted', 'settled', 'indeterminate')
  ),
  revision INTEGER NOT NULL CHECK (
    typeof(revision) = 'integer' AND revision > 0 AND revision <= 9007199254740991
  ),
  claim_id TEXT CHECK (
    claim_id IS NULL OR (length(trim(claim_id)) > 0 AND length(claim_id) <= 512)
  ),
  claimed_at_unix_ms INTEGER CHECK (
    claimed_at_unix_ms IS NULL OR (
      typeof(claimed_at_unix_ms) = 'integer' AND
      claimed_at_unix_ms >= 0 AND claimed_at_unix_ms <= 9007199254740991
    )
  ),
  last_release_claim_id TEXT CHECK (
    last_release_claim_id IS NULL OR
    (length(trim(last_release_claim_id)) > 0 AND length(last_release_claim_id) <= 512)
  ),
  last_release_operation_id TEXT CHECK (
    last_release_operation_id IS NULL OR (
      length(trim(last_release_operation_id)) > 0 AND
      length(last_release_operation_id) <= 512
    )
  ),
  last_released_at_unix_ms INTEGER CHECK (
    last_released_at_unix_ms IS NULL OR (
      typeof(last_released_at_unix_ms) = 'integer' AND
      last_released_at_unix_ms >= 0 AND last_released_at_unix_ms <= 9007199254740991
    )
  ),
  runtime_task_id TEXT CHECK (
    runtime_task_id IS NULL OR
    (length(trim(runtime_task_id)) > 0 AND length(runtime_task_id) <= 2048)
  ),
  capability_handshake_id TEXT CHECK (
    capability_handshake_id IS NULL OR (
      length(trim(capability_handshake_id)) > 0 AND
      length(capability_handshake_id) <= 2048
    )
  ),
  accepted_at_unix_ms INTEGER CHECK (
    accepted_at_unix_ms IS NULL OR (
      typeof(accepted_at_unix_ms) = 'integer' AND
      accepted_at_unix_ms >= 0 AND accepted_at_unix_ms <= 9007199254740991
    )
  ),
  outcome_code TEXT CHECK (
    outcome_code IS NULL OR
    (length(trim(outcome_code)) > 0 AND length(outcome_code) <= 128)
  ),
  settled_at_unix_ms INTEGER CHECK (
    settled_at_unix_ms IS NULL OR (
      typeof(settled_at_unix_ms) = 'integer' AND
      settled_at_unix_ms >= 0 AND settled_at_unix_ms <= 9007199254740991
    )
  ),
  created_at_unix_ms INTEGER NOT NULL CHECK (
    typeof(created_at_unix_ms) = 'integer' AND
    created_at_unix_ms >= 0 AND created_at_unix_ms <= 9007199254740991
  ),
  updated_at_unix_ms INTEGER NOT NULL CHECK (
    typeof(updated_at_unix_ms) = 'integer' AND
    updated_at_unix_ms >= created_at_unix_ms AND updated_at_unix_ms <= 9007199254740991
  ),
  CHECK (claimed_at_unix_ms IS NULL OR claimed_at_unix_ms >= created_at_unix_ms),
  CHECK (
    (
      last_release_claim_id IS NULL AND
      last_release_operation_id IS NULL AND last_released_at_unix_ms IS NULL
    ) OR (
      last_release_claim_id IS NOT NULL AND
      last_release_operation_id IS NOT NULL AND last_released_at_unix_ms IS NOT NULL AND
      last_released_at_unix_ms >= created_at_unix_ms
    )
  ),
  CHECK (
    accepted_at_unix_ms IS NULL OR
    (claimed_at_unix_ms IS NOT NULL AND accepted_at_unix_ms >= claimed_at_unix_ms)
  ),
  CHECK (
    settled_at_unix_ms IS NULL OR
    (accepted_at_unix_ms IS NOT NULL AND settled_at_unix_ms >= accepted_at_unix_ms)
  ),
  CHECK (updated_at_unix_ms >= COALESCE(claimed_at_unix_ms, created_at_unix_ms)),
  CHECK (updated_at_unix_ms >= COALESCE(last_released_at_unix_ms, created_at_unix_ms)),
  CHECK (updated_at_unix_ms >= COALESCE(accepted_at_unix_ms, created_at_unix_ms)),
  CHECK (updated_at_unix_ms >= COALESCE(settled_at_unix_ms, created_at_unix_ms)),
  CHECK (
    (
      state = 'prepared' AND
      claim_id IS NULL AND claimed_at_unix_ms IS NULL AND
      runtime_task_id IS NULL AND capability_handshake_id IS NULL AND
      accepted_at_unix_ms IS NULL AND outcome_code IS NULL AND settled_at_unix_ms IS NULL
    ) OR (
      state = 'dispatching' AND
      claim_id IS NOT NULL AND claimed_at_unix_ms IS NOT NULL AND
      runtime_task_id IS NULL AND capability_handshake_id IS NULL AND
      accepted_at_unix_ms IS NULL AND outcome_code IS NULL AND settled_at_unix_ms IS NULL
    ) OR (
      state = 'accepted' AND
      claim_id IS NOT NULL AND claimed_at_unix_ms IS NOT NULL AND
      accepted_at_unix_ms IS NOT NULL AND outcome_code IS NULL AND settled_at_unix_ms IS NULL
    ) OR (
      state = 'settled' AND
      claim_id IS NOT NULL AND claimed_at_unix_ms IS NOT NULL AND
      accepted_at_unix_ms IS NOT NULL AND outcome_code IS NULL AND settled_at_unix_ms IS NOT NULL
    ) OR (
      state = 'indeterminate' AND
      claim_id IS NOT NULL AND claimed_at_unix_ms IS NOT NULL AND
      runtime_task_id IS NULL AND capability_handshake_id IS NULL AND
      accepted_at_unix_ms IS NULL AND outcome_code IS NOT NULL AND settled_at_unix_ms IS NULL
    )
  )
)`;

const releaseReceiptsTableSql = `CREATE TABLE IF NOT EXISTS composition_run_start_release_receipts (
  release_operation_id TEXT PRIMARY KEY CHECK (
    length(trim(release_operation_id)) > 0 AND length(release_operation_id) <= 512
  ),
  run_id TEXT NOT NULL CHECK (length(trim(run_id)) > 0 AND length(run_id) <= 512),
  claim_id TEXT NOT NULL CHECK (length(trim(claim_id)) > 0 AND length(claim_id) <= 512),
  released_at_unix_ms INTEGER NOT NULL CHECK (
    typeof(released_at_unix_ms) = 'integer' AND
    released_at_unix_ms >= 0 AND released_at_unix_ms <= 9007199254740991
  ),
  result_revision INTEGER NOT NULL CHECK (
    typeof(result_revision) = 'integer' AND
    result_revision > 0 AND result_revision <= 9007199254740991
  )
)`;

const quarantineTableSql = `CREATE TABLE IF NOT EXISTS composition_run_start_migration_quarantine (
  run_id TEXT PRIMARY KEY CHECK (length(trim(run_id)) > 0 AND length(run_id) <= 512),
  task_id TEXT NOT NULL CHECK (length(trim(task_id)) > 0 AND length(task_id) <= 512),
  agent_id TEXT NOT NULL CHECK (length(trim(agent_id)) > 0 AND length(agent_id) <= 512),
  runtime_id TEXT NOT NULL CHECK (length(trim(runtime_id)) > 0 AND length(runtime_id) <= 512),
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  claim_id TEXT,
  claimed_at_unix_ms INTEGER,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  reason_code TEXT NOT NULL CHECK (
    reason_code IN ('legacy_digest_invalid', 'legacy_capability_handshake_conflict')
  )
)`;

const normalizeSql = (value: string): string => value.replaceAll(/\s+/g, " ").trim().toLowerCase();

const canonicalDigestPredicate = (column: string): string =>
  `length(${column}) = 71 AND substr(${column}, 1, 7) = 'sha256:' AND ` +
  `substr(${column}, 8) NOT GLOB '*[^0-9a-f]*'`;

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const ensureAuxiliaryTables = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql.unsafe(releaseReceiptsTableSql).unprepared;
    yield* sql.unsafe(quarantineTableSql).unprepared;
  });

const ensureIndexes = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`DROP INDEX IF EXISTS composition_run_start_intents_unsettled_scan`;
    yield* sql`
      CREATE UNIQUE INDEX IF NOT EXISTS composition_run_start_intents_task_attempt_unique
      ON composition_run_start_intents(task_id, attempt)
    `;
    yield* sql`
      CREATE UNIQUE INDEX IF NOT EXISTS composition_run_start_intents_claim_id_unique
      ON composition_run_start_intents(claim_id)
      WHERE claim_id IS NOT NULL
    `;
    yield* sql`
      CREATE UNIQUE INDEX IF NOT EXISTS composition_run_start_intents_release_operation_unique
      ON composition_run_start_intents(last_release_operation_id)
      WHERE last_release_operation_id IS NOT NULL
    `;
    yield* sql`
      CREATE UNIQUE INDEX IF NOT EXISTS composition_run_start_intents_runtime_task_unique
      ON composition_run_start_intents(runtime_id, runtime_task_id)
      WHERE runtime_task_id IS NOT NULL
    `;
    yield* sql`
      CREATE UNIQUE INDEX IF NOT EXISTS composition_run_start_intents_capability_handshake_unique
      ON composition_run_start_intents(runtime_id, capability_handshake_id)
      WHERE capability_handshake_id IS NOT NULL
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS composition_run_start_intents_active_scan
      ON composition_run_start_intents(updated_at_unix_ms, run_id)
      WHERE state IN ('prepared', 'dispatching', 'accepted')
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS composition_run_start_intents_indeterminate_scan
      ON composition_run_start_intents(updated_at_unix_ms, run_id)
      WHERE state = 'indeterminate'
    `;
  });

const rebuildLegacyTable = (sql: SqlClient.SqlClient, legacyColumns: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const missingColumns = requiredLegacyColumns.filter((column) => !legacyColumns.has(column));
    if (missingColumns.length > 0) {
      return yield* Effect.die(
        new Error(`Run Start 旧表缺少安全迁移所需列：${missingColumns.join(", ")}`),
      );
    }

    yield* sql.unsafe(`DROP TABLE IF EXISTS ${legacyIntentsTable}`).unprepared;
    yield* sql.unsafe(`ALTER TABLE ${intentsTable} RENAME TO ${legacyIntentsTable}`).unprepared;
    yield* sql.unsafe(compositionRunStartIntentsTableSql).unprepared;

    const legacy = quoteIdentifier(legacyIntentsTable);
    const column = (name: (typeof canonicalIntentColumns)[number]): string =>
      legacyColumns.has(name) ? `legacy.${quoteIdentifier(name)}` : "NULL";
    const payloadDigestValid = canonicalDigestPredicate(column("payload_digest"));
    const capabilityDigestValid = canonicalDigestPredicate(column("capability_digest"));
    const duplicateHandshake = `
      ${column("capability_handshake_id")} IS NOT NULL AND EXISTS (
        SELECT 1 FROM ${legacy} AS duplicate
        WHERE duplicate.runtime_id = legacy.runtime_id
          AND duplicate.capability_handshake_id = legacy.capability_handshake_id
          AND duplicate.run_id <> legacy.run_id
      )
    `;
    const safeIntent = `(${payloadDigestValid}) AND (${capabilityDigestValid}) AND NOT (${duplicateHandshake})`;

    yield* sql.unsafe(`
        INSERT OR REPLACE INTO composition_run_start_migration_quarantine (
          run_id, task_id, agent_id, runtime_id, attempt, state, revision,
          claim_id, claimed_at_unix_ms, created_at_unix_ms, updated_at_unix_ms, reason_code
        )
        SELECT
          legacy.run_id, legacy.task_id, legacy.agent_id, legacy.runtime_id, legacy.attempt,
          legacy.state, legacy.revision, legacy.claim_id, legacy.claimed_at_unix_ms,
          legacy.created_at_unix_ms, legacy.updated_at_unix_ms,
          CASE
            WHEN NOT ((${payloadDigestValid}) AND (${capabilityDigestValid}))
              THEN 'legacy_digest_invalid'
            ELSE 'legacy_capability_handshake_conflict'
          END
        FROM ${legacy} AS legacy
        WHERE NOT (${safeIntent})
      `).unprepared;

    yield* sql.unsafe(`
        INSERT INTO ${intentsTable} (${canonicalIntentColumns.map(quoteIdentifier).join(", ")})
        SELECT ${canonicalIntentColumns.map((name) => column(name)).join(", ")}
        FROM ${legacy} AS legacy
        WHERE ${safeIntent}
      `).unprepared;

    if (
      legacyColumns.has("last_release_claim_id") &&
      legacyColumns.has("last_release_operation_id") &&
      legacyColumns.has("last_released_at_unix_ms")
    ) {
      const receiptConflicts = yield* sql.unsafe<{
        readonly count: number;
      }>(`
        SELECT COUNT(*) AS count
        FROM ${legacy} AS legacy
        JOIN composition_run_start_release_receipts AS receipt
          ON receipt.release_operation_id = legacy.last_release_operation_id
        WHERE legacy.last_release_operation_id IS NOT NULL AND (
          receipt.run_id <> legacy.run_id OR
          receipt.claim_id <> legacy.last_release_claim_id OR
          receipt.released_at_unix_ms <> legacy.last_released_at_unix_ms OR
          receipt.result_revision <> legacy.revision
        )
      `).unprepared;
      if ((receiptConflicts[0]?.count ?? 0) > 0) {
        return yield* Effect.die(
          new Error("Run Start release receipt 历史存在不可安全合并的冲突。"),
        );
      }

      yield* sql.unsafe(`
          INSERT OR IGNORE INTO composition_run_start_release_receipts (
            release_operation_id, run_id, claim_id, released_at_unix_ms, result_revision
          )
          SELECT
            legacy.last_release_operation_id, legacy.run_id, legacy.last_release_claim_id,
            legacy.last_released_at_unix_ms, legacy.revision
          FROM ${legacy} AS legacy
          WHERE legacy.last_release_operation_id IS NOT NULL
        `).unprepared;
    }

    yield* sql.unsafe(`DROP TABLE ${legacyIntentsTable}`).unprepared;
  });

export const reconcileCompositionRunStartSchema = Effect.fn("reconcileCompositionRunStartSchema")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureAuxiliaryTables(sql);

    const definitions = yield* sql<{ readonly sql: string | null }>`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = ${intentsTable}
  `;
    const definition = definitions[0]?.sql;
    if (definition === undefined || definition === null) {
      yield* sql.unsafe(compositionRunStartIntentsTableSql).unprepared;
    } else if (normalizeSql(definition) !== normalizeSql(compositionRunStartIntentsTableSql)) {
      const columns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info('composition_run_start_intents')
    `;
      yield* rebuildLegacyTable(sql, new Set(columns.map((column) => column.name)));
    }

    yield* ensureIndexes(sql);
  },
);
