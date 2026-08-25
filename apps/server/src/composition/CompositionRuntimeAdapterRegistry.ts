import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { CompositionRuntimeAdapter } from "./CompositionRuntimeAdapter.ts";

export class CompositionRuntimeAdapterAlreadyRegisteredError extends Schema.TaggedErrorClass<CompositionRuntimeAdapterAlreadyRegisteredError>()(
  "CompositionRuntimeAdapterAlreadyRegisteredError",
  { runtimeId: Schema.String },
) {
  override get message(): string {
    return `Runtime Adapter '${this.runtimeId}' 已注册，拒绝覆盖现有适配器。`;
  }
}

export class CompositionRuntimeAdapterInvalidError extends Schema.TaggedErrorClass<CompositionRuntimeAdapterInvalidError>()(
  "CompositionRuntimeAdapterInvalidError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Runtime Adapter 注册无效：${this.detail}`;
  }
}

export interface CompositionRuntimeAdapterRegistry {
  readonly register: (
    adapter: CompositionRuntimeAdapter,
  ) => Effect.Effect<
    void,
    CompositionRuntimeAdapterAlreadyRegisteredError | CompositionRuntimeAdapterInvalidError
  >;
  readonly unregister: (runtimeId: string) => Effect.Effect<boolean>;
  readonly get: (runtimeId: string) => Effect.Effect<CompositionRuntimeAdapter | undefined>;
  readonly list: Effect.Effect<ReadonlyArray<CompositionRuntimeAdapter>>;
}

export const makeCompositionRuntimeAdapterRegistry = (): CompositionRuntimeAdapterRegistry => {
  const adapters = new Map<string, CompositionRuntimeAdapter>();

  const register: CompositionRuntimeAdapterRegistry["register"] = Effect.fn(
    "CompositionRuntimeAdapterRegistry.register",
  )(function* (adapter) {
    const runtimeId = adapter.runtimeId.trim();
    if (runtimeId.length === 0) {
      return yield* new CompositionRuntimeAdapterInvalidError({ detail: "runtimeId 不能为空。" });
    }
    if (runtimeId !== adapter.runtimeId) {
      return yield* new CompositionRuntimeAdapterInvalidError({
        detail: "runtimeId 必须已去除首尾空白。",
      });
    }
    if (adapters.has(runtimeId)) {
      return yield* new CompositionRuntimeAdapterAlreadyRegisteredError({ runtimeId });
    }
    adapters.set(runtimeId, adapter);
  });

  return {
    register,
    unregister: (runtimeId) => Effect.sync(() => adapters.delete(runtimeId)),
    get: (runtimeId) => Effect.sync(() => adapters.get(runtimeId)),
    get list() {
      return Effect.sync(() => Array.from(adapters.values()));
    },
  };
};
