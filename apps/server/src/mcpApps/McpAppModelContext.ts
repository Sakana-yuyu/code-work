import type { ThreadId } from "@codework/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** Largest context one app may keep for the agent, in UTF-8 bytes. */
export const MCP_APP_MODEL_CONTEXT_MAX_BYTES = 16 * 1024;

export class McpAppModelContextError extends Schema.TaggedError<McpAppModelContextError>()(
  "McpAppModelContextError",
  { cause: Schema.optional(Schema.Defect()) },
) {}

export interface McpAppModelContextEntry {
  readonly itemId: string;
  readonly server: string;
  readonly tool: string;
  readonly text: string;
}

/**
 * What each MCP App told the agent through `ui/update-model-context`. The spec
 * replaces an app's context on every update, so there is one entry per app (its
 * tool call); the thread's next turn carries the entries to the provider.
 */
export class McpAppModelContext extends Context.Service<
  McpAppModelContext,
  {
    /** Replaces the app's context; empty text removes it. */
    readonly set: (input: {
      readonly threadId: ThreadId;
      readonly itemId: string;
      readonly server: string;
      readonly tool: string;
      readonly text: string;
    }) => Effect.Effect<void, McpAppModelContextError>;
    readonly forThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<McpAppModelContextEntry>, McpAppModelContextError>;
    readonly deleteForThread: (threadId: ThreadId) => Effect.Effect<void, McpAppModelContextError>;
  }
>()("codework/mcpApps/McpAppModelContext") {}

export const layer = Layer.effect(
  McpAppModelContext,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fail = (cause: unknown) => new McpAppModelContextError({ cause });

    const set: McpAppModelContext["Service"]["set"] = Effect.fn("McpAppModelContext.set")(
      function* (input) {
        if (input.text.trim() === "") {
          yield* sql`
            DELETE FROM mcp_app_model_context
            WHERE thread_id = ${input.threadId} AND item_id = ${input.itemId}
          `.pipe(Effect.mapError(fail));
          return;
        }
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          INSERT INTO mcp_app_model_context (thread_id, item_id, server, tool, text, updated_at)
          VALUES (${input.threadId}, ${input.itemId}, ${input.server}, ${input.tool}, ${input.text}, ${updatedAt})
          ON CONFLICT(thread_id, item_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
        `.pipe(Effect.mapError(fail));
      },
    );

    const forThread: McpAppModelContext["Service"]["forThread"] = Effect.fn(
      "McpAppModelContext.forThread",
    )(function* (threadId) {
      // A revert deletes the producing tool row from the activity projection;
      // context written for it is stale, so it is removed on read rather than
      // sent to the next turn.
      yield* sql`
        DELETE FROM mcp_app_model_context
        WHERE thread_id = ${threadId}
          AND item_id NOT IN (
            SELECT json_extract(payload_json, '$.toolCallId')
            FROM projection_thread_activities
            WHERE thread_id = ${threadId}
          )
      `.pipe(Effect.mapError(fail));
      return yield* sql<McpAppModelContextEntry>`
        SELECT item_id AS "itemId", server, tool, text
        FROM mcp_app_model_context
        WHERE thread_id = ${threadId}
        ORDER BY updated_at, item_id
      `.pipe(Effect.mapError(fail));
    });

    const deleteForThread: McpAppModelContext["Service"]["deleteForThread"] = Effect.fn(
      "McpAppModelContext.deleteForThread",
    )(function* (threadId) {
      yield* sql`
        DELETE FROM mcp_app_model_context WHERE thread_id = ${threadId}
      `.pipe(Effect.mapError(fail));
    });

    return McpAppModelContext.of({ set, forThread, deleteForThread });
  }),
);

/** No app context: for code paths and tests with no MCP Apps. */
export const layerEmpty = Layer.succeed(
  McpAppModelContext,
  McpAppModelContext.of({
    set: () => Effect.void,
    forThread: () => Effect.succeed([]),
    deleteForThread: () => Effect.void,
  }),
);
