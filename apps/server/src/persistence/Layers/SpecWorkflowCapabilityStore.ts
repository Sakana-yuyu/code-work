import {
  NonNegativeInt,
  SpecWorkflowCapability,
  SpecWorkflowEvent,
  SpecWorkflowIntentName,
  type SpecWorkflowSetInput,
} from "@codework/contracts";
import * as Clock from "effect/Clock";
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
  SpecWorkflowCapabilityStore,
  SpecWorkflowCapabilityStoreDomainError,
  type SpecWorkflowCapabilityStoreShape,
} from "../Services/SpecWorkflowCapabilityStore.ts";

const SpecWorkflowRowSchema = Schema.Struct({
  threadId: Schema.String,
  enabled: Schema.Number,
  selectedIntent: SpecWorkflowIntentName,
  revision: Schema.Number,
  updatedAtUnixMs: Schema.Number,
});
type SpecWorkflowRow = typeof SpecWorkflowRowSchema.Type;

const ThreadIdRequest = Schema.Struct({ threadId: Schema.String });
const SpecWorkflowWriteRequest = Schema.Struct({ ...SpecWorkflowRowSchema.fields });
const decodeRow = Schema.decodeUnknownEffect(SpecWorkflowRowSchema);

const isNonNegativeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const makeDomainError = (
  code: ConstructorParameters<typeof SpecWorkflowCapabilityStoreDomainError>[0]["code"],
  threadId: string,
  detail: string,
) => new SpecWorkflowCapabilityStoreDomainError({ code, threadId, detail });

const toCapability = (row: SpecWorkflowRow): SpecWorkflowCapability => ({
  threadId: row.threadId as SpecWorkflowCapability["threadId"],
  enabled: row.enabled === 1,
  selectedIntent: row.selectedIntent,
  revision: row.revision,
  updatedAt: row.updatedAtUnixMs,
});

const defaultCapability = (threadId: string): SpecWorkflowCapability => ({
  threadId: threadId as SpecWorkflowCapability["threadId"],
  enabled: false,
  revision: 0,
  updatedAt: 0,
});

export const SpecWorkflowCapabilityStoreLive = Layer.effect(
  SpecWorkflowCapabilityStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const changes = yield* PubSub.unbounded<{
      readonly threadId: string;
      readonly event: SpecWorkflowEvent;
    }>();

    const getRow = SqlSchema.findOneOption({
      Request: ThreadIdRequest,
      Result: SpecWorkflowRowSchema,
      execute: ({ threadId }) => sql`
        SELECT
          thread_id AS "threadId",
          enabled,
          selected_intent AS "selectedIntent",
          revision,
          updated_at_unix_ms AS "updatedAtUnixMs"
        FROM thread_spec_workflow_capabilities
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
    });
    const upsertRow = SqlSchema.void({
      Request: SpecWorkflowWriteRequest,
      execute: (row) => sql`
        INSERT INTO thread_spec_workflow_capabilities (
          thread_id, enabled, selected_intent, revision, updated_at_unix_ms
        ) VALUES (
          ${row.threadId}, ${row.enabled}, ${row.selectedIntent}, ${row.revision}, ${row.updatedAtUnixMs}
        )
        ON CONFLICT (thread_id) DO UPDATE SET
          enabled = excluded.enabled,
          selected_intent = excluded.selected_intent,
          revision = excluded.revision,
          updated_at_unix_ms = excluded.updated_at_unix_ms
      `,
    });

    type StoreSqlError = SqlError | Schema.SchemaError;
    const query = <A>(operation: string, effect: Effect.Effect<A, StoreSqlError>) =>
      effect.pipe(Effect.mapError(toPersistenceSqlError(operation)));
    const withTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      sql
        .withTransaction(effect)
        .pipe(
          Effect.catchTag("SqlError", (cause) =>
            Effect.fail(
              toPersistenceSqlError("SpecWorkflowCapabilityStore.withTransaction")(cause),
            ),
          ),
        );
    const readRow = (threadId: string) =>
      query("SpecWorkflowCapabilityStore.get", getRow({ threadId }));
    const decode = (operation: string, row: SpecWorkflowRow) =>
      decodeRow(row).pipe(Effect.mapError(toPersistenceDecodeError(operation)));
    const publish = (threadId: string, event: SpecWorkflowEvent) =>
      PubSub.publish(changes, { threadId, event }).pipe(Effect.asVoid);

    const set: SpecWorkflowCapabilityStoreShape["set"] = (input: SpecWorkflowSetInput) =>
      withTransaction(
        Effect.gen(function* () {
          const expectedRevision = input.expectedRevision;
          if (
            (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) ||
            typeof input.enabled !== "boolean" ||
            (input.selectedIntent !== undefined &&
              !Schema.is(SpecWorkflowIntentName)(input.selectedIntent))
          ) {
            return yield* makeDomainError(
              "invalid-input",
              input.threadId,
              "Spec Workflow 开关输入无效。",
            );
          }

          const existing = yield* readRow(input.threadId);
          const current = Option.isSome(existing)
            ? yield* decode("SpecWorkflowCapabilityStore.set.read", existing.value)
            : undefined;
          const currentRevision = current?.revision ?? 0;
          if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
            return yield* makeDomainError(
              "stale-version",
              input.threadId,
              "Spec Workflow 能力已被其他操作更新，请刷新后重试。",
            );
          }
          const selectedIntent = input.selectedIntent ?? current?.selectedIntent ?? "workflow";
          if (
            current !== undefined &&
            current.enabled === (input.enabled ? 1 : 0) &&
            current.selectedIntent === selectedIntent
          ) {
            return toCapability(current);
          }

          const now = yield* Clock.currentTimeMillis;
          const next: SpecWorkflowRow = {
            threadId: input.threadId,
            enabled: input.enabled ? 1 : 0,
            selectedIntent,
            revision: currentRevision + 1,
            updatedAtUnixMs: now,
          };
          yield* query("SpecWorkflowCapabilityStore.set.write", upsertRow(next));
          return toCapability(next);
        }),
      ).pipe(
        Effect.tap((capability) => publish(capability.threadId, { type: "updated", capability })),
      );

    const store: SpecWorkflowCapabilityStoreShape = {
      get: (threadId) =>
        readRow(threadId).pipe(
          Effect.flatMap((row) =>
            Option.isNone(row)
              ? Effect.succeed(defaultCapability(threadId))
              : decode("SpecWorkflowCapabilityStore.get.decode", row.value).pipe(
                  Effect.map(toCapability),
                ),
          ),
        ),
      set,
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
