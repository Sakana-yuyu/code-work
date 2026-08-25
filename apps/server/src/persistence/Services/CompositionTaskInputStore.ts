import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type CompositionTaskRecoveryInput = {
  readonly taskId: string;
  readonly prompt: string;
  readonly workspaceRoot: string;
  readonly workspaceRootDigest?: string;
  readonly model?: string;
};

export class CompositionTaskInputStoreError extends Schema.TaggedErrorClass<CompositionTaskInputStoreError>()(
  "CompositionTaskInputStoreError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Composition Task 输入持久化失败：${this.operation}：${this.detail}`;
  }
}

export interface CompositionTaskInputStoreShape {
  readonly save: (
    input: CompositionTaskRecoveryInput,
  ) => Effect.Effect<void, CompositionTaskInputStoreError>;
  readonly get: (
    taskId: string,
  ) => Effect.Effect<Option.Option<CompositionTaskRecoveryInput>, CompositionTaskInputStoreError>;
  readonly remove: (taskId: string) => Effect.Effect<void, CompositionTaskInputStoreError>;
}

export class CompositionTaskInputStore extends Context.Service<
  CompositionTaskInputStore,
  CompositionTaskInputStoreShape
>()("t3/persistence/Services/CompositionTaskInputStore") {}
