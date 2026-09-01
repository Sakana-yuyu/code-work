import type { WorkspaceScriptRun } from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import {
  WorkspaceScriptStore,
  WorkspaceScriptStoreDomainError,
} from "../Services/WorkspaceScriptStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { WorkspaceScriptStoreLive } from "./WorkspaceScriptStore.ts";

const layer = it.layer(WorkspaceScriptStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));
const recoveryLayer = it.layer(
  WorkspaceScriptStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const corruptionLayer = it.layer(
  WorkspaceScriptStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const assertDomainError = (error: unknown): WorkspaceScriptStoreDomainError => {
  assert.instanceOf(error, WorkspaceScriptStoreDomainError);
  return error as WorkspaceScriptStoreDomainError;
};

const claimAttempt = (
  ownerId: string,
  claimedAtUnixMs: number,
  claimExpiresAtUnixMs = claimedAtUnixMs + 30_000,
) => ({
  claimOwnerId: ownerId,
  claimedAtUnixMs,
  claimExpiresAtUnixMs,
});

const makeRun = (
  workspaceScriptRunId: string,
  overrides: Partial<WorkspaceScriptRun> = {},
): WorkspaceScriptRun => ({
  workspaceScriptRunId,
  idempotencyKey: `workspace-script:key:${workspaceScriptRunId}`,
  projectId: "project-1",
  threadId: "thread-1",
  scriptId: "serve",
  scriptName: "启动服务",
  terminalId: `terminal:${workspaceScriptRunId}`,
  cwd: "E:/workspace/project-1",
  worktreePath: null,
  status: "starting",
  healthStatus: "unknown",
  healthCheckedAtUnixMs: null,
  healthDetail: null,
  ports: [],
  revision: 1,
  requestedAtUnixMs: 1_000,
  startedAtUnixMs: null,
  finishedAtUnixMs: null,
  exitCode: null,
  exitSignal: null,
  errorCode: null,
  errorDetail: null,
  compositionTaskId: null,
  compositionRunId: null,
  updatedAtUnixMs: 1_000,
  ...overrides,
});

layer("WorkspaceScriptStore", (it) => {
  it.effect("原子 claimStart 对相同身份幂等，对冲突身份 fail-closed", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceScriptStore;
      const run = makeRun("run-claim");

      const first = yield* store.claimStart(run);
      const repeated = yield* store.claimStart(run);
      const concurrentReplay = yield* store.claimStart({
        ...run,
        requestedAtUnixMs: 1_001,
        updatedAtUnixMs: 1_001,
      });
      const conflict = yield* store
        .claimStart({ ...run, idempotencyKey: "workspace-script:key:other" })
        .pipe(Effect.flip);
      const idempotencyConflict = yield* store
        .claimStart(
          makeRun("run-claim-other", {
            idempotencyKey: run.idempotencyKey,
            terminalId: "terminal:run-claim-other",
          }),
        )
        .pipe(Effect.flip);

      assert.isTrue(first.claimed);
      assert.isFalse(repeated.claimed);
      assert.isFalse(concurrentReplay.claimed);
      assert.equal(repeated.run.workspaceScriptRunId, run.workspaceScriptRunId);
      assert.equal(assertDomainError(conflict).code, "workspace_script_run_conflict");
      assert.equal(assertDomainError(idempotencyConflict).code, "workspace_script_run_conflict");
    }),
  );

  it.effect("CAS transition 保持不可变身份并拒绝过期 revision", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceScriptStore;
      const starting = makeRun("run-transition");
      yield* store.claimStart(starting);
      const running: WorkspaceScriptRun = {
        ...starting,
        status: "running",
        revision: 2,
        startedAtUnixMs: 1_100,
        updatedAtUnixMs: 1_100,
      };

      const saved = yield* store.saveTransition({ run: running, expectedRevision: 1 });
      const stale = yield* store
        .saveTransition({
          run: { ...running, revision: 3, updatedAtUnixMs: 1_200 },
          expectedRevision: 1,
        })
        .pipe(Effect.flip);
      const identityMutation = yield* store
        .saveTransition({
          run: { ...running, revision: 3, scriptId: "other", updatedAtUnixMs: 1_200 },
          expectedRevision: 2,
        })
        .pipe(Effect.flip);
      const skippedRevision = yield* store
        .saveTransition({
          run: { ...running, revision: 4, updatedAtUnixMs: 1_200 },
          expectedRevision: 2,
        })
        .pipe(Effect.flip);

      assert.equal(saved.status, "running");
      assert.equal(assertDomainError(stale).code, "workspace_script_revision_conflict");
      assert.equal(assertDomainError(identityMutation).code, "workspace_script_run_conflict");
      assert.equal(assertDomainError(skippedRevision).code, "workspace_script_revision_conflict");
    }),
  );

  it.effect("claimStop 持久化 operationId，同一操作不重复领取", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceScriptStore;
      const running = makeRun("run-stop", {
        status: "running",
        revision: 2,
        startedAtUnixMs: 1_100,
        updatedAtUnixMs: 1_100,
      });
      yield* store.claimStart(running);
      const stopping: WorkspaceScriptRun = {
        ...running,
        status: "stopping",
        revision: 3,
        updatedAtUnixMs: 1_200,
      };

      const first = yield* store.claimStop({
        operationId: "stop-operation-1",
        expectedRevision: 2,
        run: stopping,
        ...claimAttempt("service-a:attempt-1", 1_200),
      });
      const repeated = yield* store.claimStop({
        operationId: "stop-operation-1",
        expectedRevision: 2,
        run: stopping,
        ...claimAttempt("service-b:attempt-1", 1_200),
      });
      const conflict = yield* store
        .claimStop({
          operationId: "stop-operation-1",
          expectedRevision: 1,
          run: { ...stopping, workspaceScriptRunId: "other-run" },
          ...claimAttempt("service-c:attempt-1", 1_200),
        })
        .pipe(Effect.flip);
      const competingStop = yield* store
        .claimStop({
          operationId: "stop-operation-2",
          expectedRevision: 3,
          run: { ...stopping, revision: 4, updatedAtUnixMs: 1_300 },
          ...claimAttempt("service-d:attempt-1", 1_300),
        })
        .pipe(Effect.flip);

      assert.isTrue(first.claimed);
      assert.isFalse(repeated.claimed);
      assert.equal(repeated.run.revision, 3);
      assert.equal(assertDomainError(conflict).code, "workspace_script_stop_operation_conflict");
      assert.equal(
        assertDomainError(competingStop).code,
        "workspace_script_stop_operation_conflict",
      );
    }),
  );

  it.effect("同一 stop operation 只从持久化可重试状态原子重领一次", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceScriptStore;
      const running = makeRun("run-stop-retry", {
        status: "running",
        revision: 2,
        startedAtUnixMs: 1_100,
        updatedAtUnixMs: 1_100,
      });
      yield* store.claimStart(running);
      const first = yield* store.claimStop({
        operationId: "stop-operation-retry",
        expectedRevision: 2,
        run: {
          ...running,
          status: "stopping",
          revision: 3,
          updatedAtUnixMs: 1_200,
        },
        ...claimAttempt("service-a:attempt-1", 1_200),
      });
      const retryable = yield* store.saveTransition({
        expectedRevision: first.run.revision,
        run: {
          ...first.run,
          status: "running",
          revision: first.run.revision + 1,
          updatedAtUnixMs: 1_300,
        },
      });
      const retryRequest = {
        operationId: "stop-operation-retry",
        expectedRevision: 2,
        run: {
          ...retryable,
          status: "stopping" as const,
          revision: retryable.revision + 1,
          updatedAtUnixMs: 1_400,
        },
        ...claimAttempt("service-b:attempt-1", 31_201),
      };

      const [retry, concurrentReplay] = yield* Effect.all(
        [store.claimStop(retryRequest), store.claimStop(retryRequest)],
        { concurrency: "unbounded" },
      );

      assert.isTrue(retry.claimed || concurrentReplay.claimed);
      assert.isFalse(retry.claimed && concurrentReplay.claimed);
      assert.equal(retry.run.status, "stopping");
      assert.equal(concurrentReplay.run.status, "stopping");
      assert.equal(retry.run.revision, 5);
      assert.equal(concurrentReplay.run.revision, 5);
    }),
  );

  it.effect("查询按终端和筛选条件返回持久化投影", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceScriptStore;
      const run = makeRun("run-query", {
        projectId: "project-query",
        status: "running",
        revision: 2,
        startedAtUnixMs: 1_100,
        updatedAtUnixMs: 1_100,
      });
      const otherThread = makeRun("run-query-other-thread", {
        projectId: "project-query",
        threadId: "thread-2",
        status: "running",
        revision: 2,
        startedAtUnixMs: 1_100,
        updatedAtUnixMs: 1_100,
      });
      yield* store.claimStart(run);
      yield* store.claimStart(otherThread);

      assert.equal(
        Option.getOrThrow(yield* store.getRun(run.workspaceScriptRunId)).terminalId,
        run.terminalId,
      );
      assert.equal(
        Option.getOrThrow(yield* store.getActiveRunByTerminal(run.threadId, run.terminalId)).run
          .workspaceScriptRunId,
        run.workspaceScriptRunId,
      );
      assert.deepEqual(
        (yield* store.listRuns({
          projectId: "project-query",
          threadId: "thread-1",
          statuses: ["running"],
        })).map((item) => item.workspaceScriptRunId),
        [run.workspaceScriptRunId],
      );
    }),
  );
});

