import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import * as CompositionRuntimeMcpSessionRegistry from "../mcp/CompositionRuntimeMcpSessionRegistry.ts";
import { makeMulticaTaskMcpLeaseStore } from "./MulticaTaskMcpLease.ts";

const makeRegistry = (now: () => number) =>
  CompositionRuntimeMcpSessionRegistry.__testing
    .make({ now })
    .pipe(Effect.provide(NodeServices.layer));

const input = {
  runtimeId: "multica:daemon-1:runtime-1",
  taskId: "task-1",
  runId: "run-1",
  agentId: "agent-1",
  capabilityGrantIds: ["grant-workspace", "grant-terminal"],
  endpoint: "http://127.0.0.1:4317/mcp/composition-runtime/",
  expiresAtUnixMs: 2_000,
} as const;

describe("MulticaTaskMcpLease", () => {
  it("为每个 Run 生成独立短期 token 和 canonical MCP overlay", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeRegistry(() => 1_000);
        const store = makeMulticaTaskMcpLeaseStore({
          registry,
          tokenFactory: () => "t3mcp-run-1",
          now: () => 1_000,
        });

        const lease = yield* store.issue(input);

        expect(lease.capabilityHandshakeId).not.toBe("");
        expect(lease.endpoint).toBe("http://127.0.0.1:4317/mcp/composition-runtime");
        expect(lease.mcpConfig).toEqual({
          mcpServers: {
            "t3-composition-runtime": {
              type: "http",
              url: "http://127.0.0.1:4317/mcp/composition-runtime",
              headers: { Authorization: "Bearer t3mcp-run-1" },
            },
          },
        });
        expect(yield* store.get(lease.capabilityHandshakeId)).toEqual(lease);
        expect(yield* registry.resolve("t3mcp-run-1")).toEqual(lease.binding);
      }),
    );
  });

  it("拒绝无效 endpoint，并在 Runtime 撤销时清理 raw token lease", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeRegistry(() => 1_000);
        const store = makeMulticaTaskMcpLeaseStore({
          registry,
          tokenFactory: () => "t3mcp-run-2",
          now: () => 1_000,
        });

        const invalid = yield* store
          .issue({ ...input, endpoint: "stdio://not-http" })
          .pipe(Effect.flip);
        expect(invalid.code).toBe("invalid_input");

        const lease = yield* store.issue({ ...input, runId: "run-2" });
        yield* store.revokeRuntime(input.runtimeId);
        expect(yield* store.get(lease.capabilityHandshakeId)).toBeUndefined();
        expect(yield* registry.resolve("t3mcp-run-2")).toBeUndefined();
      }),
    );
  });

  it("相同 token 不能跨 Run 重用", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeRegistry(() => 1_000);
        const store = makeMulticaTaskMcpLeaseStore({
          registry,
          tokenFactory: () => "t3mcp-reused",
          now: () => 1_000,
        });

        yield* store.issue(input);
        const error = yield* store.issue({ ...input, runId: "run-2" }).pipe(Effect.flip);
        expect(error.code).toBe("credential_in_use");
      }),
    );
  });
});
