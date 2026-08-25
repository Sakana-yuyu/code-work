import type {
  CompositionCapabilityDescriptor,
  CompositionCapabilityDescriptorList,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

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
  {
    capabilityId: "t3.workspace.read_file",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: true, execute: false, mutate: false },
    approval: "never",
    source: "t3",
  },
  {
    capabilityId: "t3.workspace.write_file",
    kind: "tool",
    version: "1",
    status: "available",
    grants: { read: false, execute: false, mutate: true },
    approval: "every_use",
    source: "t3",
  },
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

export const makeCompositionCapabilityRegistry = (): CapabilityRegistry["Service"] =>
  CapabilityRegistry.of({
    list: Effect.fn("CapabilityRegistry.list")(function* (input) {
      if (input.scopeId.trim().length === 0) {
        return yield* new CapabilityScopeNotFoundError(input);
      }
      return capabilities.map((capability) => ({
        ...capability,
        grants: { ...capability.grants },
      }));
    }),
  });

const make = Effect.succeed(makeCompositionCapabilityRegistry());

export const layer = Layer.effect(CapabilityRegistry, make);