corruptionLayer("WorkspaceScriptStore corruption guard", (it) => {
  it.effect("破损停止 claim 必须 fail-closed，不能按过期 claim 静默接管", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceScriptStore;
      const sql = yield* SqlClient.SqlClient;
      const running = makeRun("run-stop-corrupt-claim", {
        status: "running",
        revision: 2,
        startedAtUnixMs: 1_100,
        updatedAtUnixMs: 1_100,
      });
      yield* store.claimStart(running);
      yield* store.claimStop({
        operationId: "stop-operation-corrupt-claim",
        expectedRevision: running.revision,
        run: {
          ...running,
          status: "stopping",
          revision: running.revision + 1,
          updatedAtUnixMs: 1_200,
        },
        ...claimAttempt("service-a:corrupt", 1_200),
      });
      yield* sql`DROP TRIGGER trg_workspace_script_stop_claim_update`;
      yield* sql`
        UPDATE workspace_script_runs
        SET stop_claim_expires_at_unix_ms = NULL
        WHERE workspace_script_run_id = ${running.workspaceScriptRunId}
      `;

      const error = yield* store
        .getActiveRunByTerminal(running.threadId, running.terminalId)
        .pipe(Effect.flip);

      assert.instanceOf(error, PersistenceDecodeError);
      assert.equal(error.operation, "WorkspaceScriptStore.getActiveRunByTerminal:stopClaim");
      assert.equal(error.issue, "InvalidClaimExpiry");
    }),
  );
});

