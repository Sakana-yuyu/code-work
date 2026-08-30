import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export type FrozenRunStartHistory =
  | "8f-065"
  | "8f-065-invalid-digest"
  | "8d-066"
  | "2eb-066-release"
  | "689-066-strict-replay"
  | "30c-066-strict"
  | "992-066-old-scan";

type FrozenSchemaOptions = {
  readonly migrationId: 65 | 66;
  readonly replayPolicy: boolean;
  readonly releaseReceipt: boolean;
  readonly strictDigest: boolean;
  readonly oldScanIndex: boolean;
  readonly rowKind:
    | "dispatching"
    | "invalid-dispatching"
    | "released"
    | "accepted"
    | "indeterminate";
};

const optionsByHistory: Record<FrozenRunStartHistory, FrozenSchemaOptions> = {
  "8f-065": {
    migrationId: 65,
    replayPolicy: true,
    releaseReceipt: false,
    strictDigest: false,
    oldScanIndex: false,
    rowKind: "dispatching",
  },
  "8f-065-invalid-digest": {
    migrationId: 65,
    replayPolicy: true,
    releaseReceipt: false,
    strictDigest: false,
    oldScanIndex: false,
    rowKind: "invalid-dispatching",
  },
  "8d-066": {
    migrationId: 66,
    replayPolicy: true,
    releaseReceipt: false,
    strictDigest: false,
    oldScanIndex: false,
    rowKind: "dispatching",
  },
  "2eb-066-release": {
    migrationId: 66,
    replayPolicy: true,
    releaseReceipt: true,
    strictDigest: false,
    oldScanIndex: false,
    rowKind: "released",
  },
  "689-066-strict-replay": {
    migrationId: 66,
    replayPolicy: true,
    releaseReceipt: true,
    strictDigest: true,
    oldScanIndex: false,
    rowKind: "accepted",
  },
  "30c-066-strict": {
    migrationId: 66,
    replayPolicy: false,
    releaseReceipt: true,
    strictDigest: true,
    oldScanIndex: false,
    rowKind: "indeterminate",
  },
  "992-066-old-scan": {
    migrationId: 66,
    replayPolicy: false,
    releaseReceipt: true,
    strictDigest: true,
    oldScanIndex: true,
    rowKind: "accepted",
  },
};

const digestColumn = (name: string, strict: boolean): string =>
  strict
    ? `${name} TEXT NOT NULL CHECK (
        length(${name}) = 71 AND substr(${name}, 1, 7) = 'sha256:' AND
        substr(${name}, 8) NOT GLOB '*[^0-9a-f]*'
      )`
    : `${name} TEXT NOT NULL CHECK (
        length(trim(${name})) > 0 AND length(${name}) <= 512
      )`;

const makeFrozenTableSql = (options: FrozenSchemaOptions): string => {
  const columns = [
    "run_id TEXT PRIMARY KEY CHECK (length(trim(run_id)) > 0 AND length(run_id) <= 512)",
    "task_id TEXT NOT NULL CHECK (length(trim(task_id)) > 0 AND length(task_id) <= 512)",
    "agent_id TEXT NOT NULL CHECK (length(trim(agent_id)) > 0 AND length(agent_id) <= 512)",
    "runtime_id TEXT NOT NULL CHECK (length(trim(runtime_id)) > 0 AND length(runtime_id) <= 512)",
    "attempt INTEGER NOT NULL CHECK (typeof(attempt) = 'integer' AND attempt > 0)",
    ...(options.replayPolicy
      ? [
          "replay_policy TEXT NOT NULL CHECK (replay_policy IN ('idempotent','reconcile','fail_closed'))",
        ]
      : []),
    digestColumn("payload_digest", options.strictDigest),
    digestColumn("capability_digest", options.strictDigest),
    "state TEXT NOT NULL CHECK (state IN ('prepared','dispatching','accepted','settled','indeterminate'))",
    "revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision > 0)",
    "claim_id TEXT",
    "claimed_at_unix_ms INTEGER",
    ...(options.releaseReceipt
      ? [
          "last_release_claim_id TEXT",
          "last_release_operation_id TEXT",
          "last_released_at_unix_ms INTEGER",
        ]
      : []),
    "runtime_task_id TEXT",
    "capability_handshake_id TEXT",
    "accepted_at_unix_ms INTEGER",
    "outcome_code TEXT",
    "settled_at_unix_ms INTEGER",
    "created_at_unix_ms INTEGER NOT NULL",
    "updated_at_unix_ms INTEGER NOT NULL",
  ];
  return `CREATE TABLE composition_run_start_intents (\n${columns.join(",\n")}\n)`;
};

