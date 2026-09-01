import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import { makeCompositionAutomationBackgroundRunner } from "./CompositionAutomationBackgroundRunner.ts";

describe("CompositionAutomationBackgroundRunner", () => {
  it.effect("后台任务非阻塞启动、同一 Run 去重并在结束后释放身份", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      let launches = 0;
      const runner = makeCompositionAutomationBackgroundRunner({
        launch: (effect) =>
          Effect.gen(function* () {
            launches += 1;
            yield* Effect.forkIn(
              effect.pipe(Effect.ensuring(Deferred.succeed(settled, undefined))),
              scope,
            );
          }),
      });
      const work = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );

      assert.equal(yield* runner.ensure("automation-run-1", work), "started");
      yield* Deferred.await(started);
      assert.equal(yield* runner.ensure("automation-run-1", work), "active");
      assert.equal(launches, 1);

      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(settled);
      assert.equal(yield* runner.ensure("automation-run-1", Effect.void), "started");
      assert.equal(launches, 2);

      yield* Scope.close(scope, Exit.void);
    }),
  );
});
