import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  CompositionMcpRuntimeServerState as ContractCompositionMcpRuntimeServerState,
  CompositionMcpRuntimeServerStatus as ContractCompositionMcpRuntimeServerStatus,
} from "@t3tools/contracts";
import { CompositionMcpRuntimeServerState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  CompositionMcpToolRegistry,
  CompositionMcpToolFailure,
  type CompositionMcpToolInvocation,
  type CompositionMcpToolRegistryShape,
} from "./CompositionMcpToolRegistry.ts";

export type CompositionMcpRuntimeTransport = "stdio" | "http" | "sse";

export type CompositionMcpRuntimeServerConfig = {
  readonly serverId: string;
  readonly name: string;
  readonly transport: CompositionMcpRuntimeTransport;
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly trusted: boolean;
  readonly enabled?: boolean;
};

export type CompositionMcpRuntimeTool = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
  };
};

export type CompositionMcpRuntimeClient = {
  readonly listTools: () => Promise<ReadonlyArray<CompositionMcpRuntimeTool>>;
  readonly callTool: (
    input: { readonly name: string; readonly arguments?: unknown },
    options?: { readonly signal?: AbortSignal },
  ) => Promise<unknown>;
  readonly close: () => Promise<void>;
};

export type CompositionMcpRuntimeServerStatus = ContractCompositionMcpRuntimeServerStatus;
export type CompositionMcpRuntimeServerState = ContractCompositionMcpRuntimeServerState;

export class CompositionMcpRuntimeError extends Schema.TaggedErrorClass<CompositionMcpRuntimeError>()(
  "CompositionMcpRuntimeError",
  { serverId: Schema.String, code: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `MCP runtime 操作失败：${this.serverId}: ${this.code}`;
  }
}

export type CompositionMcpRuntimeClientFactory = (
  config: CompositionMcpRuntimeServerConfig,
) => Effect.Effect<CompositionMcpRuntimeClient, CompositionMcpRuntimeError>;

export type CompositionMcpRuntimeAdapterShape = {
  readonly registerServer: (
    config: CompositionMcpRuntimeServerConfig,
  ) => Effect.Effect<void, CompositionMcpRuntimeError>;
  readonly unregisterServer: (serverId: string) => Effect.Effect<boolean>;
  readonly connect: (serverId: string) => Effect.Effect<void, CompositionMcpRuntimeError>;
  readonly disconnect: (serverId: string) => Effect.Effect<boolean>;
  readonly listServers: () => Effect.Effect<ReadonlyArray<CompositionMcpRuntimeServerState>>;
  readonly cancel: (input: { readonly idempotencyKey: string }) => Effect.Effect<boolean>;
};

export class CompositionMcpRuntimeAdapterService extends Context.Service<
  CompositionMcpRuntimeAdapterService,
  CompositionMcpRuntimeAdapterShape
>()("t3/composition/CompositionMcpRuntimeAdapter") {}

export type CompositionMcpRuntimeAdapterOptions = {
  readonly toolRegistry: CompositionMcpToolRegistryShape;
  readonly createClient?: CompositionMcpRuntimeClientFactory;
};

type RuntimeServerRecord = {
  readonly config: CompositionMcpRuntimeServerConfig;
  status: CompositionMcpRuntimeServerStatus;
  client?: CompositionMcpRuntimeClient;
  toolNames: string[];
  errorCode?: string;
};

type ToolCallState = {
  readonly controller: AbortController;
  readonly serverId: string;
  readonly toolName: string;
};

const normalizeErrorDetail = (error: unknown): string => {
  const detail =
    error instanceof CompositionMcpRuntimeError
      ? error.detail
      : error instanceof Error && error.message.trim().length > 0
        ? error.message
        : "MCP runtime 返回未知错误";
  return detail
    .replace(
      /(api[_-]?key|authorization|bearer|access[_-]?token|password|secret|token)\s*[:=]\s*[^\s,;]+/gi,
      "$1=<redacted>",
    )
    .slice(0, 512);
};

const operationForTool = (tool: CompositionMcpRuntimeTool): "read" | "execute" | "mutate" => {
  if (tool.annotations?.destructiveHint === true) return "mutate";
  if (tool.annotations?.readOnlyHint === true) return "read";
  return "execute";
};

