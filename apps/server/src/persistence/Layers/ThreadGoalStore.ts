import {
  ThreadGoal,
  ThreadGoalEvent,
  ThreadGoalId,
  ThreadGoalStatus,
  type ThreadGoalSetInput,
} from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Stream from "effect/Stream";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  ThreadGoalStore,
  ThreadGoalStoreDomainError,
  type ThreadGoalStatusUpdateInput,
  type ThreadGoalStoreShape,
} from "../Services/ThreadGoalStore.ts";

const ThreadGoalRowSchema = Schema.Struct({
  threadId: Schema.String,
  goalId: Schema.String,
  objective: Schema.String,
  status: ThreadGoalStatus,
  tokenBudget: Schema.NullOr(Schema.Number),
  tokensUsed: Schema.Number,
  timeUsedSeconds: Schema.Number,
  createdAtUnixMs: Schema.Number,
  updatedAtUnixMs: Schema.Number,
  activeStartedAtUnixMs: Schema.NullOr(Schema.Number),
  revision: Schema.Number,
});
type ThreadGoalRow = typeof ThreadGoalRowSchema.Type;

const ThreadIdRequest = Schema.Struct({ threadId: Schema.String });
const ThreadGoalWriteRequest = Schema.Struct({
  ...ThreadGoalRowSchema.fields,
});
const decodeThreadGoalRow = Schema.decodeUnknownEffect(ThreadGoalRowSchema);

const isNonNegativeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const isSameSetInput = (row: ThreadGoalRow, input: ThreadGoalSetInput): boolean =>
  row.objective === input.objective && row.tokenBudget === (input.tokenBudget ?? null);

const makeDomainError = (
  code: ConstructorParameters<typeof ThreadGoalStoreDomainError>[0]["code"],
  threadId: string,
  detail: string,
  goalId?: string,
) =>
  new ThreadGoalStoreDomainError({
    code,
    threadId,
    detail,
    ...(goalId === undefined ? {} : { goalId }),
  });

const toGoal = (row: ThreadGoalRow, now: number): ThreadGoal => {
  const activeSeconds =
    row.status === "active" && row.activeStartedAtUnixMs !== null
      ? Math.floor(Math.max(0, now - row.activeStartedAtUnixMs) / 1_000)
      : 0;
  return {
    threadId: row.threadId as ThreadGoal["threadId"],
    goalId: ThreadGoalId.make(row.goalId),
    objective: row.objective,
    status: row.status,
    createdAt: row.createdAtUnixMs,
    updatedAt: row.updatedAtUnixMs,
    timeUsedSeconds: row.timeUsedSeconds + activeSeconds,
    tokenBudget: row.tokenBudget,
    tokensUsed: row.tokensUsed,
  };
};

