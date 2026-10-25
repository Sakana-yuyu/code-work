import {
  McpAppRequestError,
  type McpAppCallToolInput,
  type McpAppCallToolResult,
  type McpAppItemDetailInput,
  type McpAppItemDetailResult,
  type McpAppReadResourceInput,
  type McpAppReadResourceResult,
  type McpAppToolInfo,
  type McpAppToolInfoInput,
  type McpAppUpdateModelContextInput,
  type ThreadId,
} from "@codework/contracts";
import {
  MCP_APP_OUTPUT_KEY,
  mcpAppToolCallableByApp,
  readMcpAppReference,
  type McpAppReference,
} from "@codework/shared/mcpApp";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type {
  ProviderAdapterMcpApps,
  ProviderAdapterMcpTool,
} from "../provider/Services/ProviderAdapter.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import * as McpAppModelContext from "./McpAppModelContext.ts";

/**
 * Requests an MCP App makes of the MCP server that produced it, relayed to
 * the provider over the thread's live session (ext-apps spec 2026-01-26). The
 * app is resolved from the stored tool call, so it reaches only that server;
 * a stopped session is reported, never started — an app view must not spend
 * a provider turn.
 */
export class McpAppRequests extends Context.Service<
  McpAppRequests,
  {
    readonly callTool: (
      input: McpAppCallToolInput,
    ) => Effect.Effect<McpAppCallToolResult, McpAppRequestError>;
    readonly toolInfo: (
      input: McpAppToolInfoInput,
    ) => Effect.Effect<McpAppToolInfo, McpAppRequestError>;
    readonly readResource: (
      input: McpAppReadResourceInput,
    ) => Effect.Effect<McpAppReadResourceResult, McpAppRequestError>;
    readonly updateModelContext: (
      input: McpAppUpdateModelContextInput,
    ) => Effect.Effect<void, McpAppRequestError>;
    readonly itemDetail: (
      input: McpAppItemDetailInput,
    ) => Effect.Effect<McpAppItemDetailResult, McpAppRequestError>;
  }
