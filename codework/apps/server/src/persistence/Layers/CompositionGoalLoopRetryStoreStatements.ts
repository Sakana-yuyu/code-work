import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  GoalLoopRetryIntentRowSchema,
  GoalLoopRetryQuarantineRowSchema,
} from "./CompositionGoalLoopRetryStoreInternal.ts";

const IntentId = Schema.Struct({ previousRunId: Schema.String });
const IntentNewRunId = Schema.Struct({ newRunId: Schema.String });
const PrepareIntent = Schema.Struct({
  taskId: Schema.String,
  previousRunId: Schema.String,
  newRunId: Schema.String,
  createdAtUnixMs: Schema.Number,
});
const AdvanceIntent = Schema.Struct({
  previousRunId: Schema.String,
  expectedRevision: Schema.Number,
  updatedAtUnixMs: Schema.Number,
});
const Page = Schema.Struct({ limit: Schema.Number });
const PageAfter = Schema.Struct({
  limit: Schema.Number,
  afterUpdatedAtUnixMs: Schema.Number,
  afterPreviousRunId: Schema.String,
});
const QuarantineIntent = Schema.Struct({
  previousRunId: Schema.String,
  expectedRevision: Schema.Number,
  outcomeCode: Schema.String,
  quarantinedAtUnixMs: Schema.Number,
});