export const ThreadGoalStoreLive = Layer.effect(
  ThreadGoalStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const changes = yield* PubSub.unbounded<{
      readonly threadId: string;
      readonly event: ThreadGoalEvent;
    }>();

    const getRow = SqlSchema.findOneOption({
      Request: ThreadIdRequest,
      Result: ThreadGoalRowSchema,
      execute: ({ threadId }) => sql`
        SELECT
          thread_id AS "threadId",
          goal_id AS "goalId",
          objective,
          status,
          token_budget AS "tokenBudget",
          tokens_used AS "tokensUsed",
          time_used_seconds AS "timeUsedSeconds",
          created_at_unix_ms AS "createdAtUnixMs",
          updated_at_unix_ms AS "updatedAtUnixMs",
          active_started_at_unix_ms AS "activeStartedAtUnixMs",
          revision
        FROM thread_goals
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
    });
    const upsertRow = SqlSchema.void({
      Request: ThreadGoalWriteRequest,
      execute: (row) => sql`
        INSERT INTO thread_goals (
          thread_id, goal_id, objective, status, token_budget, tokens_used,
          time_used_seconds, created_at_unix_ms, updated_at_unix_ms,
          active_started_at_unix_ms, revision
        ) VALUES (
          ${row.threadId}, ${row.goalId}, ${row.objective}, ${row.status},
          ${row.tokenBudget}, ${row.tokensUsed}, ${row.timeUsedSeconds},
          ${row.createdAtUnixMs}, ${row.updatedAtUnixMs},
          ${row.activeStartedAtUnixMs}, ${row.revision}
        )
        ON CONFLICT (thread_id) DO UPDATE SET
          goal_id = excluded.goal_id,
          objective = excluded.objective,
          status = excluded.status,
          token_budget = excluded.token_budget,
          tokens_used = excluded.tokens_used,
          time_used_seconds = excluded.time_used_seconds,
          updated_at_unix_ms = excluded.updated_at_unix_ms,
          active_started_at_unix_ms = excluded.active_started_at_unix_ms,
          revision = excluded.revision
      `,
    });
    const deleteRow = SqlSchema.void({
      Request: ThreadIdRequest,
      execute: ({ threadId }) => sql`DELETE FROM thread_goals WHERE thread_id = ${threadId}`,
    });

    type ThreadGoalSqlError = SqlError | Schema.SchemaError;
    const query = <A>(operation: string, effect: Effect.Effect<A, ThreadGoalSqlError>) =>
      effect.pipe(Effect.mapError(toPersistenceSqlError(operation)));
    const withTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      sql
        .withTransaction(effect)
        .pipe(
          Effect.catchTag("SqlError", (cause) =>
            Effect.fail(toPersistenceSqlError("ThreadGoalStore.withTransaction")(cause)),
          ),
        );
    const readRow = (threadId: string) =>
      query("ThreadGoalStore.get", getRow({ threadId })).pipe(
        Effect.mapError((error) => error),
        Effect.flatMap((row) =>
          Option.isNone(row)
            ? Effect.succeed(Option.none<ThreadGoalRow>())
            : Effect.succeed(Option.some(row.value)),
        ),
      );
    const decodeRow = (operation: string, row: ThreadGoalRow) =>
      decodeThreadGoalRow(row).pipe(Effect.mapError(toPersistenceDecodeError(operation)));
    const publish = (threadId: string, event: ThreadGoalEvent) =>
      PubSub.publish(changes, { threadId, event }).pipe(Effect.asVoid);
    const randomGoalId = crypto.randomUUIDv4.pipe(
      Effect.map(ThreadGoalId.make),
      Effect.mapError(toPersistenceSqlError("ThreadGoalStore.randomUUID")),
    );

    const set: ThreadGoalStoreShape["set"] = (input) =>
      withTransaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const existing = yield* readRow(input.threadId);
          if (Option.isSome(existing)) {
            const row = yield* decodeRow("ThreadGoalStore.set.read", existing.value);
            if (isSameSetInput(row, input)) {
              return toGoal(row, now);
            }
            const goalId = yield* randomGoalId;
            const next = {
              ...row,
              goalId,
              objective: input.objective,
              status: "active" as const,
              tokenBudget: input.tokenBudget ?? null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAtUnixMs: now,
              updatedAtUnixMs: now,
              activeStartedAtUnixMs: now,
              revision: row.revision + 1,
            };
            yield* query("ThreadGoalStore.set.replace", upsertRow(next));
            return toGoal(next, now);
          }

          const next = {
            threadId: input.threadId,
            goalId: yield* randomGoalId,
            objective: input.objective,
            status: "active" as const,
            tokenBudget: input.tokenBudget ?? null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAtUnixMs: now,
            updatedAtUnixMs: now,
            activeStartedAtUnixMs: now,
            revision: 1,
          };
          yield* query("ThreadGoalStore.set.insert", upsertRow(next));
          return toGoal(next, now);
        }),
      ).pipe(Effect.tap((goal) => publish(goal.threadId, { type: "updated", goal })));

    const updateStatus = (input: ThreadGoalStatusUpdateInput) =>
      withTransaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const existing = yield* readRow(input.threadId);
          if (Option.isNone(existing)) {
            return yield* makeDomainError(
              "goal-not-found",
              input.threadId,
              "线程没有可更新的 Goal。",
            );
          }
          const row = yield* decodeRow("ThreadGoalStore.setStatus.read", existing.value);
          if (row.status === "complete" && input.status !== "complete") {
            return yield* makeDomainError(
              "invalid-transition",
              input.threadId,
              "已完成的 Goal 不能回退到其他状态。",
              row.goalId,
            );
          }
          if (input.status === "active" && row.status !== "active" && row.status !== "paused") {
            return yield* makeDomainError(
              "invalid-transition",
              input.threadId,
              `Goal 不能从 ${row.status} 直接切换为 active。`,
              row.goalId,
            );
          }
          const current = toGoal(row, now);
          const timeUsedSeconds = input.timeUsedSeconds ?? current.timeUsedSeconds;
          const tokensUsed = input.tokensUsed ?? current.tokensUsed;
          if (!isNonNegativeInteger(timeUsedSeconds) || !isNonNegativeInteger(tokensUsed)) {
            return yield* makeDomainError(
              "invalid-input",
              input.threadId,
              "用量和时间必须是非负整数。",
              row.goalId,
            );
          }
          const activeStartedAtUnixMs =
            input.status === "active"
              ? row.status === "active" && row.activeStartedAtUnixMs !== null
                ? row.activeStartedAtUnixMs
                : now
              : null;
          const next = {
            ...row,
            status: input.status,
            timeUsedSeconds,
            tokensUsed,
            updatedAtUnixMs: now,
            activeStartedAtUnixMs,
            revision: row.revision + 1,
          };
          yield* query("ThreadGoalStore.setStatus.write", upsertRow(next));
          return toGoal(next, now);
        }),
      ).pipe(Effect.tap((goal) => publish(goal.threadId, { type: "updated", goal })));

    const pause: ThreadGoalStoreShape["pause"] = (threadId) =>
      updateStatus({ threadId, status: "paused" });
    const resume: ThreadGoalStoreShape["resume"] = (threadId) =>
      updateStatus({ threadId, status: "active" });

    const store: ThreadGoalStoreShape = {
      get: (threadId) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const row = yield* readRow(threadId);
          return Option.isNone(row)
            ? Option.none<ThreadGoal>()
            : Option.some(toGoal(yield* decodeRow("ThreadGoalStore.get.decode", row.value), now));
        }),
      set,
      pause,
      resume,
      setStatus: updateStatus,
      clear: (input) => {
        const threadId = typeof input === "string" ? input : input.threadId;
        return withTransaction(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const row = yield* readRow(threadId);
            if (Option.isNone(row)) {
              return yield* makeDomainError("goal-not-found", threadId, "线程没有可清除的 Goal。");
            }
            const decoded = yield* decodeRow("ThreadGoalStore.clear.decode", row.value);
            yield* query("ThreadGoalStore.clear.delete", deleteRow({ threadId }));
            return {
              type: "cleared" as const,
              threadId: decoded.threadId as ThreadGoal["threadId"],
              goalId: ThreadGoalId.make(decoded.goalId),
              clearedAt: now,
            };
          }),
        ).pipe(Effect.tap((event) => publish(event.threadId, event)));
      },
      subscribe: (threadId) =>
        Effect.succeed(
          Stream.fromPubSub(changes).pipe(
            Stream.filter((change) => change.threadId === threadId),
            Stream.map((change) => change.event),
          ),
        ),
    };

    return store;
  }),
);
