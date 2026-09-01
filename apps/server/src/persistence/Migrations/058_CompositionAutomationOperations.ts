import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE composition_automation_runs
    ADD COLUMN operation_id TEXT
      CHECK (operation_id IS NULL OR length(trim(operation_id)) > 0)
  `;
  yield* sql`
    ALTER TABLE composition_automation_runs
    ADD COLUMN source_automation_run_id TEXT
      CHECK (
        source_automation_run_id IS NULL OR
        length(trim(source_automation_run_id)) > 0
      )
  `;

  yield* sql`
    CREATE UNIQUE INDEX idx_composition_automation_runs_operation
    ON composition_automation_runs(automation_id, operation_id)
    WHERE operation_id IS NOT NULL
  `;

  yield* sql`
    CREATE TRIGGER composition_automation_runs_operation_insert
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
    END
  `;

  yield* sql`
    CREATE TRIGGER composition_automation_runs_operation_update
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
    END
  `;
});