export const makeCompositionGoalLoopRetryStoreStatements = (sql: SqlClient.SqlClient) => {
  const getIntentRow = SqlSchema.findOneOption({
    Request: IntentId,
    Result: GoalLoopRetryIntentRowSchema,
    execute: ({ previousRunId }) => sql`
      SELECT
        intent.task_id AS "taskId",
        intent.previous_run_id AS "previousRunId",
        intent.new_run_id AS "newRunId",
        intent.phase,
        intent.revision,
        intent.created_at_unix_ms AS "createdAtUnixMs",
        intent.updated_at_unix_ms AS "updatedAtUnixMs",
        quarantine.outcome_code AS "quarantineCode",
        quarantine.quarantined_at_unix_ms AS "quarantinedAtUnixMs"
      FROM composition_goal_loop_retry_intents AS intent
      LEFT JOIN composition_goal_loop_retry_quarantine AS quarantine
        ON quarantine.previous_run_id = intent.previous_run_id
      WHERE intent.previous_run_id = ${previousRunId}
      LIMIT 1
    `,
  });
  const getIntentByNewRunRow = SqlSchema.findOneOption({
    Request: IntentNewRunId,
    Result: GoalLoopRetryIntentRowSchema,
    execute: ({ newRunId }) => sql`
      SELECT
        intent.task_id AS "taskId",
        intent.previous_run_id AS "previousRunId",
        intent.new_run_id AS "newRunId",
        intent.phase,
        intent.revision,
        intent.created_at_unix_ms AS "createdAtUnixMs",
        intent.updated_at_unix_ms AS "updatedAtUnixMs",
        quarantine.outcome_code AS "quarantineCode",
        quarantine.quarantined_at_unix_ms AS "quarantinedAtUnixMs"
      FROM composition_goal_loop_retry_intents AS intent
      LEFT JOIN composition_goal_loop_retry_quarantine AS quarantine
        ON quarantine.previous_run_id = intent.previous_run_id
      WHERE intent.new_run_id = ${newRunId}
      LIMIT 1
    `,
  });
  const insertIntentRow = SqlSchema.findOneOption({
    Request: PrepareIntent,
    Result: GoalLoopRetryIntentRowSchema,
    execute: (input) => sql`
      INSERT INTO composition_goal_loop_retry_intents (
        previous_run_id, task_id, new_run_id, phase, revision,
        created_at_unix_ms, updated_at_unix_ms,
        dispatch_claim_id, dispatch_claimed_at_unix_ms
      ) VALUES (
        ${input.previousRunId}, ${input.taskId}, ${input.newRunId}, 'prepared', 1,
        ${input.createdAtUnixMs}, ${input.createdAtUnixMs}, NULL, NULL
      )
      ON CONFLICT DO NOTHING
      RETURNING
        task_id AS "taskId",
        previous_run_id AS "previousRunId",
        new_run_id AS "newRunId",
        phase,
        revision,
        created_at_unix_ms AS "createdAtUnixMs",
        updated_at_unix_ms AS "updatedAtUnixMs",
        NULL AS "quarantineCode",
        NULL AS "quarantinedAtUnixMs"
    `,
  });
  const listRecoverableRows = SqlSchema.findAll({
    Request: Page,
    Result: GoalLoopRetryIntentRowSchema,
    execute: ({ limit }) => sql`
      SELECT
        intent.task_id AS "taskId",
        intent.previous_run_id AS "previousRunId",
        intent.new_run_id AS "newRunId",
        intent.phase,
        intent.revision,
        intent.created_at_unix_ms AS "createdAtUnixMs",
        intent.updated_at_unix_ms AS "updatedAtUnixMs",
        NULL AS "quarantineCode",
        NULL AS "quarantinedAtUnixMs"
      FROM composition_goal_loop_retry_intents AS intent
      WHERE intent.phase IN ('prepared', 'settled')
        AND NOT EXISTS (
          SELECT 1 FROM composition_goal_loop_retry_quarantine AS quarantine
          WHERE quarantine.previous_run_id = intent.previous_run_id
        )
      ORDER BY intent.updated_at_unix_ms ASC, intent.previous_run_id ASC
      LIMIT ${limit}
    `,
  });
  const listRecoverableRowsAfter = SqlSchema.findAll({
    Request: PageAfter,
    Result: GoalLoopRetryIntentRowSchema,
    execute: (input) => sql`
      SELECT
        intent.task_id AS "taskId",
        intent.previous_run_id AS "previousRunId",
        intent.new_run_id AS "newRunId",
        intent.phase,
        intent.revision,
        intent.created_at_unix_ms AS "createdAtUnixMs",
        intent.updated_at_unix_ms AS "updatedAtUnixMs",
        NULL AS "quarantineCode",
        NULL AS "quarantinedAtUnixMs"
      FROM composition_goal_loop_retry_intents AS intent
      WHERE intent.phase IN ('prepared', 'settled')
        AND NOT EXISTS (
          SELECT 1 FROM composition_goal_loop_retry_quarantine AS quarantine
          WHERE quarantine.previous_run_id = intent.previous_run_id
        )
        AND (
          intent.updated_at_unix_ms > ${input.afterUpdatedAtUnixMs}
          OR (
            intent.updated_at_unix_ms = ${input.afterUpdatedAtUnixMs}
            AND intent.previous_run_id > ${input.afterPreviousRunId}
          )
        )
      ORDER BY intent.updated_at_unix_ms ASC, intent.previous_run_id ASC
      LIMIT ${input.limit}
    `,
  });
  const settleIntentRow = SqlSchema.findOneOption({
    Request: AdvanceIntent,
    Result: GoalLoopRetryIntentRowSchema,
    execute: (input) => sql`
      UPDATE composition_goal_loop_retry_intents AS intent
      SET phase = 'settled', revision = revision + 1,
        updated_at_unix_ms = ${input.updatedAtUnixMs}
      WHERE previous_run_id = ${input.previousRunId}
        AND phase = 'prepared'
        AND revision = ${input.expectedRevision}
        AND ${input.updatedAtUnixMs} >= updated_at_unix_ms
        AND NOT EXISTS (
          SELECT 1 FROM composition_goal_loop_retry_quarantine AS quarantine
          WHERE quarantine.previous_run_id = intent.previous_run_id
        )
      RETURNING
        task_id AS "taskId",
        previous_run_id AS "previousRunId",
        new_run_id AS "newRunId",
        phase,
        revision,
        created_at_unix_ms AS "createdAtUnixMs",
        updated_at_unix_ms AS "updatedAtUnixMs",
        NULL AS "quarantineCode",
        NULL AS "quarantinedAtUnixMs"
    `,
  });
  const dispatchIntentRow = SqlSchema.findOneOption({
    Request: AdvanceIntent,
    Result: GoalLoopRetryIntentRowSchema,
    execute: (input) => sql`
      UPDATE composition_goal_loop_retry_intents AS intent
      SET phase = 'dispatched', revision = revision + 1,
        updated_at_unix_ms = ${input.updatedAtUnixMs},
        dispatch_claim_id = NULL,
        dispatch_claimed_at_unix_ms = NULL
      WHERE previous_run_id = ${input.previousRunId}
        AND phase = 'settled'
        AND revision = ${input.expectedRevision}
        AND ${input.updatedAtUnixMs} >= updated_at_unix_ms
        AND NOT EXISTS (
          SELECT 1 FROM composition_goal_loop_retry_quarantine AS quarantine
          WHERE quarantine.previous_run_id = intent.previous_run_id
        )
      RETURNING
        task_id AS "taskId",
        previous_run_id AS "previousRunId",
        new_run_id AS "newRunId",
        phase,
        revision,
        created_at_unix_ms AS "createdAtUnixMs",
        updated_at_unix_ms AS "updatedAtUnixMs",
        NULL AS "quarantineCode",
        NULL AS "quarantinedAtUnixMs"
    `,
  });
  const insertQuarantineRow = SqlSchema.findOneOption({
    Request: QuarantineIntent,
    Result: GoalLoopRetryQuarantineRowSchema,
    execute: (input) => sql`
      INSERT INTO composition_goal_loop_retry_quarantine (
        previous_run_id, outcome_code, quarantined_at_unix_ms
      )
      SELECT previous_run_id, ${input.outcomeCode}, ${input.quarantinedAtUnixMs}
      FROM composition_goal_loop_retry_intents
      WHERE previous_run_id = ${input.previousRunId}
        AND revision = ${input.expectedRevision}
        AND phase IN ('prepared', 'settled')
      ON CONFLICT DO NOTHING
      RETURNING
        previous_run_id AS "previousRunId",
        outcome_code AS "outcomeCode",
        quarantined_at_unix_ms AS "quarantinedAtUnixMs"
    `,
  });
  const getQuarantineRow = SqlSchema.findOneOption({
    Request: IntentId,
    Result: GoalLoopRetryQuarantineRowSchema,
    execute: ({ previousRunId }) => sql`
      SELECT
        previous_run_id AS "previousRunId",
        outcome_code AS "outcomeCode",
        quarantined_at_unix_ms AS "quarantinedAtUnixMs"
      FROM composition_goal_loop_retry_quarantine
      WHERE previous_run_id = ${previousRunId}
      LIMIT 1
    `,
  });

  return {
    getIntentRow,
    getIntentByNewRunRow,
    insertIntentRow,
    listRecoverableRows,
    listRecoverableRowsAfter,
    settleIntentRow,
    dispatchIntentRow,
    insertQuarantineRow,
    getQuarantineRow,
  };
};
