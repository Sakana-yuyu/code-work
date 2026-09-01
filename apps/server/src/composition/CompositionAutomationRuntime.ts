import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import {
  CompositionAutomationScheduler,
  type CompositionAutomationSchedulerShape,
} from "./CompositionAutomationScheduler.ts";

export interface CompositionAutomationRuntimeShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
}

export class CompositionAutomationRuntime extends Context.Service<
  CompositionAutomationRuntime,
  CompositionAutomationRuntimeShape
>()("codework/composition/CompositionAutomationRuntime") {}

export interface CompositionAutomationRuntimeOptions {
  readonly scheduler: Pick<CompositionAutomationSchedulerShape, "recover" | "tick">;
  readonly runTicks?: (tick: Effect.Effect<void, never>) => Effect.Effect<void, never>;
}

const ignoreSchedulerFailure = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`Automation Scheduler ${operation} 失败`, { cause }),
    ),
    Effect.asVoid,
  );

export const makeCompositionAutomationRuntime = (
  options: CompositionAutomationRuntimeOptions,
): CompositionAutomationRuntimeShape => {
  const runTicks =
    options.runTicks ??
    ((tick: Effect.Effect<void, never>) =>
      tick.pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.asVoid));
  const start = Effect.gen(function* () {
    yield* ignoreSchedulerFailure("恢复", options.scheduler.recover());
    const tick = ignoreSchedulerFailure("调度", options.scheduler.tick());
    yield* runTicks(tick).pipe(Effect.forkScoped, Effect.asVoid);
  });
  return { start };
};

const live = Effect.gen(function* () {
  const scheduler = yield* CompositionAutomationScheduler;
  return makeCompositionAutomationRuntime({ scheduler });
});

export const layer = Layer.effect(CompositionAutomationRuntime, live);