recoveryLayer("WorkspaceScriptStore recovery", (it) => {
  it.effect("服务重启返回 stopping 与 running stop intent，并将其他未收敛 Run 原子标记为失败", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceScriptStore;
      const starting = makeRun("run-recover-starting");
      const running = makeRun("run-recover-running", {
        status: "running",
        revision: 2,
        startedAtUnixMs: 1_100,
        updatedAtUnixMs: 1_100,
      });
      const stopping = makeRun("run-recover-stopping", {
        status: "running",
        revision: 2,
        startedAtUnixMs: 1_100,
        updatedAtUnixMs: 1_100,
      });
      const retryableRun = makeRun("run-recover-retryable", {
        status: "running",
        revision: 2,
        startedAtUnixMs: 1_100,
        updatedAtUnixMs: 1_100,
      });
      const exited = makeRun("run-recover-exited", {
        status: "exited",
        revision: 3,
        startedAtUnixMs: 1_100,
        finishedAtUnixMs: 1_200,
        exitCode: 0,
        updatedAtUnixMs: 1_200,
      });
      yield* store.claimStart(starting);
      yield* store.claimStart(running);
      yield* store.claimStart(stopping);
      yield* store.claimStart(retryableRun);
      yield* store.claimStart(exited);
      yield* store.claimStop({
        operationId: "stop-operation-recovery",
        expectedRevision: stopping.revision,
        run: {
          ...stopping,
          status: "stopping",
          revision: stopping.revision + 1,
          updatedAtUnixMs: 1_200,
        },
        ...claimAttempt("service-a:recovery", 1_200),
      });
      const retryableClaim = yield* store.claimStop({
        operationId: "stop-operation-retryable-recovery",
        expectedRevision: retryableRun.revision,
        run: {
          ...retryableRun,
          status: "stopping",
          revision: retryableRun.revision + 1,
          updatedAtUnixMs: 1_200,
        },
        ...claimAttempt("service-a:retryable", 1_200),
      });
      yield* store.saveTransition({
        expectedRevision: retryableClaim.run.revision,
        run: {
          ...retryableClaim.run,
          status: "running",
          revision: retryableClaim.run.revision + 1,
          updatedAtUnixMs: 1_300,
        },
      });

      const recovered = yield* store.recoverInterrupted({ observedAtUnixMs: 2_000 });
      const repeated = yield* store.recoverInterrupted({ observedAtUnixMs: 2_100 });
      const failed = Option.getOrThrow(yield* store.getRun(starting.workspaceScriptRunId));
      const retryable = Option.getOrThrow(yield* store.getRun(stopping.workspaceScriptRunId));
      const preserved = Option.getOrThrow(yield* store.getRun(exited.workspaceScriptRunId));

      assert.deepEqual(
        recovered.map(({ run }) => run.workspaceScriptRunId),
        [
          retryableRun.workspaceScriptRunId,
          running.workspaceScriptRunId,
          starting.workspaceScriptRunId,
          stopping.workspaceScriptRunId,
        ],
      );
      assert.equal(
        recovered.find(({ run }) => run.workspaceScriptRunId === stopping.workspaceScriptRunId)
          ?.stopOperationId,
        "stop-operation-recovery",
      );
      assert.equal(
        recovered.find(({ run }) => run.workspaceScriptRunId === retryableRun.workspaceScriptRunId)
          ?.stopOperationId,
        "stop-operation-retryable-recovery",
      );
      assert.deepEqual(
        repeated.map(({ run }) => run.workspaceScriptRunId),
        [retryableRun.workspaceScriptRunId, stopping.workspaceScriptRunId],
      );
      assert.equal(failed.status, "failed");
      assert.equal(failed.errorCode, "workspace_script_server_restarted");
      assert.equal(retryable.status, "stopping");
      assert.isNull(retryable.finishedAtUnixMs);
      assert.isNull(retryable.errorCode);
      assert.equal(preserved.status, "exited");
    }),
  );
});
