import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type CompositionTaskRecoveryInput = {
  readonly taskId: string;
  /** Loop 在父 Task 尚未落库时重启恢复所需的执行者身份。 */
  readonly agentId?: string;
  readonly prompt: string;
  /** 工作流自动唤醒下一阶段时复用的稳定提示摘要。 */
  readonly promptDigest?: string;
  readonly workspaceRoot: string;
  readonly workspaceRootDigest?: string;
  readonly model?: string;
  /** 缺失表示旧版密文无法证明原始 capability 身份；空数组表示已知无需 capability。 */
  readonly capabilityIds?: ReadonlyArray<string>;
  /** 工作流阶段自动派发 verify 所需的独立执行者身份；普通 Composition 输入不设置。 */
  readonly implementationAssigneeId?: string;
  readonly independentVerifierId?: string;
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
>()("codework/persistence/Services/CompositionTaskInputStore") {}
