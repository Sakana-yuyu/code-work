import { SpecWorkflowState, SpecWorkflowStateEvent } from "@codework/contracts";
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
  SpecWorkflowStateStore,
  SpecWorkflowStateStoreDomainError,
  type SpecWorkflowStateStoreShape,
  type SpecWorkflowStateStoreAppendInput,
} from "../Services/SpecWorkflowStateStore.ts";

const SpecWorkflowStateJson = Schema.fromJsonString(SpecWorkflowState);
const SpecWorkflowStateEventJson = Schema.fromJsonString(SpecWorkflowStateEvent);
const encodeState = Schema.encodeSync(SpecWorkflowStateJson);
const encodeEvent = Schema.encodeSync(SpecWorkflowStateEventJson);

const SpecWorkflowStateEventRowSchema = Schema.Struct({
  threadId: Schema.String,
  workflowId: Schema.String,
  revision: Schema.Number,
  eventJson: Schema.String,
  stateJson: Schema.String,
  createdAtUnixMs: Schema.Number,
});
type SpecWorkflowStateEventRow = typeof SpecWorkflowStateEventRowSchema.Type;

const ThreadIdRequest = Schema.Struct({ threadId: Schema.String });
const EmptyRequest = Schema.Struct({});
const SpecWorkflowStateEventWriteRequest = Schema.Struct({
  ...SpecWorkflowStateEventRowSchema.fields,
});
const decodeState = Schema.decodeUnknownEffect(SpecWorkflowStateJson);
const decodeEvent = Schema.decodeUnknownEffect(SpecWorkflowStateEventJson);

const makeDomainError = (
  code: ConstructorParameters<typeof SpecWorkflowStateStoreDomainError>[0]["code"],
  threadId: string,
  detail: string,
  workflowId?: string,
) =>
  new SpecWorkflowStateStoreDomainError({
    code,
    threadId,
    detail,
    ...(workflowId === undefined ? {} : { workflowId }),
  });

