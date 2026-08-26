import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  CompositionMcpRuntimeError,
  makeCompositionMcpRuntimeAdapter,
  type CompositionMcpRuntimeClient,
  type CompositionMcpRuntimeServerConfig,
} from "./CompositionMcpRuntimeAdapter.ts";
import { makeCompositionMcpToolRegistry } from "./CompositionMcpToolRegistry.ts";

const serverConfig: CompositionMcpRuntimeServerConfig = {
  serverId: "local-tools",
  name: "Local Tools",
  transport: "stdio",
  command: "node",
  args: ["local-mcp-server.mjs"],
  trusted: true,
};

const makeClient = (
  options: {
    readonly calls?: Array<{ readonly name: string; readonly arguments: unknown }>;
    readonly closed?: { value: boolean };
  } = {},
): CompositionMcpRuntimeClient => ({
  listTools: () =>
    Promise.resolve([
      {
        name: "echo",
        description: "回显输入",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        annotations: { readOnlyHint: true },
      },
    ]),
  callTool: (input) => {
    options.calls?.push(input);
    return Promise.resolve({ content: [{ type: "text", text: "ok" }] });
  },
  close: () => {
    if (options.closed) options.closed.value = true;
    return Promise.resolve();
  },
});

describe("CompositionMcpRuntimeAdapter", () => {
  it("连接受信 MCP server、发现工具并投影到 Composition registry", async () => {
    const toolRegistry = makeCompositionMcpToolRegistry();
    const adapter = makeCompositionMcpRuntimeAdapter({
      toolRegistry,
      createClient: () => Effect.succeed(makeClient()),
    });

    await Effect.runPromise(adapter.registerServer(serverConfig));
    await Effect.runPromise(adapter.connect("local-tools"));

    await expect(Effect.runPromise(adapter.listServers())).resolves.toEqual([
      expect.objectContaining({
        serverId: "local-tools",
        status: "connected",
        trusted: true,
        toolNames: ["echo"],
      }),
    ]);
    await expect(Effect.runPromise(toolRegistry.get("mcp.local-tools.echo"))).resolves.toEqual(
      expect.objectContaining({
        canonicalToolName: "mcp.local-tools.echo",
        operation: "read",
        status: "available",
      }),
    );
  });

  it("未信任 server 不启动进程，也不向 ToolBroker 注册工具", async () => {
    let created = false;
    const toolRegistry = makeCompositionMcpToolRegistry();
    const adapter = makeCompositionMcpRuntimeAdapter({
      toolRegistry,
      createClient: () =>
        Effect.sync(() => {
          created = true;
          return makeClient();
        }),
    });

    await Effect.runPromise(
      adapter.registerServer({ ...serverConfig, serverId: "untrusted", trusted: false }),
    );
    await expect(Effect.runPromise(adapter.connect("untrusted"))).rejects.toMatchObject({
      code: "mcp_server_untrusted",
    });
    expect(created).toBe(false);
    await expect(Effect.runPromise(toolRegistry.list())).resolves.toEqual([]);
  });

  it("通过已注册 canonical tool 调用真实 client，并支持按幂等键取消", async () => {
    const calls: Array<{ readonly name: string; readonly arguments: unknown }> = [];
    const toolRegistry = makeCompositionMcpToolRegistry();
    const adapter = makeCompositionMcpRuntimeAdapter({
      toolRegistry,
      createClient: () => Effect.succeed(makeClient({ calls })),
    });
    await Effect.runPromise(adapter.registerServer(serverConfig));
    await Effect.runPromise(adapter.connect("local-tools"));

    const result = await Effect.runPromise(
      toolRegistry.invoke({
        canonicalToolName: "mcp.local-tools.echo",
        serverId: "local-tools",
        toolName: "echo",
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        workspaceRoot: "C:/workspace",
        idempotencyKey: "mcp-call-1",
        arguments: { text: "hello" },
      }),
    );
    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(calls).toEqual([{ name: "echo", arguments: { text: "hello" } }]);

    await Effect.runPromise(adapter.cancel({ idempotencyKey: "mcp-call-2" }));
    await expect(
      Effect.runPromise(
        toolRegistry.invoke({
          canonicalToolName: "mcp.local-tools.echo",
          serverId: "local-tools",
          toolName: "echo",
          taskId: "task-1",
          runId: "run-1",
          agentId: "agent-1",
          workspaceRoot: "C:/workspace",
          idempotencyKey: "mcp-call-2",
          arguments: { text: "cancelled" },
        }),
      ),
    ).rejects.toMatchObject({ code: "mcp_call_cancelled" });
  });

  it("连接失败会留下稳定状态和错误码，并能安全注销", async () => {
    const closed = { value: false };
    const toolRegistry = makeCompositionMcpToolRegistry();
    const adapter = makeCompositionMcpRuntimeAdapter({
      toolRegistry,
      createClient: () =>
        Effect.fail(
          new CompositionMcpRuntimeError({
            serverId: "local-tools",
            code: "mcp_connection_failed",
            detail: "test connection failed",
          }),
        ),
    });
    await Effect.runPromise(adapter.registerServer(serverConfig));
    await expect(Effect.runPromise(adapter.connect("local-tools"))).rejects.toMatchObject({
      code: "mcp_connection_failed",
    });
    await expect(Effect.runPromise(adapter.listServers())).resolves.toEqual([
      expect.objectContaining({ serverId: "local-tools", status: "error" }),
    ]);

    const connectedAdapter = makeCompositionMcpRuntimeAdapter({
      toolRegistry,
      createClient: () => Effect.succeed(makeClient({ closed })),
    });
    await Effect.runPromise(connectedAdapter.registerServer(serverConfig));
    await Effect.runPromise(connectedAdapter.connect("local-tools"));
    await Effect.runPromise(connectedAdapter.unregisterServer("local-tools"));
    expect(closed.value).toBe(true);
  });
});
