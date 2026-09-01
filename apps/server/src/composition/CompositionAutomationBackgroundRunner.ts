import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type CompositionAutomationBackgroundStatus = "started" | "active";

export interface CompositionAutomationBackgroundRunnerShape {
  readonly ensure: (
    automationRunId: string,
    work: Effect.Effect<void, never>,
  ) => Effect.Effect<CompositionAutomationBackgroundStatus>;
}

export class CompositionAutomationBackgroundRunner extends Context.Service<
  CompositionAutomationBackgroundRunner,
  CompositionAutomationBackgroundRunnerShape
>()("codework/composition/CompositionAutomationBackgroundRunner") {}

export interface CompositionAutomationBackgroundRunnerOptions {
  readonly launch: (work: Effect.Effect<void, never>) => Effect.Effect<void>;
}

export const makeCompositionAutomationBackgroundRunner = (
  options: CompositionAutomationBackgroundRunnerOptions,
): CompositionAutomationBackgroundRunnerShape => {
  const activeRunIds = new Set<string>();

  const ensure: CompositionAutomationBackgroundRunnerShape["ensure"] = (automationRunId, work) =>
    Effect.suspend(() => {
      if (activeRunIds.has(automationRunId)) return Effect.succeed("active" as const);
      activeRunIds.add(automationRunId);
      return options
        .launch(
          work.pipe(Effect.ensuring(Effect.sync(() => void activeRunIds.delete(automationRunId)))),
        )
        .pipe(Effect.as("started" as const));
    });

  return { ensure };
};

const live = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  return makeCompositionAutomationBackgroundRunner({
    launch: (work) => Effect.forkIn(work, scope).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(CompositionAutomationBackgroundRunner, live);
