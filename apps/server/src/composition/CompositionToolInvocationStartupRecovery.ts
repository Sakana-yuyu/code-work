import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  CompositionToolInvocationStore,
  type CompositionToolInvocationRecoveryReceipt,
  type CompositionToolInvocationStoreShape,
} from "../persistence/Services/CompositionToolInvocationStore.ts";

export const TOOL_INVOCATION_RESTART_OUTCOME_CODE =
  "process_restarted_result_indeterminate" as const;

export class CompositionToolInvocationStartupRecoveryError extends Schema.TaggedErrorClass<CompositionToolInvocationStartupRecoveryError>()(
  "CompositionToolInvocationStartupRecoveryError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Tool Invocation 启动恢复失败。";
  }
}

export interface CompositionToolInvocationStartupRecoveryShape {
  readonly awaitRecovered: Effect.Effect<
    CompositionToolInvocationRecoveryReceipt,
    CompositionToolInvocationStartupRecoveryError
  >;
}

export const recoverCompositionToolInvocations = Effect.fn(
  "CompositionToolInvocationStartupRecovery.recover",
)(function* (store: CompositionToolInvocationStoreShape, recoveredAtUnixMs: number) {
  const receipt = yield* store
    .recoverExecutingInvocations({
      recoveredAtUnixMs,
      outcomeCode: TOOL_INVOCATION_RESTART_OUTCOME_CODE,
    })
    .pipe(Effect.mapError((cause) => new CompositionToolInvocationStartupRecoveryError({ cause })));
  if (receipt.recoveredCount > 0) {
    yield* Effect.logWarning("已将重启前未确认的工具调用收口为 unknown", {
      recovered: receipt.recoveredCount,
    });
  }
  return receipt;
});

export class CompositionToolInvocationStartupRecovery extends Context.Service<
  CompositionToolInvocationStartupRecovery,
  CompositionToolInvocationStartupRecoveryShape
>()("codework/composition/CompositionToolInvocationStartupRecovery") {
  static readonly layer = Layer.effect(
    CompositionToolInvocationStartupRecovery,
    Effect.gen(function* () {
      const store = yield* CompositionToolInvocationStore;
      const recoveredAtUnixMs = yield* Clock.currentTimeMillis;
      const recoveryResult = yield* Effect.result(
        recoverCompositionToolInvocations(store, recoveredAtUnixMs),
      );
      return CompositionToolInvocationStartupRecovery.of({
        awaitRecovered: Effect.fromResult(recoveryResult),
      });
    }),
  );
}
