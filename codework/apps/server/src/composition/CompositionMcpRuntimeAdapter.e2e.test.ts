import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
// 该用例为普通 async 测试，无法接入 Effect 的 Path 服务；cwd 拼接保持 node:path。
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import { makeCompositionMcpRuntimeAdapter } from "./CompositionMcpRuntimeAdapter.ts";
import { makeCompositionMcpToolRegistry } from "./CompositionMcpToolRegistry.ts";

const localServerScript = `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "t3-local-test-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [
    {
      type: "text",
      text: String(request.params.arguments?.text ?? ""),
    },
  ],
}));

await server.connect(new StdioServerTransport());
`;

describe("CompositionMcpRuntimeAdapter 本地 stdio E2E", () => {
  it("真实启动 MCP server、发现工具、调用工具并关闭进程", async () => {
    const toolRegistry = makeCompositionMcpToolRegistry();
    const adapter = makeCompositionMcpRuntimeAdapter({ toolRegistry });
    const serverId = "local-stdio-e2e";

    await Effect.runPromise(
      adapter.registerServer({
        serverId,
        name: "Local stdio E2E",
        transport: "stdio",
        command: process.execPath,
        args: ["--input-type=module", "-e", localServerScript],
        cwd: join(process.cwd(), "apps/server"),
        trusted: true,
      }),
    );

    try {
      await Effect.runPromise(adapter.connect(serverId));
      await expect(Effect.runPromise(toolRegistry.get(`mcp.${serverId}.echo`))).resolves.toEqual(
        expect.objectContaining({ operation: "read", status: "available" }),
      );

      await expect(
        Effect.runPromise(
          toolRegistry.invoke({
            canonicalToolName: `mcp.${serverId}.echo`,
            serverId,
            toolName: "echo",
            taskId: "task-stdio-e2e",
            runId: "run-stdio-e2e",
            agentId: "agent-stdio-e2e",
            workspaceRoot: "C:/workspace",
            idempotencyKey: "call-stdio-e2e",
            arguments: { text: "真实 stdio" },
          }),
        ),
      ).resolves.toEqual({ content: [{ type: "text", text: "真实 stdio" }] });
    } finally {
      await Effect.runPromise(adapter.unregisterServer(serverId));
    }
  }, 30_000);
});