export const SpecWorkflowStateStoreLive = Layer.effect(
  SpecWorkflowStateStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const changes = yield* PubSub.unbounded<{
      readonly threadId: string;
      readonly event: SpecWorkflowStateEvent;
    }>();

    const findLatestRow = SqlSchema.findOneOption({
      Request: ThreadIdRequest,
      Result: SpecWorkflowStateEventRowSchema,
      execute: ({ threadId }) => sql`
        SELECT
          thread_id AS "threadId",
          workflow_id AS "workflowId",
          revision,
          event_json AS "eventJson",
          state_json AS "stateJson",
          created_at_unix_ms AS "createdAtUnixMs"
        FROM thread_spec_workflow_events
        WHERE thread_id = ${threadId}
        ORDER BY revision DESC
        LIMIT 1
      `,
    });
    const findRows = SqlSchema.findAll({
      Request: ThreadIdRequest,
      Result: SpecWorkflowStateEventRowSchema,
      execute: ({ threadId }) => sql`
        SELECT
          thread_id AS "threadId",
          workflow_id AS "workflowId",
          revision,
          event_json AS "eventJson",
          state_json AS "stateJson",
          created_at_unix_ms AS "createdAtUnixMs"
        FROM thread_spec_workflow_events
        WHERE thread_id = ${threadId}
        ORDER BY revision ASC
      `,
    });
    const findLatestRows = SqlSchema.findAll({
      Request: EmptyRequest,
      Result: SpecWorkflowStateEventRowSchema,
      execute: () => sql`
        SELECT
          event.thread_id AS "threadId",
          event.workflow_id AS "workflowId",
          event.revision,
          event.event_json AS "eventJson",
          event.state_json AS "stateJson",
          event.created_at_unix_ms AS "createdAtUnixMs"
        FROM thread_spec_workflow_events AS event
        WHERE event.revision = (
          SELECT MAX(latest.revision)
          FROM thread_spec_workflow_events AS latest
          WHERE latest.thread_id = event.thread_id
        )
        ORDER BY event.created_at_unix_ms DESC, event.thread_id ASC
      `,
    });
    const insertRow = SqlSchema.void({
      Request: SpecWorkflowStateEventWriteRequest,
      execute: (row) => sql`
        INSERT INTO thread_spec_workflow_events (
          thread_id, workflow_id, revision, event_json, state_json, created_at_unix_ms
        ) VALUES (
          ${row.threadId}, ${row.workflowId}, ${row.revision},
          ${row.eventJson}, ${row.stateJson}, ${row.createdAtUnixMs}
        )
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
            Effect.fail(toPersistenceSqlError("SpecWorkflowStateStore.withTransaction")(cause)),
          ),
        );
    const readLatest = (threadId: string) =>
      query("SpecWorkflowStateStore.readLatest", findLatestRow({ threadId }));
    const readRows = (threadId: string) =>
      query("SpecWorkflowStateStore.listEvents", findRows({ threadId }));
    const decodeStoredState = (operation: string, value: string) =>
      decodeState(value).pipe(Effect.mapError(toPersistenceDecodeError(operation)));
    const decodeStoredEvent = (operation: string, value: string) =>
      decodeEvent(value).pipe(Effect.mapError(toPersistenceDecodeError(operation)));
    const publish = (threadId: string, event: SpecWorkflowStateEvent) =>
      PubSub.publish(changes, { threadId, event }).pipe(Effect.asVoid);

    const get: SpecWorkflowStateStoreShape["get"] = (threadId) =>
      readLatest(threadId).pipe(
        Effect.flatMap((row) =>
          Option.isNone(row)
            ? Effect.succeed(Option.none<SpecWorkflowState>())
            : decodeStoredState("SpecWorkflowStateStore.get.decode", row.value.stateJson).pipe(
                Effect.map(Option.some),
              ),
        ),
      );

    const listStates: SpecWorkflowStateStoreShape["listStates"] = () =>
      query("SpecWorkflowStateStore.listStates", findLatestRows({})).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            decodeStoredState("SpecWorkflowStateStore.listStates.decode", row.stateJson),
          ),
        ),
      );

    const listEvents: SpecWorkflowStateStoreShape["listEvents"] = (threadId) =>
      readRows(threadId).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            decodeStoredEvent("SpecWorkflowStateStore.listEvents.decode", row.eventJson),
          ),
        ),
      );

    const append: SpecWorkflowStateStoreShape["append"] = (
      input: SpecWorkflowStateStoreAppendInput,
    ) => {
      const nextState = input.event.state;
      const eventJson = encodeEvent(input.event);
      const stateJson = encodeState(nextState);
      return withTransaction(
        Effect.gen(function* () {
          if (nextState.threadId !== input.threadId) {
            return yield* makeDomainError(
              "invalid-input",
              input.threadId,
              "状态事件的线程身份与写入目标不一致。",
              nextState.workflowId,
            );
          }
          const existing = yield* readLatest(input.threadId);
          if (Option.isSome(existing)) {
            const row = existing.value;
            if (row.workflowId !== nextState.workflowId) {
              return yield* makeDomainError(
                "invalid-input",
                input.threadId,
                "同一线程只能绑定一个 active Spec Workflow。",
                nextState.workflowId,
              );
            }
            if (
              row.revision === nextState.revision &&
              row.eventJson === eventJson &&
              row.stateJson === stateJson
            ) {
              return { state: nextState, publish: false };
            }
            if (nextState.revision <= row.revision || input.expectedRevision !== row.revision) {
              return yield* makeDomainError(
                "revision-conflict",
                input.threadId,
                "Spec Workflow 状态已被其他操作更新，请刷新后重试。",
                nextState.workflowId,
              );
            }
          } else if (input.event.type !== "started") {
            return yield* makeDomainError(
              "workflow-not-found",
              input.threadId,
              "状态事件缺少 started 前置事件。",
              nextState.workflowId,
            );
          }

          const currentRevision = Option.isNone(existing) ? 0 : existing.value.revision;
          if (
            input.expectedRevision !== currentRevision ||
            nextState.revision !== currentRevision + 1
          ) {
            return yield* makeDomainError(
              "revision-conflict",
              input.threadId,
              "Spec Workflow revision 不连续，请刷新后重试。",
              nextState.workflowId,
            );
          }
          yield* query(
            "SpecWorkflowStateStore.append.insert",
            insertRow({
              threadId: input.threadId,
              workflowId: nextState.workflowId,
              revision: nextState.revision,
              eventJson,
              stateJson,
              createdAtUnixMs: nextState.updatedAt,
            }),
          );
          return { state: nextState, publish: true };
        }),
      ).pipe(
        Effect.tap(({ state, publish: shouldPublish }) =>
          shouldPublish ? publish(input.threadId, input.event) : Effect.void,
        ),
        Effect.map(({ state }) => state),
      );
    };

    return {
      listStates,
      get,
      append,
      listEvents,
      subscribe: (threadId) =>
        Effect.succeed(
          Stream.fromPubSub(changes).pipe(
            Stream.filter((change) => change.threadId === threadId),
            Stream.map((change) => change.event),
          ),
        ),
    } satisfies SpecWorkflowStateStoreShape;
  }),
);
