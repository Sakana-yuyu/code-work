import type {
  CompositionCapabilityDescriptor,
  CompositionCapabilityDescriptorList,
} from "@codework/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { listCompositionToolDescriptors } from "./CompositionToolRegistry.ts";
import * as CompositionMcpToolRegistry from "./CompositionMcpToolRegistry.ts";

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

export class CapabilityNotAvailableError extends Schema.TaggedErrorClass<CapabilityNotAvailableError>()(
  "CapabilityNotAvailableError",
  {
    scope: Schema.String,
    scopeId: Schema.String,
    capabilityId: Schema.String,
    reason: Schema.Literals(["input_invalid", "duplicate", "missing", "unavailable"]),
  },
) {
  override get message(): string {
    return `Capability '${this.capabilityId}' 在 '${this.scope}:${this.scopeId}' 中不可用：${this.reason}`;
  }
}

export type CapabilityRegistryRequiredInput = CapabilityRegistryScope & {
  readonly capabilityIds: ReadonlyArray<string>;
};

export class CapabilityRegistry extends Context.Service<
  CapabilityRegistry,
  {
    readonly list: (
      input: CapabilityRegistryScope,
    ) => Effect.Effect<
      CompositionCapabilityDescriptorList,
      CapabilityScopeNotFoundError | CapabilityRegistryUnavailableError
    >;
    /** 单次读取同一 scope 的 descriptor 快照，并按输入顺序验证必需 capability。 */
    readonly resolveRequired: (
      input: CapabilityRegistryRequiredInput,
    ) => Effect.Effect<
      ReadonlyArray<CompositionCapabilityDescriptor>,
      | CapabilityScopeNotFoundError
      | CapabilityRegistryUnavailableError
      | CapabilityNotAvailableError
    >;
  }
>()("codework/composition/CapabilityRegistry") {}

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
  readonly mcpToolRegistry?: {
    readonly listCapabilityDescriptors: () => Effect.Effect<
      ReadonlyArray<CompositionCapabilityDescriptor>,
      CapabilityRegistryUnavailableError
    >;
  };
};

export const makeCompositionCapabilityRegistry = (
  options: CompositionCapabilityRegistryOptions = {},
): CapabilityRegistry["Service"] => {
  const list: CapabilityRegistry["Service"]["list"] = Effect.fn("CapabilityRegistry.list")(
    function* (input) {
      if (input.scopeId.trim().length === 0) {
        return yield* new CapabilityScopeNotFoundError(input);
      }
      const mcpCapabilities = options.mcpToolRegistry
        ? yield* options.mcpToolRegistry.listCapabilityDescriptors()
        : [];
      const merged = [...capabilities, ...mcpCapabilities];
      const seen = new Set<string>();
      for (const capability of merged) {
        if (seen.has(capability.capabilityId)) {
          return yield* new CapabilityRegistryUnavailableError({
            reason: `duplicate_capability_descriptor:${capability.capabilityId}`,
          });
        }
        seen.add(capability.capabilityId);
      }
      return merged.map((capability) => ({
        ...capability,
        grants: { ...capability.grants },
      }));
    },
  );

  const resolveRequired: CapabilityRegistry["Service"]["resolveRequired"] = Effect.fn(
    "CapabilityRegistry.resolveRequired",
  )(function* (input) {
    const normalized = input.capabilityIds.map((capabilityId) => capabilityId.trim());
    if (normalized.length === 0) {
      return yield* new CapabilityNotAvailableError({
        scope: input.scope,
        scopeId: input.scopeId,
        capabilityId: "",
        reason: "input_invalid",
      });
    }
    const invalid = normalized.find((capabilityId) => capabilityId.length === 0);
    if (invalid !== undefined) {
      return yield* new CapabilityNotAvailableError({
        scope: input.scope,
        scopeId: input.scopeId,
        capabilityId: invalid,
        reason: "input_invalid",
      });
    }
    const seen = new Set<string>();
    for (const capabilityId of normalized) {
      if (seen.has(capabilityId)) {
        return yield* new CapabilityNotAvailableError({
          scope: input.scope,
          scopeId: input.scopeId,
          capabilityId,
          reason: "duplicate",
        });
      }
      seen.add(capabilityId);
    }

    const descriptors = yield* list(input);
    const byId = new Map(descriptors.map((descriptor) => [descriptor.capabilityId, descriptor]));
    const required: CompositionCapabilityDescriptor[] = [];
    for (const capabilityId of normalized) {
      const descriptor = byId.get(capabilityId);
      if (descriptor === undefined) {
        return yield* new CapabilityNotAvailableError({
          scope: input.scope,
          scopeId: input.scopeId,
          capabilityId,
          reason: "missing",
        });
      }
      if (descriptor.status === "unavailable") {
        return yield* new CapabilityNotAvailableError({
          scope: input.scope,
          scopeId: input.scopeId,
          capabilityId,
          reason: "unavailable",
        });
      }
      required.push({ ...descriptor, grants: { ...descriptor.grants } });
    }
    return required;
  });

  return CapabilityRegistry.of({ list, resolveRequired });
};

const make = Effect.gen(function* () {
  const mcpToolRegistry = yield* Effect.serviceOption(
    CompositionMcpToolRegistry.CompositionMcpToolRegistry,
  );
  return makeCompositionCapabilityRegistry(
    mcpToolRegistry._tag === "Some" ? { mcpToolRegistry: mcpToolRegistry.value } : {},
  );
});

export const layer = Layer.effect(CapabilityRegistry, make);
