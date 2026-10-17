import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ThreadId,
  type McpAppRequestError,
} from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type {
  ProviderAdapterMcpApps,
  ProviderAdapterShape,
} from "../provider/Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { makeAdapterRegistryMock } from "../provider/testUtils/providerAdapterRegistryMock.ts";
import * as McpAppModelContext from "./McpAppModelContext.ts";
import * as McpAppRequests from "./McpAppRequests.ts";

const THREAD_ID = ThreadId.make("thread-app-1");
const PROVIDER = ProviderDriverKind.make("codex");
const INSTANCE_ID = defaultInstanceIdForDriver(PROVIDER);

/** Every call an app made reach the provider's MCP client surface. */
const mcpCalls: Array<{ readonly kind: string; readonly input: unknown }> = [];

const mcpApps: ProviderAdapterMcpApps = {
  listTools: (input) =>
    Effect.sync(() => {
      mcpCalls.push({ kind: "listTools", input });
      return [
        { name: "visible", inputSchema: {}, _meta: { ui: { visibility: ["app"] } } },
        { name: "hidden", inputSchema: {}, _meta: { ui: { visibility: ["model"] } } },
      ];
    }),
  callTool: (input) =>
    Effect.sync(() => {
      mcpCalls.push({ kind: "callTool", input });
      return { content: [{ type: "text", text: "done" }] };
    }),
  readResource: (input) =>
    Effect.sync(() => {
      mcpCalls.push({ kind: "readResource", input });
      return { contents: [] };
    }),
};

const adapter: ProviderAdapterShape<never> = {
  provider: PROVIDER,
  capabilities: { sessionModelSwitch: "in-session" },
  mcpApps: () => Effect.succeed(mcpApps),
  startSession: () => Effect.die("not stubbed"),
  sendTurn: () => Effect.die("not stubbed"),
  interruptTurn: () => Effect.die("not stubbed"),
  respondToRequest: () => Effect.die("not stubbed"),
  respondToUserInput: () => Effect.die("not stubbed"),
  stopSession: () => Effect.die("not stubbed"),
  listSessions: () => Effect.succeed([]),
  hasSession: () => Effect.succeed(true),
  readThread: () => Effect.die("not stubbed"),
  rollbackThread: () => Effect.die("not stubbed"),
  stopAll: () => Effect.void,
  streamEvents: Stream.empty,
};

let bindingLive = true;
const directoryLayer = Layer.mock(ProviderSessionDirectory)({
  getBinding: (threadId: ThreadId) =>
    Effect.succeed(
      bindingLive
        ? Option.some({ threadId, provider: PROVIDER, providerInstanceId: INSTANCE_ID })
        : Option.none(),
    ),
});