const createSdkClient = (
  config: CompositionMcpRuntimeServerConfig,
): Effect.Effect<CompositionMcpRuntimeClient, CompositionMcpRuntimeError> =>
  Effect.tryPromise({
    try: async () => {
      let transport: Transport;
      if (config.transport === "stdio") {
        if (config.command === undefined || config.command.trim().length === 0) {
          throw new CompositionMcpRuntimeError({
            serverId: config.serverId,
            code: "mcp_command_required",
            detail: "stdio transport requires command",
          });
        }
        transport = new StdioClientTransport({
          command: config.command,
          args: [...(config.args ?? [])],
          env: config.env === undefined ? undefined : { ...config.env },
          cwd: config.cwd,
          stderr: "pipe",
        });
      } else {
        if (config.url === undefined || config.url.trim().length === 0) {
          throw new CompositionMcpRuntimeError({
            serverId: config.serverId,
            code: "mcp_url_required",
            detail: `${config.transport} transport requires url`,
          });
        }
        const url = new URL(config.url);
        const requestInit =
          config.headers === undefined ? undefined : { headers: { ...config.headers } };
        transport =
          config.transport === "http"
            ? new StreamableHTTPClientTransport(url, { requestInit })
            : new SSEClientTransport(url, { requestInit });
      }

      const client = new Client({ name: "t3-code", version: "0.0.33" });
      await client.connect(transport);
      return {
        listTools: async () => (await client.listTools()).tools,
        callTool: (input, options) => client.callTool(input, undefined, options),
        close: () => client.close(),
      } satisfies CompositionMcpRuntimeClient;
    },
    catch: (error) =>
      error instanceof CompositionMcpRuntimeError
        ? error
        : new CompositionMcpRuntimeError({
            serverId: config.serverId,
            code: "mcp_connection_failed",
            detail: normalizeErrorDetail(error),
          }),
  });

