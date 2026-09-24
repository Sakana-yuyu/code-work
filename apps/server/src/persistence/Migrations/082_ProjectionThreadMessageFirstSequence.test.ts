import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("082_ProjectionThreadMessageFirstSequence", (it) => {
  it.effect("从事件记录恢复旧消息首次顺序，并建立查询索引", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 81 });

      for (const [sequence, messageId] of [
        [7, "z-user"],
        [8, "a-assistant"],
      ] as const) {
        yield* sql`
          INSERT INTO orchestration_events (
            sequence, event_id, aggregate_kind, stream_id, stream_version,
            event_type, occurred_at, actor_kind, payload_json, metadata_json
          ) VALUES (
            ${sequence}, ${`event-${sequence}`}, 'thread', 'thread-order', ${sequence},
            'thread.message-sent', '2026-09-24T00:00:00.000Z', 'system',
            json_object('messageId', ${messageId}), '{}'
          )
        `;
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
          ) VALUES (
            ${messageId}, 'thread-order', NULL, 'user', ${messageId}, 0,
            '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z'
          )
        `;
      }
      yield* sql`
        INSERT INTO orchestration_events (
          sequence, event_id, aggregate_kind, stream_id, stream_version,
          event_type, occurred_at, actor_kind, payload_json, metadata_json
        ) VALUES (
          9, 'event-9', 'thread', 'thread-order', 9,
          'thread.message-sent', '2026-09-24T00:00:00.000Z', 'system',
          '{"messageId":"a-assistant"}', '{}'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 82 });
      const rows = yield* sql<{ readonly message_id: string; readonly first_sequence: number }>`
        SELECT message_id, first_sequence
        FROM projection_thread_messages
        ORDER BY created_at, first_sequence, message_id
      `;
      assert.deepEqual(rows, [
        { message_id: "z-user", first_sequence: 7 },
        { message_id: "a-assistant", first_sequence: 8 },
      ]);
      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_thread_messages)
      `;
      assert.ok(
        indexes.some(
          (index) => index.name === "idx_projection_thread_messages_thread_created_sequence_id",
        ),
      );
    }),
  );
});
