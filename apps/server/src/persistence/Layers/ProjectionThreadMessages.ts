import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { ChatAttachment, IsoDateTime, ProviderInstanceId } from "@codework/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionThreadMessageInput,
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessageRepositoryShape,
  DeleteProjectionThreadMessagesInput,
  ListProjectionThreadMessagesInput,
  ProjectionThreadMessage,
} from "../Services/ProjectionThreadMessages.ts";

const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    providerInstanceId: Schema.NullOr(ProviderInstanceId),
    firstSequence: Schema.NullOr(Schema.Number),
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
  }),
);

function toProjectionThreadMessage(
  row: Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>,
): ProjectionThreadMessage {
  return {
    messageId: row.messageId,
    threadId: row.threadId,
    turnId: row.turnId,
    role: row.role,
    ...(row.firstSequence !== null ? { firstSequence: row.firstSequence } : {}),
    ...(row.providerInstanceId !== null ? { providerInstanceId: row.providerInstanceId } : {}),
    text: row.text,
    isStreaming: row.isStreaming === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.attachments !== null ? { attachments: row.attachments } : {}),
  };
}

const makeProjectionThreadMessageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadMessageRow = SqlSchema.void({
    Request: ProjectionThreadMessage.mapFields(
      Struct.assign({ applyMessageEvent: Schema.Boolean }),
    ),
    execute: (row) => {
      const nextAttachmentsJson =
        row.attachments !== undefined ? JSON.stringify(row.attachments) : null;
      return sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          first_sequence,
          provider_instance_id,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          ${row.messageId},
          ${row.threadId},
          ${row.turnId},
          ${row.role},
          ${row.firstSequence ?? null},
          ${row.providerInstanceId ?? null},
          ${row.text},
          ${nextAttachmentsJson},
          ${row.isStreaming ? 1 : 0},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (message_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          role = excluded.role,
          first_sequence = COALESCE(
            projection_thread_messages.first_sequence,
            excluded.first_sequence
          ),
          provider_instance_id = COALESCE(
            excluded.provider_instance_id,
            projection_thread_messages.provider_instance_id
          ),
          text = CASE
            WHEN ${row.applyMessageEvent ? 1 : 0} = 0 THEN excluded.text
            WHEN excluded.is_streaming = 1
              THEN projection_thread_messages.text || excluded.text
            WHEN excluded.text = '' THEN projection_thread_messages.text
            ELSE excluded.text
          END,
          attachments_json = COALESCE(
            excluded.attachments_json,
            projection_thread_messages.attachments_json
          ),
          is_streaming = excluded.is_streaming,
          created_at = CASE
            WHEN ${row.applyMessageEvent ? 1 : 0} = 1
              THEN projection_thread_messages.created_at
            ELSE excluded.created_at
          END,
          updated_at = excluded.updated_at
      `;
    },
  });

  const getProjectionThreadMessageRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadMessageInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ messageId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          first_sequence AS "firstSequence",
          provider_instance_id AS "providerInstanceId",
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE message_id = ${messageId}
        LIMIT 1
      `,
  });

  const listProjectionThreadMessageRows = SqlSchema.findAll({
    Request: ListProjectionThreadMessagesInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          first_sequence AS "firstSequence",
          provider_instance_id AS "providerInstanceId",
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, first_sequence ASC, message_id ASC
      `,
  });

  const getLatestUserMessageAtRow = SqlSchema.findOne({
    Request: ListProjectionThreadMessagesInput,
    Result: Schema.Struct({ latestUserMessageAt: Schema.NullOr(IsoDateTime) }),
    execute: ({ threadId }) => sql`
      SELECT MAX(created_at) AS "latestUserMessageAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId} AND role = 'user'
    `,
  });

  const deleteProjectionThreadMessageRows = SqlSchema.void({
    Request: DeleteProjectionThreadMessagesInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_messages
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadMessageRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadMessageRow({ ...row, applyMessageEvent: false }).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadMessageRepository.upsert:query")),
    );

  const applyMessage: ProjectionThreadMessageRepositoryShape["applyMessage"] = (row) =>
    upsertProjectionThreadMessageRow({ ...row, applyMessageEvent: true }).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.applyMessage:query"),
      ),
    );

  const getByMessageId: ProjectionThreadMessageRepositoryShape["getByMessageId"] = (input) =>
    getProjectionThreadMessageRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.getByMessageId:query"),
      ),
      Effect.map(Option.map(toProjectionThreadMessage)),
    );

  const listByThreadId: ProjectionThreadMessageRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.listByThreadId:query"),
      ),
      Effect.map((rows) => rows.map(toProjectionThreadMessage)),
    );

  const getLatestUserMessageAt: ProjectionThreadMessageRepositoryShape["getLatestUserMessageAt"] = (
    input,
  ) =>
    getLatestUserMessageAtRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.getLatestUserMessageAt:query"),
      ),
      Effect.map((row) => row.latestUserMessageAt),
    );

  const deleteByThreadId: ProjectionThreadMessageRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    applyMessage,
    getByMessageId,
    listByThreadId,
    getLatestUserMessageAt,
    deleteByThreadId,
  } satisfies ProjectionThreadMessageRepositoryShape;
});

export const ProjectionThreadMessageRepositoryLive = Layer.effect(
  ProjectionThreadMessageRepository,
  makeProjectionThreadMessageRepository,
);