const make = (options: CompositionMcpRuntimeAdapterOptions): CompositionMcpRuntimeAdapterShape => {
  const createClient = options.createClient ?? createSdkClient;
  const servers = new Map<string, RuntimeServerRecord>();
  const activeCalls = new Map<string, ToolCallState>();
  const cancelledKeys = new Set<string>();
  const cancelledKeyOrder: string[] = [];
  const maxCancelledKeys = 4096;

  const unregisterTools = (record: RuntimeServerRecord) =>
    Effect.forEach(
      record.toolNames,
      (toolName) => options.toolRegistry.unregister(`mcp.${record.config.serverId}.${toolName}`),
      { discard: true },
    ).pipe(Effect.asVoid);

  const closeClient = (record: RuntimeServerRecord) =>
    record.client === undefined
      ? Effect.succeed(undefined)
      : Effect.tryPromise({
          try: () => record.client!.close(),
          catch: () => undefined,
        });

  const registerServer: CompositionMcpRuntimeAdapterShape["registerServer"] = (config) =>
    Effect.gen(function* () {
      if (servers.has(config.serverId)) {
        return yield* new CompositionMcpRuntimeError({
          serverId: config.serverId,
          code: "mcp_server_duplicate",
          detail: "serverId is already registered",
        });
      }
      servers.set(config.serverId, {
        config: { ...config, enabled: config.enabled ?? true },
        status: "registered",
        toolNames: [],
      });
    });

  const disconnect: CompositionMcpRuntimeAdapterShape["disconnect"] = (serverId) =>
    Effect.gen(function* () {
      const record = servers.get(serverId);
      if (record === undefined) return false;
      for (const [key, call] of activeCalls) {
        if (call.serverId === serverId) {
          call.controller.abort();
          activeCalls.delete(key);
        }
      }
      yield* unregisterTools(record);
      yield* closeClient(record);
      record.client = undefined;
      record.toolNames = [];
      if (record.status !== "error") record.status = "registered";
      return true;
    });

  const connect: CompositionMcpRuntimeAdapterShape["connect"] = (serverId) =>
    Effect.gen(function* () {
      const record = servers.get(serverId);
      if (record === undefined) {
        return yield* new CompositionMcpRuntimeError({
          serverId,
          code: "mcp_server_not_found",
          detail: "server is not registered",
        });
      }
      if (record.config.enabled !== true) {
        record.status = "error";
        record.errorCode = "mcp_server_disabled";
        return yield* new CompositionMcpRuntimeError({
          serverId,
          code: "mcp_server_disabled",
          detail: "server is disabled",
        });
      }
      if (!record.config.trusted) {
        record.status = "error";
        record.errorCode = "mcp_server_untrusted";
        return yield* new CompositionMcpRuntimeError({
          serverId,
          code: "mcp_server_untrusted",
          detail: "server trust is required before connection",
        });
      }
      if (record.status === "connected" && record.client !== undefined) return;

      yield* unregisterTools(record);
      record.toolNames = [];
      record.status = "connecting";
      record.errorCode = undefined;
      const client = yield* createClient(record.config).pipe(
        Effect.catch((error) => {
          record.status = "error";
          record.errorCode = error.code;
          return Effect.fail(error);
        }),
      );
      record.client = client;
      const tools = yield* Effect.tryPromise({
        try: () => client.listTools(),
        catch: (error) =>
          new CompositionMcpRuntimeError({
            serverId,
            code: "mcp_catalog_failed",
            detail: normalizeErrorDetail(error),
          }),
      }).pipe(
        Effect.catch((error) => {
          record.status = "error";
          record.errorCode = error.code;
          return closeClient(record).pipe(Effect.andThen(Effect.fail(error)));
        }),
      );

      yield* Effect.gen(function* () {
        for (const tool of tools) {
          const canonicalToolName = `mcp.${record.config.serverId.trim()}.${tool.name.trim()}`;
          yield* options.toolRegistry.register({
            serverId: record.config.serverId,
            toolName: tool.name,
            description: tool.description ?? tool.name,
            inputSchema: tool.inputSchema ?? { type: "object" },
            operation: operationForTool(tool),
            trusted: true,
            status: "available",
            source: "runtime",
            invoke: (input: CompositionMcpToolInvocation) => {
              const key = input.idempotencyKey;
              if (cancelledKeys.delete(key)) {
                return Effect.fail(
                  new CompositionMcpToolFailure({
                    canonicalToolName,
                    code: "mcp_call_cancelled",
                    detail: "call was cancelled before execution",
                  }),
                );
              }
              const controller = new AbortController();
              activeCalls.set(key, {
                controller,
                serverId,
                toolName: tool.name,
              });
              return Effect.tryPromise({
                try: async () => {
                  const result = await client.callTool(
                    { name: tool.name, arguments: input.arguments },
                    { signal: controller.signal },
                  );
                  if (controller.signal.aborted) {
                    throw new CompositionMcpToolFailure({
                      canonicalToolName,
                      code: "mcp_call_cancelled",
                      detail: "call was cancelled",
                    });
                  }
                  return result;
                },
                catch: (error) =>
                  error instanceof CompositionMcpToolFailure
                    ? error
                    : controller.signal.aborted
                      ? new CompositionMcpToolFailure({
                          canonicalToolName,
                          code: "mcp_call_cancelled",
                          detail: "call was cancelled",
                        })
                      : new CompositionMcpToolFailure({
                          canonicalToolName,
                          code: "mcp_call_failed",
                          detail: normalizeErrorDetail(error),
                        }),
              }).pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    controller.abort();
                  }),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    if (activeCalls.get(key)?.controller === controller) activeCalls.delete(key);
                  }),
                ),
              );
            },
          });
          record.toolNames.push(tool.name.trim());
        }
      }).pipe(
        Effect.catch((error) => {
          record.status = "error";
          record.errorCode = "mcp_catalog_invalid";
          return unregisterTools(record).pipe(
            Effect.andThen(closeClient(record)),
            Effect.andThen(
              Effect.fail(
                new CompositionMcpRuntimeError({
                  serverId,
                  code: "mcp_catalog_invalid",
                  detail: normalizeErrorDetail(error),
                }),
              ),
            ),
          );
        }),
      );
      record.status = "connected";
    });

  const unregisterServer: CompositionMcpRuntimeAdapterShape["unregisterServer"] = (serverId) =>
    Effect.gen(function* () {
      const record = servers.get(serverId);
      if (record === undefined) return false;
      yield* disconnect(serverId);
      servers.delete(serverId);
      return true;
    });

  return {
    registerServer,
    unregisterServer,
    connect,
    disconnect,
    listServers: () =>
      Effect.succeed(
        [...servers.values()]
          .sort((left, right) => left.config.serverId.localeCompare(right.config.serverId))
          .map((record) =>
            Schema.decodeUnknownSync(CompositionMcpRuntimeServerState)({
              serverId: record.config.serverId,
              name: record.config.name,
              transport: record.config.transport,
              trusted: record.config.trusted,
              enabled: record.config.enabled === true,
              status: record.status,
              toolNames: [...record.toolNames].sort(),
              ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
            }),
          ),
      ),
    cancel: ({ idempotencyKey }) =>
      Effect.sync(() => {
        const call = activeCalls.get(idempotencyKey);
        if (call !== undefined) {
          call.controller.abort();
          activeCalls.delete(idempotencyKey);
          return true;
        }
        cancelledKeys.add(idempotencyKey);
        cancelledKeyOrder.push(idempotencyKey);
        if (cancelledKeyOrder.length > maxCancelledKeys) {
          const expiredKey = cancelledKeyOrder.shift();
          if (expiredKey !== undefined) cancelledKeys.delete(expiredKey);
        }
        return false;
      }),
  };
};

export const makeCompositionMcpRuntimeAdapter = (
  options: CompositionMcpRuntimeAdapterOptions,
): CompositionMcpRuntimeAdapterShape => make(options);

const live = Effect.gen(function* () {
  const toolRegistry = yield* CompositionMcpToolRegistry;
  const adapter = makeCompositionMcpRuntimeAdapter({ toolRegistry });
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const servers = yield* adapter.listServers();
      yield* Effect.forEach(servers, (server) => adapter.disconnect(server.serverId), {
        discard: true,
      });
    }),
  );
  return adapter;
});

export const layer = Layer.effect(CompositionMcpRuntimeAdapterService, live);
