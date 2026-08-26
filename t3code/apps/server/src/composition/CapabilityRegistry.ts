import type {
  CompositionCapabilityDescriptor,
  CompositionCapabilityDescriptorList,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { listCompositionToolDescriptors } from "./CompositionToolRegistry.ts";
import type * as CompositionMcpToolRegistry from "./CompositionMcpToolRegistry.ts";

export const CapabilityRegistryScope = Schema.Struct({
  scope: Schema.Literals(["workspace", "agent", "task"]),
  scopeId: Schema.String,
});
export type CapabilityRegistryScope = typeof CapabilityRegistryScope.Type;

export class CapabilityScopeNotFoundError extends Schema.TaggedErrorClass<CapabilityScopeNotFoundError>()(
  "CapabilityScopeNotFoundError",
  {
    scope: Schema.String,
    scopeId: Schema.String,
  },
) {
  override get message(): string {
    return `Capability scope '${this.scope}:${this.scopeId}' was not found.`;
  }
}

export class CapabilityRegistryUnavailableError extends Schema.TaggedErrorClass<CapabilityRegistryUnavailableError>()(
  "CapabilityRegistryUnavailableError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Capability registry is unavailable: ${this.reason}`;
  }
}

export class CapabilityRegistry extends Context.Service<
  CapabilityRegistry,
  {
    readonly list: (
      input: CapabilityRegistryScope,
    ) => Effect.Effect<
      CompositionCapabilityDescriptorList,
      CapabilityScopeNotFoundError | CapabilityRegistryUnavailableError
    >;
  }
>()("t3/composition/CapabilityRegistry") {}

const capabilities: CompositionCapabilityDescriptorList = [
  ...listCompositionToolDescriptors(),
  {
    capabilityId: "t3.mcp.preview",
    kind: "mcp",
    version: "1",
    status: "degraded",
    grants: { read: true, execute: true, mutate: false },
    approval: "on_first_use",
    source: "t3",
  },
  {
    capabilityId: "t3.runtime.provider",
    kind: "runtime",
    version: "1",
    status: "degraded",
    grants: { read: true, execute: true, mutate: false },
    approval: "never",
    source: "runtime",
  },
];

export type CompositionCapabilityRegistryOptions = {
  readonly mcpToolRegistry?: Pick<
    CompositionMcpToolRegistry.CompositionMcpToolRegistryShape,
    "listCapabilityDescriptors"
  >;
};

export const makeCompositionCapabilityRegistry = (
  options: CompositionCapabilityRegistryOptions = {},
): CapabilityRegistry["Service"] =>
  CapabilityRegistry.of({
    list: Effect.fn("CapabilityRegistry.list")(function* (input) {
      if (input.scopeId.trim().length === 0) {
        return yield* new CapabilityScopeNotFoundError(input);
      }
      const mcpCapabilities = options.mcpToolRegistry
        ? yield* options.mcpToolRegistry.listCapabilityDescriptors()
        : [];
      return [...capabilities, ...mcpCapabilities].map((capability) => ({
        ...capability,
        grants: { ...capability.grants },
      }));
    }),
  });

const make = Effect.gen(function* () {
  const mcpToolRegistry = yield* Effect.serviceOption(
    CompositionMcpToolRegistry.CompositionMcpToolRegistry,
  );
  return makeCompositionCapabilityRegistry({
    ...(mcpToolRegistry._tag === "Some" ? { mcpToolRegistry: mcpToolRegistry.value } : {}),
  });
});

export const layer = Layer.effect(CapabilityRegistry, make);
