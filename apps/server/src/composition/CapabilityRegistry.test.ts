import type { CompositionCapabilityDescriptor } from "@codework/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CompositionMcpToolRegistry from "./CompositionMcpToolRegistry.ts";
import * as CapabilityRegistry from "./CapabilityRegistry.ts";

const makeMcpCapability = (
  capabilityId: string,
  status: CompositionCapabilityDescriptor["status"] = "available",
): CompositionCapabilityDescriptor => ({
  capabilityId,
  kind: "mcp",
  version: "1",
  status,
  grants: { read: true, execute: true, mutate: false },
  approval: "never",
  source: "runtime",
});

describe("CapabilityRegistry", () => {
  it.effect("可以在真实 MCP Registry Layer 下构造并列出能力", () =>
    Effect.gen(function* () {
      const registry = yield* CapabilityRegistry.CapabilityRegistry;
      const capabilities = yield* registry.list({
        scope: "workspace",
        scopeId: "workspace-1",
      });

      expect(capabilities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ capabilityId: "t3.workspace.read_file" }),
          expect.objectContaining({ capabilityId: "t3.mcp.preview" }),
        ]),
      );
    }).pipe(
      Effect.provide(
        CapabilityRegistry.layer.pipe(Layer.provide(CompositionMcpToolRegistry.layer)),
      ),
    ),
  );

  it.effect("scope 不存在时返回稳定错误且不读取 descriptor 列表", () =>
    Effect.gen(function* () {
      let listCalls = 0;
      const registry = CapabilityRegistry.makeCompositionCapabilityRegistry({
        mcpToolRegistry: {
          listCapabilityDescriptors: () =>
            Effect.sync(() => {
              listCalls += 1;
              return [];
            }),
        },
      });

      const error = yield* Effect.flip(
        registry.resolveRequired({
          scope: "workspace",
          scopeId: " ",
          capabilityIds: ["t3.workspace.read_file"],
        }),
      );

      expect(error).toMatchObject({
        _tag: "CapabilityScopeNotFoundError",
        scope: "workspace",
        scopeId: " ",
      });
      expect(listCalls).toBe(0);
    }),
  );

  it.effect("descriptor 列表失败时传播 registry unavailable，而不是误报 capability missing", () =>
    Effect.gen(function* () {
      const failure = new CapabilityRegistry.CapabilityRegistryUnavailableError({
        reason: "mcp_registry_offline",
      });
      const registry = CapabilityRegistry.makeCompositionCapabilityRegistry({
        mcpToolRegistry: {
          listCapabilityDescriptors: () => Effect.fail(failure),
        },
      });

      const error = yield* Effect.flip(
        registry.resolveRequired({
          scope: "workspace",
          scopeId: "workspace-list-failure",
          capabilityIds: ["t3.workspace.read_file"],
        }),
      );

      expect(error).toBe(failure);
    }),
  );

  it.effect("缺失 capability 时返回 missing", () =>
    Effect.gen(function* () {
      const registry = CapabilityRegistry.makeCompositionCapabilityRegistry();

      const error = yield* Effect.flip(
        registry.resolveRequired({
          scope: "task",
          scopeId: "task-missing",
          capabilityIds: ["t3.mcp.removed_tool"],
        }),
      );

      expect(error).toMatchObject({
        _tag: "CapabilityNotAvailableError",
        capabilityId: "t3.mcp.removed_tool",
        reason: "missing",
        scope: "task",
        scopeId: "task-missing",
      });
    }),
  );

  it.effect("拒绝 unavailable capability", () =>
    Effect.gen(function* () {
      const capabilityId = "t3.mcp.unavailable_tool";
      const registry = CapabilityRegistry.makeCompositionCapabilityRegistry({
        mcpToolRegistry: {
          listCapabilityDescriptors: () =>
            Effect.succeed([makeMcpCapability(capabilityId, "unavailable")]),
        },
      });

      const error = yield* Effect.flip(
        registry.resolveRequired({
          scope: "agent",
          scopeId: "agent-unavailable",
          capabilityIds: [capabilityId],
        }),
      );

      expect(error).toMatchObject({
        _tag: "CapabilityNotAvailableError",
        capabilityId,
        reason: "unavailable",
      });
    }),
  );

  it.effect("允许 degraded capability 并按输入顺序返回 descriptor", () =>
    Effect.gen(function* () {
      const first = makeMcpCapability("t3.mcp.first", "degraded");
      const second = makeMcpCapability("t3.mcp.second");
      const registry = CapabilityRegistry.makeCompositionCapabilityRegistry({
        mcpToolRegistry: {
          listCapabilityDescriptors: () => Effect.succeed([first, second]),
        },
      });

      const resolved = yield* registry.resolveRequired({
        scope: "workspace",
        scopeId: "workspace-order",
        capabilityIds: [second.capabilityId, first.capabilityId],
      });

      expect(resolved.map((descriptor) => descriptor.capabilityId)).toEqual([
        second.capabilityId,
        first.capabilityId,
      ]);
      expect(resolved[1]).toMatchObject({ status: "degraded" });
    }),
  );

  it.effect("拒绝空 capability 列表，并在读取 descriptor 前失败", () =>
    Effect.gen(function* () {
      let listCalls = 0;
      const registry = CapabilityRegistry.makeCompositionCapabilityRegistry({
        mcpToolRegistry: {
          listCapabilityDescriptors: () =>
            Effect.sync(() => {
              listCalls += 1;
              return [];
            }),
        },
      });

      const error = yield* Effect.flip(
        registry.resolveRequired({
          scope: "task",
          scopeId: "task-empty-list",
          capabilityIds: [],
        }),
      );

      expect(error).toMatchObject({
        _tag: "CapabilityNotAvailableError",
        capabilityId: "",
        reason: "input_invalid",
      });
      expect(listCalls).toBe(0);
    }),
  );

  it.effect("拒绝重复 capability id，并在读取 descriptor 前失败", () =>
    Effect.gen(function* () {
      let listCalls = 0;
      const capabilityId = "t3.workspace.read_file";
      const registry = CapabilityRegistry.makeCompositionCapabilityRegistry({
        mcpToolRegistry: {
          listCapabilityDescriptors: () =>
            Effect.sync(() => {
              listCalls += 1;
              return [];
            }),
        },
      });

      const error = yield* Effect.flip(
        registry.resolveRequired({
          scope: "task",
          scopeId: "task-duplicate",
          capabilityIds: [capabilityId, capabilityId],
        }),
      );

      expect(error).toMatchObject({
        _tag: "CapabilityNotAvailableError",
        capabilityId,
        reason: "duplicate",
      });
      expect(listCalls).toBe(0);
    }),
  );

  it.effect("拒绝 trim 后为空的 capability id，并在读取 descriptor 前失败", () =>
    Effect.gen(function* () {
      let listCalls = 0;
      const registry = CapabilityRegistry.makeCompositionCapabilityRegistry({
        mcpToolRegistry: {
          listCapabilityDescriptors: () =>
            Effect.sync(() => {
              listCalls += 1;
              return [];
            }),
        },
      });

      const error = yield* Effect.flip(
        registry.resolveRequired({
          scope: "task",
          scopeId: "task-empty",
          capabilityIds: ["  "],
        }),
      );

      expect(error).toMatchObject({
        _tag: "CapabilityNotAvailableError",
        capabilityId: "",
        reason: "input_invalid",
      });
      expect(listCalls).toBe(0);
    }),
  );

  it.effect("同一 descriptor 快照包含重复 capability id 时整个 registry fail-closed", () =>
    Effect.gen(function* () {
      const capabilityId = "t3.mcp.duplicate_descriptor";
      const available = makeMcpCapability(capabilityId);
      const degraded = makeMcpCapability(capabilityId, "degraded");
      for (const descriptors of [
        [available, degraded],
        [degraded, available],
      ]) {
        const registry = CapabilityRegistry.makeCompositionCapabilityRegistry({
          mcpToolRegistry: {
            listCapabilityDescriptors: () => Effect.succeed(descriptors),
          },
        });

        const listError = yield* Effect.flip(
          registry.list({
            scope: "task",
            scopeId: "task-duplicate-descriptor",
          }),
        );
        const resolveError = yield* Effect.flip(
          registry.resolveRequired({
            scope: "task",
            scopeId: "task-duplicate-descriptor",
            capabilityIds: [capabilityId],
          }),
        );

        expect(listError).toMatchObject({
          _tag: "CapabilityRegistryUnavailableError",
          reason: `duplicate_capability_descriptor:${capabilityId}`,
        });
        expect(resolveError).toEqual(listError);
      }
    }),
  );

  it.effect("每次解析只保证当次 descriptor 快照，动态 MCP capability 移除后再次解析失败", () =>
    Effect.gen(function* () {
      const capability = makeMcpCapability("t3.mcp.dynamic_tool");
      let descriptors: ReadonlyArray<CompositionCapabilityDescriptor> = [capability];
      let listCalls = 0;
      const registry = CapabilityRegistry.makeCompositionCapabilityRegistry({
        mcpToolRegistry: {
          listCapabilityDescriptors: () =>
            Effect.sync(() => {
              listCalls += 1;
              return descriptors;
            }),
        },
      });
      const input = {
        scope: "task" as const,
        scopeId: "task-dynamic",
        capabilityIds: [capability.capabilityId],
      };

      const firstSnapshot = yield* registry.resolveRequired(input);
      descriptors = [];
      const error = yield* Effect.flip(registry.resolveRequired(input));

      expect(firstSnapshot).toEqual([capability]);
      expect(error).toMatchObject({
        _tag: "CapabilityNotAvailableError",
        capabilityId: capability.capabilityId,
        reason: "missing",
      });
      expect(listCalls).toBe(2);
    }),
  );
});
