import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { CompositionAgentDriverProfile, ProviderRuntimeEvent } from "@codework/contracts";

import type { CompositionAgentDriver } from "./CompositionOrchestrator.ts";

export class CompositionAgentDriverAlreadyRegisteredError extends Schema.TaggedErrorClass<CompositionAgentDriverAlreadyRegisteredError>()(
  "CompositionAgentDriverAlreadyRegisteredError",
  { agentId: Schema.String },
) {
  override get message(): string {
    return `Agent Driver '${this.agentId}' 已注册，拒绝覆盖现有驱动。`;
  }
}

export class CompositionAgentDriverInvalidError extends Schema.TaggedErrorClass<CompositionAgentDriverInvalidError>()(
  "CompositionAgentDriverInvalidError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Agent Driver 注册无效：${this.detail}`;
  }
}

export interface CompositionAgentDriverRegistry {
  readonly register: (
    driver: CompositionAgentDriver,
  ) => Effect.Effect<
    void,
    CompositionAgentDriverAlreadyRegisteredError | CompositionAgentDriverInvalidError
  >;
  readonly unregister: (agentId: string) => Effect.Effect<boolean>;
  readonly get: (agentId: string) => Effect.Effect<CompositionAgentDriver | undefined>;
  readonly list: Effect.Effect<ReadonlyArray<CompositionAgentDriver>>;
  readonly listProfiles: Effect.Effect<ReadonlyArray<CompositionAgentDriverProfile>>;
  readonly subscribeChanges: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
  readonly resolveRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<
    | {
        readonly driver: CompositionAgentDriver;
        readonly taskId: string;
        readonly runId: string;
        readonly runtimeTaskId?: string;
      }
    | undefined
  >;
}

export interface CompositionAgentDriverRegistryServiceShape extends CompositionAgentDriverRegistry {}

export class CompositionAgentDriverRegistryService extends Context.Service<
  CompositionAgentDriverRegistryService,
  CompositionAgentDriverRegistryServiceShape
>()("codework/composition/CompositionAgentDriverRegistry/CompositionAgentDriverRegistryService") {}

export const makeCompositionAgentDriverRegistry = (): CompositionAgentDriverRegistry => {
  const drivers = new Map<string, CompositionAgentDriver>();
  const changes = Effect.runSync(PubSub.unbounded<void>());

  const missingProfile = (driver: CompositionAgentDriver): CompositionAgentDriverProfile => ({
    schemaVersion: 1,
    agentId: driver.agentId,
    runtimeId: driver.runtimeId,
    driverKind: "unknown",
    status: "degraded",
    capabilities: [],
    supportsToolBroker: false,
    supportsCapabilityHandshake: false,
    supportsWorkspace: false,
    supportsTerminal: false,
    supportsGit: false,
    supportsMcp: false,
    supportsBrowser: false,
    supportsIde: false,
    supportsProviderApi: false,
    supportsResume: false,
    supportsSquad: false,
    supportsLeader: false,
    supportsTaskGraph: false,
    reasonCode: "driver_profile_missing",
  });

  const register: CompositionAgentDriverRegistry["register"] = Effect.fn(
    "CompositionAgentDriverRegistry.register",
  )(function* (driver) {
    const agentId = driver.agentId.trim();
    if (agentId.length === 0) {
      return yield* new CompositionAgentDriverInvalidError({ detail: "agentId 不能为空。" });
    }
    if (agentId !== driver.agentId) {
      return yield* new CompositionAgentDriverInvalidError({
        detail: "agentId 必须已去除首尾空白。",
      });
    }
    if (drivers.has(agentId)) {
      return yield* new CompositionAgentDriverAlreadyRegisteredError({ agentId });
    }
    drivers.set(agentId, driver);
    yield* PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  });

  return {
    register,
    unregister: (agentId) =>
      Effect.gen(function* () {
        const deleted = drivers.delete(agentId);
        if (deleted) {
          yield* PubSub.publish(changes, undefined).pipe(Effect.asVoid);
        }
        return deleted;
      }),
    get: (agentId) => Effect.sync(() => drivers.get(agentId)),
    get list() {
      return Effect.sync(() => Array.from(drivers.values()));
    },
    get listProfiles() {
      return Effect.forEach(Array.from(drivers.values()), (driver) =>
        driver.getProfile === undefined
          ? Effect.succeed(missingProfile(driver))
          : driver.getProfile(),
      );
    },
    subscribeChanges: PubSub.subscribe(changes),
    resolveRuntimeEvent: (event) =>
      Effect.sync(() => {
        for (const driver of drivers.values()) {
          const binding = driver.resolveRuntimeEvent?.(event);
          if (binding !== undefined) return { driver, ...binding };
        }
        return undefined;
      }),
  };
};

export const layer = Layer.effect(
  CompositionAgentDriverRegistryService,
  Effect.sync(makeCompositionAgentDriverRegistry),
);
