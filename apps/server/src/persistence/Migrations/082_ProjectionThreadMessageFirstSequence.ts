import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN first_sequence INTEGER
  `;
  yield* sql`
    UPDATE projection_thread_messages AS message
    SET first_sequence = first_event.first_sequence
    FROM (
      SELECT
        json_extract(payload_json, '$.messageId') AS message_id,
        MIN(sequence) AS first_sequence
      FROM orchestration_events
      WHERE event_type = 'thread.message-sent'
        AND json_extract(payload_json, '$.messageId') IS NOT NULL
      GROUP BY json_extract(payload_json, '$.messageId')
    ) AS first_event
    WHERE message.message_id = first_event.message_id
  `;
  yield* sql`DROP INDEX IF EXISTS idx_projection_thread_messages_thread_created_id`;
  yield* sql`
    CREATE INDEX idx_projection_thread_messages_thread_created_sequence_id
    ON projection_thread_messages(thread_id, created_at, first_sequence, message_id)
  `;
});
