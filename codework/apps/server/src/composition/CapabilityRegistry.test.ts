import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CompositionMcpToolRegistry from "./CompositionMcpToolRegistry.ts";
import * as CapabilityRegistry from "./CapabilityRegistry.ts";

describe("CapabilityRegistry", () => {
  it("可以在真实 MCP Registry Layer 下构造并列出能力", async () => {
    const capabilities = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* CapabilityRegistry.CapabilityRegistry;
        return yield* registry.list({ scope: "workspace", scopeId: "workspace-1" });
      }).pipe(
        Effect.provide(
          CapabilityRegistry.layer.pipe(Layer.provide(CompositionMcpToolRegistry.layer)),
        ),
      ),
    );

    expect(capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capabilityId: "t3.workspace.read_file" }),
        expect.objectContaining({ capabilityId: "t3.mcp.preview" }),
      ]),
    );
  });
});
