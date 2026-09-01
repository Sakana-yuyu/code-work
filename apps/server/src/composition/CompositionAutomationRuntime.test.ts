import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeCompositionAutomationRuntime } from "./CompositionAutomationRuntime.ts";

describe("CompositionAutomationRuntime", () => {
  it.effect("启动时先恢复一次，并把周期 tick 放入受 Scope 管理的后台", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tickStarted = yield* Deferred.make<void>();
        const releaseTick = yield* Deferred.make<void>();
        const events: string[] = [];
        const runtime = makeCompositionAutomationRuntime({
          scheduler: {
            recover: () =>
              Effect.sync(() => void events.push("recover")).pipe(Effect.as({ outcomes: [] })),
            tick: () =>
              Effect.sync(() => void events.push("tick")).pipe(
                Effect.andThen(Deferred.succeed(tickStarted, undefined)),
                Effect.andThen(Deferred.await(releaseTick)),
                Effect.as({ outcomes: [] }),
              ),
          },
          runTicks: (tick) => tick,
        });

        yield* runtime.start;
        assert.deepEqual(events, ["recover"]);
        yield* Deferred.await(tickStarted);
        assert.deepEqual(events, ["recover", "tick"]);
        yield* Deferred.succeed(releaseTick, undefined);
      }),
    ),
  );
});