const requestsLayer = it.layer(
  McpAppRequests.layer.pipe(
    Layer.provide(McpAppModelContext.layerEmpty),
    Layer.provide(directoryLayer),
    Layer.provide(
      Layer.succeed(ProviderAdapterRegistry, makeAdapterRegistryMock({ [PROVIDER]: adapter })),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

/** One stored mcp_tool_call whose data names the app its result produced. */
const seedAppActivity = Effect.fn("seedAppActivity")(function* (options?: {
  readonly itemServer?: string;
  readonly referenceServer?: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM projection_thread_activities WHERE thread_id = ${THREAD_ID}`;
  const server = options?.itemServer ?? "weather";
  const referenceServer = options?.referenceServer ?? "weather";
  yield* sql`
    INSERT INTO projection_thread_activities (
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
    ) VALUES (
      'activity-app-1', ${THREAD_ID}, 'turn-1', 'info', 'tool.completed', 'forecast',
      ${JSON.stringify({
        toolCallId: "item-app-1",
        data: {
          item: {
            type: "mcpToolCall",
            server,
            tool: "forecast",
            input: { city: "Oslo" },
            codeworkMcpApp: {
              attachmentId: "att-1",
              server: referenceServer,
              tool: "forecast",
              resourceUri: "ui://weather/forecast",
            },
          },
        },
      })},
      '2026-10-16T00:00:00.000Z'
    )
  `;
});

/** A second activity row for the same tool call, carrying its result. */
const seedResultActivity = Effect.fn("seedResultActivity")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_thread_activities (
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
    ) VALUES (
      'activity-app-2', ${THREAD_ID}, 'turn-1', 'info', 'tool.completed', 'forecast',
      ${JSON.stringify({
        toolCallId: "item-app-1",
        data: {
          item: {
            type: "mcpToolCall",
            server: "weather",
            tool: "forecast",
            result: { content: [{ type: "text", text: "3°C" }] },
          },
        },
      })},
      '2026-10-16T00:00:01.000Z'
    )
  `;
});

const expectReason = (error: McpAppRequestError, reason: McpAppRequestError["reason"]) =>
  assert.deepStrictEqual(error.reason, reason);

requestsLayer("McpAppRequests.callTool", (it) => {
  it.effect("forwards a tool declared callable by apps", () =>
    Effect.gen(function* () {
      yield* seedAppActivity();
      const requests = yield* McpAppRequests.McpAppRequests;
      const result = yield* requests.callTool({
        threadId: THREAD_ID,
        itemId: "item-app-1",
        name: "visible",
      });
      assert.deepStrictEqual(result, { content: [{ type: "text", text: "done" }] });
      const call = mcpCalls.find((entry) => entry.kind === "callTool");
      assert.deepStrictEqual(call?.input, { server: "weather", tool: "visible" });
    }),
  );

  it.effect("rejects a tool its server hid from apps, without calling it", () =>
    Effect.gen(function* () {
      yield* seedAppActivity();
      const requests = yield* McpAppRequests.McpAppRequests;
      const callsBefore = mcpCalls.filter((entry) => entry.kind === "callTool").length;
      const error = yield* Effect.flip(
        requests.callTool({ threadId: THREAD_ID, itemId: "item-app-1", name: "hidden" }),
      );
      expectReason(error, "tool-not-callable");
      assert.strictEqual(mcpCalls.filter((entry) => entry.kind === "callTool").length, callsBefore);
    }),
  );

  it.effect("rejects an unknown tool name the same way", () =>
    Effect.gen(function* () {
      yield* seedAppActivity();
      const requests = yield* McpAppRequests.McpAppRequests;
      const error = yield* Effect.flip(
        requests.callTool({ threadId: THREAD_ID, itemId: "item-app-1", name: "missing" }),
      );
      expectReason(error, "tool-not-callable");
    }),
  );

  it.effect("refuses items whose stored server disagrees with the reference", () =>
    Effect.gen(function* () {
      yield* seedAppActivity({ itemServer: "weather", referenceServer: "other" });
      const requests = yield* McpAppRequests.McpAppRequests;
      const error = yield* Effect.flip(
        requests.callTool({ threadId: THREAD_ID, itemId: "item-app-1", name: "visible" }),
      );
      expectReason(error, "not-an-app");
    }),
  );

  it.effect("reports a stopped session instead of starting one", () =>
    Effect.gen(function* () {
      yield* seedAppActivity();
      bindingLive = false;
      const requests = yield* McpAppRequests.McpAppRequests;
      const error = yield* Effect.flip(
        requests.callTool({ threadId: THREAD_ID, itemId: "item-app-1", name: "visible" }),
      );
      expectReason(error, "session-stopped");
      bindingLive = true;
    }),
  );

  it.effect("reports a thread with no app item at all", () =>
    Effect.gen(function* () {
      const requests = yield* McpAppRequests.McpAppRequests;
      const error = yield* Effect.flip(
        requests.callTool({ threadId: THREAD_ID, itemId: "item-none", name: "visible" }),
      );
      expectReason(error, "not-an-app");
    }),
  );

  it.effect("itemDetail merges the stored rows of the tool call", () =>
    Effect.gen(function* () {
      yield* seedAppActivity();
      yield* seedResultActivity();
      const requests = yield* McpAppRequests.McpAppRequests;
      const detail = yield* requests.itemDetail({ threadId: THREAD_ID, itemId: "item-app-1" });
      assert.deepStrictEqual(detail.item, {
        type: "mcpToolCall",
        server: "weather",
        tool: "forecast",
        input: { city: "Oslo" },
        result: { content: [{ type: "text", text: "3°C" }] },
        codeworkMcpApp: {
          attachmentId: "att-1",
          server: "weather",
          tool: "forecast",
          resourceUri: "ui://weather/forecast",
        },
      });
    }),
  );
});