const makeFrozenRowSql = (history: FrozenRunStartHistory, options: FrozenSchemaOptions): string => {
  const runId = `legacy-${history}`;
  const columns = [
    "run_id",
    "task_id",
    "agent_id",
    "runtime_id",
    "attempt",
    ...(options.replayPolicy ? ["replay_policy"] : []),
    "payload_digest",
    "capability_digest",
    "state",
    "revision",
    "claim_id",
    "claimed_at_unix_ms",
    ...(options.releaseReceipt
      ? ["last_release_claim_id", "last_release_operation_id", "last_released_at_unix_ms"]
      : []),
    "runtime_task_id",
    "capability_handshake_id",
    "accepted_at_unix_ms",
    "outcome_code",
    "settled_at_unix_ms",
    "created_at_unix_ms",
    "updated_at_unix_ms",
  ];
  const validPayload = `sha256:${"a".repeat(64)}`;
  const validCapability = `sha256:${"b".repeat(64)}`;
  const invalid = options.rowKind === "invalid-dispatching";
  const state =
    options.rowKind === "released"
      ? "prepared"
      : options.rowKind === "accepted"
        ? "accepted"
        : options.rowKind === "indeterminate"
          ? "indeterminate"
          : "dispatching";
  const revision = options.rowKind === "released" ? 3 : state === "dispatching" ? 2 : 3;
  const claimId = options.rowKind === "released" ? null : `claim-${history}`;
  const claimedAt = options.rowKind === "released" ? null : 110;
  const values: ReadonlyArray<string | number | null> = [
    runId,
    `task-${history}`,
    `agent-${history}`,
    `runtime-${history}`,
    2,
    ...(options.replayPolicy ? ["fail_closed"] : []),
    invalid ? "执行旧版原始 prompt" : validPayload,
    invalid ? '["filesystem.write"]' : validCapability,
    state,
    revision,
    claimId,
    claimedAt,
    ...(options.releaseReceipt
      ? [
          options.rowKind === "released" ? `claim-${history}` : null,
          options.rowKind === "released" ? `release-${history}` : null,
          options.rowKind === "released" ? 120 : null,
        ]
      : []),
    state === "accepted" ? `runtime-task-${history}` : null,
    state === "accepted" ? `handshake-${history}` : null,
    state === "accepted" ? 120 : null,
    state === "indeterminate" ? "legacy_driver_unknown" : null,
    null,
    100,
    state === "accepted"
      ? 120
      : state === "indeterminate"
        ? 130
        : options.rowKind === "released"
          ? 120
          : 110,
  ];
  const encoded = values
    .map((value) =>
      value === null
        ? "NULL"
        : typeof value === "number"
          ? String(value)
          : `'${value.replaceAll("'", "''")}'`,
    )
    .join(", ");
  return `INSERT INTO composition_run_start_intents (${columns.join(", ")}) VALUES (${encoded})`;
};

export const applyFrozenRunStartHistory = (history: FrozenRunStartHistory) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const options = optionsByHistory[history];
    yield* sql.unsafe(makeFrozenTableSql(options)).unprepared;
    yield* sql`
      CREATE UNIQUE INDEX composition_run_start_intents_task_attempt_unique
      ON composition_run_start_intents(task_id, attempt)
    `;
    yield* sql`
      CREATE UNIQUE INDEX composition_run_start_intents_claim_id_unique
      ON composition_run_start_intents(claim_id)
      WHERE claim_id IS NOT NULL
    `;
    if (options.releaseReceipt) {
      yield* sql`
        CREATE UNIQUE INDEX composition_run_start_intents_release_operation_unique
        ON composition_run_start_intents(last_release_operation_id)
        WHERE last_release_operation_id IS NOT NULL
      `;
    }
    yield* sql`
      CREATE UNIQUE INDEX composition_run_start_intents_runtime_task_unique
      ON composition_run_start_intents(runtime_id, runtime_task_id)
      WHERE runtime_task_id IS NOT NULL
    `;
    if (options.oldScanIndex) {
      yield* sql`
        CREATE INDEX composition_run_start_intents_unsettled_scan
        ON composition_run_start_intents(state, updated_at_unix_ms, run_id)
      `;
    }
    yield* sql.unsafe(makeFrozenRowSql(history, options)).unprepared;
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (${options.migrationId}, 'CompositionRunStartIntents')
    `;
  });

export const applyFrozenGoalLoopLedger65 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO effect_sql_migrations (migration_id, name)
    VALUES (65, 'CompositionGoalLoopRetryIntents')
  `;
});
