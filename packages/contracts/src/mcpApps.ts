import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Requests an MCP App makes of the MCP server that produced it, relayed to the
 * provider over the thread's live session (spec 2026-01-26). `itemId` is the
 * tool-call id (`toolCallId`) of the activity whose data carries the app
 * reference (`codeworkMcpApp`).
 */

export const McpAppCallToolInput = Schema.Struct({
  threadId: ThreadId,
  itemId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type McpAppCallToolInput = typeof McpAppCallToolInput.Type;

export const McpAppCallToolResult = Schema.Struct({
  content: Schema.Array(Schema.Unknown),
  structuredContent: Schema.optionalKey(Schema.Unknown),
  isError: Schema.optionalKey(Schema.Boolean),
  _meta: Schema.optionalKey(Schema.Unknown),
});
export type McpAppCallToolResult = typeof McpAppCallToolResult.Type;

export const McpAppToolInfoInput = Schema.Struct({
  threadId: ThreadId,
  itemId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type McpAppToolInfoInput = typeof McpAppToolInfoInput.Type;

/**
 * What a client needs to decide whether to ask before a call: whether the
 * tool exists for apps and whether its server declares it read-only. `tool`
 * is the server's MCP `Tool` definition, passed to the app as `toolInfo`.
 */
export const McpAppToolInfo = Schema.Struct({
  callable: Schema.Boolean,
  readOnly: Schema.Boolean,
  title: Schema.optionalKey(Schema.String),
  tool: Schema.optionalKey(Schema.Unknown),
});
export type McpAppToolInfo = typeof McpAppToolInfo.Type;

export const McpAppReadResourceInput = Schema.Struct({
  threadId: ThreadId,
  itemId: TrimmedNonEmptyString,
  uri: TrimmedNonEmptyString,
});
export type McpAppReadResourceInput = typeof McpAppReadResourceInput.Type;

export const McpAppReadResourceResult = Schema.Struct({
  contents: Schema.Array(Schema.Unknown),
});
export type McpAppReadResourceResult = typeof McpAppReadResourceResult.Type;

/**
 * `conversationThreadId` is the thread on screen, which may differ from the
 * producing thread when the entry is shown in a fork or an inbox preview.
 */
export const McpAppUpdateModelContextInput = Schema.Struct({
  threadId: ThreadId,
  itemId: TrimmedNonEmptyString,
  conversationThreadId: ThreadId,
  content: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  structuredContent: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type McpAppUpdateModelContextInput = typeof McpAppUpdateModelContextInput.Type;

/**
 * The stored tool call an app was produced by: the full `data.item` merged
 * across its activity rows, with the wire projection's size limits undone, so
 * the app sees the real `arguments` and `result`.
 */
export const McpAppItemDetailInput = Schema.Struct({
  threadId: ThreadId,
  itemId: TrimmedNonEmptyString,
});
export type McpAppItemDetailInput = typeof McpAppItemDetailInput.Type;

export const McpAppItemDetailResult = Schema.Struct({
  item: Schema.optionalKey(Schema.Unknown),
});
export type McpAppItemDetailResult = typeof McpAppItemDetailResult.Type;

export const McpAppRequestErrorReason = Schema.Literals([
  /** The named item is not an MCP App. */
  "not-an-app",
  /** The thread's provider does not expose an MCP Apps runtime. */
  "provider-unsupported",
  /** The producing session is gone; views stay rendered but cannot interact. */
  "session-stopped",
  /** The tool is not declared callable by apps on its server. */
  "tool-not-callable",
  /** The app sent content the host did not declare. */
  "unsupported-content",
  /** The provider refused or failed the request. */
  "request-failed",
]);
export type McpAppRequestErrorReason = typeof McpAppRequestErrorReason.Type;

export class McpAppRequestError extends Schema.TaggedError<McpAppRequestError>()(
  "McpAppRequestError",
  {
    threadId: ThreadId,
    reason: McpAppRequestErrorReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