>()("codework/mcpApps/McpAppRequests") {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
/** Parses a stored payload; a malformed row reads as absent. */
const parsePayloadText = (text: string): unknown => {
  try {
    return decodeJson(text);
  } catch {
    return undefined;
  }
};
const utf8 = new TextEncoder();
const APP_REFERENCE_JSON_PATH = `$.data.item.${MCP_APP_OUTPUT_KEY}`;

const readOnlyHint = (tool: ProviderAdapterMcpTool) =>
  Predicate.isObject(tool.annotations) && tool.annotations.readOnlyHint === true;

const toolTitle = (tool: ProviderAdapterMcpTool) =>
  Predicate.isObject(tool.annotations) && typeof tool.annotations.title === "string"
    ? tool.annotations.title
    : undefined;

/**
 * Builds the bridge service from its four environment services. The WS
 * layer constructs it directly instead of routing through a boot-graph
 * layer: a layer here would eagerly materialize the adapter facade in
 * whichever branch reaches it first and fail the whole server boot
 * without the hydrated instance registry in scope (the facade arrives
 * through ProviderService instead, which resolves in the connection
 * environment).
 */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const directory = yield* ProviderSessionDirectory;
  // The adapter facade arrives through ProviderService: a sibling
  // layer's internal provides are invisible to this layer's
  // environment, and requiring the facade's own layer here
  // materializes it in a branch where the hydrated instance registry
  // does not exist.
  const registry = (yield* ProviderService.ProviderService).adapterRegistry;
  const modelContext = yield* McpAppModelContext.McpAppModelContext;

  const fail = (threadId: ThreadId, reason: McpAppRequestError["reason"], cause?: unknown) =>
    new McpAppRequestError({ threadId, reason, ...(cause === undefined ? {} : { cause }) });

  /**
   * The app a tool call produced, read from the stored activity payload —
   * not the wire projection — so the reference is intact.
   */
  const resolveApp = Effect.fn("McpAppRequests.resolveApp")(function* (input: {
    readonly threadId: ThreadId;
    readonly itemId: string;
  }) {
    const rows = yield* sql<{ payload: string }>`
        SELECT payload_json AS "payload"
        FROM projection_thread_activities
        WHERE thread_id = ${input.threadId}
          AND json_extract(payload_json, '$.toolCallId') = ${input.itemId}
          AND json_extract(payload_json, ${APP_REFERENCE_JSON_PATH}) IS NOT NULL
        ORDER BY created_at DESC, activity_id DESC
        LIMIT 1
      `.pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));

    let app: McpAppReference | undefined;
    const payloadText = rows[0]?.payload;
    if (payloadText !== undefined) {
      const parsed = parsePayloadText(payloadText);
      const item = Predicate.isObject(parsed)
        ? Predicate.isObject(parsed.data)
          ? parsed.data.item
          : undefined
        : undefined;
      if (Predicate.isObject(item) && item.type === "mcpToolCall") {
        const reference = readMcpAppReference(item[MCP_APP_OUTPUT_KEY]);
        // The stored item must agree with the reference: a bridge call
        // routes by ref server/tool, so a tampered pair must not reach a
        // server the tool call never touched.
        if (
          reference !== undefined &&
          item.server === reference.server &&
          item.tool === reference.tool
        ) {
          app = reference;
        }
      }
    }
    if (app === undefined) {
      return yield* fail(input.threadId, "not-an-app");
    }
    return { app };
  });

  /** The app plus the live session's MCP Apps operations. */
  const resolve = Effect.fn("McpAppRequests.resolve")(function* (input: {
    readonly threadId: ThreadId;
    readonly itemId: string;
  }) {
    const { app } = yield* resolveApp(input);
    const binding = Option.getOrUndefined(
      yield* directory
        .getBinding(input.threadId)
        .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause))),
    );
    const instanceId = binding?.providerInstanceId;
    if (instanceId === undefined) {
      return yield* fail(input.threadId, "session-stopped");
    }
    const adapter = yield* registry
      .getByInstance(instanceId)
      .pipe(Effect.mapError((cause) => fail(input.threadId, "session-stopped", cause)));
    if (adapter.mcpApps === undefined) {
      return yield* fail(input.threadId, "provider-unsupported");
    }
    const mcpApps: ProviderAdapterMcpApps | undefined = yield* adapter
      .mcpApps(input.threadId)
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
    if (mcpApps === undefined) return yield* fail(input.threadId, "session-stopped");
    return { app, mcpApps };
  });

  const findTool = Effect.fn("McpAppRequests.findTool")(function* (
    threadId: ThreadId,
    mcpApps: ProviderAdapterMcpApps,
    server: string,
    name: string,
  ) {
    const tools = yield* mcpApps
      .listTools({ server })
      .pipe(Effect.mapError((cause) => fail(threadId, "request-failed", cause)));
    return tools.find((tool) => tool.name === name);
  });

  const toolInfo = Effect.fn("McpAppRequests.toolInfo")(function* (input: McpAppToolInfoInput) {
    const resolved = yield* resolve(input);
    const tool = yield* findTool(input.threadId, resolved.mcpApps, resolved.app.server, input.name);
    const title = tool === undefined ? undefined : toolTitle(tool);
    return {
      callable: tool !== undefined && mcpAppToolCallableByApp(tool._meta),
      readOnly: tool !== undefined && readOnlyHint(tool),
      ...(title === undefined ? {} : { title }),
      ...(tool === undefined ? {} : { tool }),
    } satisfies McpAppToolInfo;
  });

  const callTool = Effect.fn("McpAppRequests.callTool")(function* (input: McpAppCallToolInput) {
    const resolved = yield* resolve(input);
    // The spec forbids apps calling tools hidden from them; checked here
    // too, since a client's own check is only a courtesy to its user.
    const tool = yield* findTool(input.threadId, resolved.mcpApps, resolved.app.server, input.name);
    if (tool === undefined || !mcpAppToolCallableByApp(tool._meta)) {
      return yield* fail(input.threadId, "tool-not-callable");
    }
    return yield* resolved.mcpApps
      .callTool({
        server: resolved.app.server,
        tool: input.name,
        ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
      })
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
  });

  const readResource = Effect.fn("McpAppRequests.readResource")(function* (
    input: McpAppReadResourceInput,
  ) {
    const resolved = yield* resolve(input);
    return yield* resolved.mcpApps
      .readResource({ server: resolved.app.server, uri: input.uri })
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
  });

  // Context is state for the agent's next turn, so it needs the app but not
  // a live session. Text blocks are kept as written and structured content
  // as JSON; other content kinds are not declared by the host.
  const updateModelContext = Effect.fn("McpAppRequests.updateModelContext")(function* (
    input: McpAppUpdateModelContextInput,
  ) {
    const { app } = yield* resolveApp(input);
    // Context belongs to the conversation on screen. Code Work has no
    // thread forking yet, so the only conversation that can show this app
    // is the thread that produced it.
    if (input.conversationThreadId !== input.threadId) {
      return yield* fail(input.threadId, "not-an-app");
    }
    const texts: Array<string> = [];
    for (const block of input.content ?? []) {
      if (!Predicate.isObject(block) || block.type !== "text" || typeof block.text !== "string") {
        return yield* fail(input.threadId, "unsupported-content");
      }
      texts.push(block.text);
    }
    if (input.structuredContent !== undefined) {
      texts.push(encodeJson(input.structuredContent));
    }
    // Kept as sent; blank text clears the app's context in the store.
    const text = texts.join("\n");
    if (utf8.encode(text).byteLength > McpAppModelContext.MCP_APP_MODEL_CONTEXT_MAX_BYTES) {
      return yield* fail(
        input.threadId,
        "request-failed",
        new Error("Model context is too large."),
      );
    }
    yield* modelContext
      .set({
        threadId: input.conversationThreadId,
        itemId: input.itemId,
        server: app.server,
        tool: app.tool,
        text,
      })
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
  });

  /**
   * The stored `data.item` for the tool call, merged across its activity
   * rows the way the client work-log does. Persistence keeps the full
   * payload on completion, so unlike the wire projection this includes the
   * unabridged `result` the app needs as `ui/notifications/tool-result`.
   */
  const itemDetail = Effect.fn("McpAppRequests.itemDetail")(function* (
    input: McpAppItemDetailInput,
  ) {
    const rows = yield* sql<{ payload: string }>`
        SELECT payload_json AS "payload"
        FROM projection_thread_activities
        WHERE thread_id = ${input.threadId}
          AND json_extract(payload_json, '$.toolCallId') = ${input.itemId}
        ORDER BY created_at ASC, activity_id ASC
      `.pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));

    let item: Record<PropertyKey, unknown> | undefined;
    for (const row of rows) {
      const parsed = parsePayloadText(row.payload);
      const stored = Predicate.isObject(parsed)
        ? Predicate.isObject(parsed.data)
          ? parsed.data.item
          : undefined
        : undefined;
      if (Predicate.isObject(stored)) {
        item = Object.assign(item ?? {}, stored);
      }
    }
    if (item === undefined) return {};
    return { item };
  });

  return McpAppRequests.of({ callTool, toolInfo, readResource, updateModelContext, itemDetail });
});

export const layer = Layer.effect(McpAppRequests, make);
