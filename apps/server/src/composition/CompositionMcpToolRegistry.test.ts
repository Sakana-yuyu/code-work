import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import {
  CompositionMcpToolRegistrationError,
  CompositionMcpToolTrustError,
  makeCompositionMcpToolRegistry,
} from "./CompositionMcpToolRegistry.ts";

const baseRegistration = {
  serverId: "github",
  toolName: "fetch_pr",
  description: "读取 Pull Request",
  inputSchema: {
    type: "object",
    properties: { number: { type: "integer" } },
    required: ["number"],
  },
  operation: "read" as const,
  trusted: true,
  invoke: () => Effect.succeed({ body: "apiKey: should-be-redacted", number: 42 }),
};

describe("CompositionMcpToolRegistry", () => {
  it("注册受信 MCP 工具并生成稳定的 canonical capability", async () => {
    const registry = makeCompositionMcpToolRegistry();

    await Effect.runPromise(registry.register(baseRegistration));

    await expect(Effect.runPromise(registry.list())).resolves.toEqual([
      expect.objectContaining({
        canonicalToolName: "mcp.github.fetch_pr",
        serverId: "github",
        toolName: "fetch_pr",
        trusted: true,
        status: "available",
        capabilityDescriptor: {
          capabilityId: "t3.mcp.github.fetch_pr",
          kind: "mcp",
          version: "1",
          status: "available",
          grants: { read: true, execute: false, mutate: false },
          approval: "never",
          source: "runtime",
        },
      }),
    ]);
  });

  it("拒绝重复 canonical 工具和非法 JSON Schema", async () => {
    const registry = makeCompositionMcpToolRegistry();
    await Effect.runPromise(registry.register(baseRegistration));

    await expect(Effect.runPromise(registry.register(baseRegistration))).rejects.toBeInstanceOf(
      CompositionMcpToolRegistrationError,
    );
    await expect(
      Effect.runPromise(
        registry.register({
          ...baseRegistration,
          toolName: "broken_schema",
          inputSchema: { type: "not-a-json-schema-type" },
        }),
      ),
    ).rejects.toMatchObject({ code: "mcp_input_schema_invalid" });
  });

  it("把未信任工具保留在目录中但稳定标记为 unavailable 且禁止调用", async () => {
    const registry = makeCompositionMcpToolRegistry();
    let called = false;
    await Effect.runPromise(
      registry.register({
        ...baseRegistration,
        toolName: "untrusted_tool",
        trusted: false,
        invoke: () =>
          Effect.sync(() => {
            called = true;
            return "must-not-run";
          }),
      }),
    );

    await expect(Effect.runPromise(registry.list())).resolves.toEqual([
      expect.objectContaining({
        canonicalToolName: "mcp.github.untrusted_tool",
        trusted: false,
        status: "unavailable",
        capabilityDescriptor: expect.objectContaining({ status: "unavailable" }),
      }),
    ]);
    await expect(
      Effect.runPromise(
        registry.invoke({
          canonicalToolName: "mcp.github.untrusted_tool",
          serverId: "github",
          toolName: "untrusted_tool",
          taskId: "task-1",
          runId: "run-1",
          agentId: "agent-1",
          workspaceRoot: "C:/workspace",
          arguments: { number: 1 },
        }),
      ),
    ).rejects.toBeInstanceOf(CompositionMcpToolTrustError);
    expect(called).toBe(false);
  });

  it("对输入和输出执行大小限制与敏感字段脱敏", async () => {
    const registry = makeCompositionMcpToolRegistry({ maxPayloadBytes: 128 });
    await Effect.runPromise(registry.register(baseRegistration));

    await expect(
      Effect.runPromise(
        registry.invoke({
          canonicalToolName: "mcp.github.fetch_pr",
          serverId: "github",
          toolName: "fetch_pr",
          taskId: "task-1",
          runId: "run-1",
          agentId: "agent-1",
          workspaceRoot: "C:/workspace",
          arguments: { number: "x".repeat(256) },
        }),
      ),
    ).rejects.toMatchObject({ code: "mcp_payload_too_large" });

    const result = await Effect.runPromise(
      registry.invoke({
        canonicalToolName: "mcp.github.fetch_pr",
        serverId: "github",
        toolName: "fetch_pr",
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        workspaceRoot: "C:/workspace",
        arguments: { number: 1 },
      }),
    );
    expect(result).toEqual({ body: "apiKey: [REDACTED]", number: 42 });
  });

  it("按注册的 JSON Schema 拒绝不匹配的 MCP 参数", async () => {
    const registry = makeCompositionMcpToolRegistry();
    await Effect.runPromise(registry.register(baseRegistration));

    await expect(
      Effect.runPromise(
        registry.invoke({
          canonicalToolName: "mcp.github.fetch_pr",
          serverId: "github",
          toolName: "fetch_pr",
          taskId: "task-1",
          runId: "run-1",
          agentId: "agent-1",
          workspaceRoot: "C:/workspace",
          arguments: { number: "not-an-integer" },
        }),
      ),
    ).rejects.toMatchObject({ code: "mcp_arguments_invalid" });
  });

  it("在 handler 超过单次调用预算时返回稳定超时错误", async () => {
    const registry = makeCompositionMcpToolRegistry();
    await Effect.runPromise(
      registry.register({
        ...baseRegistration,
        toolName: "slow_tool",
        timeoutMs: 1,
        invoke: () => Effect.sleep(Duration.millis(20)).pipe(Effect.as({ done: true })),
      }),
    );

    await expect(
      Effect.runPromise(
        registry.invoke({
          canonicalToolName: "mcp.github.slow_tool",
          serverId: "github",
          toolName: "slow_tool",
          taskId: "task-1",
          runId: "run-1",
          agentId: "agent-1",
          workspaceRoot: "C:/workspace",
          arguments: { number: 1 },
        }),
      ),
    ).rejects.toMatchObject({ code: "mcp_timeout" });
  });

  it("未知 MCP 工具不会被猜测或静默降级", async () => {
    const registry = makeCompositionMcpToolRegistry();

    await expect(
      Effect.runPromise(
        registry.invoke({
          canonicalToolName: "mcp.unknown.tool",
          serverId: "unknown",
          toolName: "tool",
          taskId: "task-1",
          runId: "run-1",
          agentId: "agent-1",
          workspaceRoot: "C:/workspace",
          arguments: {},
        }),
      ),
    ).rejects.toMatchObject({ code: "mcp_tool_unavailable" });
  });
});
