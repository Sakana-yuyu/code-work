import { ThreadId } from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import { ThreadVisibility, ThreadVisibilityLive } from "./ThreadVisibility.ts";

it.effect("counts overlapping leases and clears visibility when the last one closes", () =>
  Effect.gen(function* () {
    const visibility = yield* ThreadVisibility;
    const threadId = ThreadId.make("thread-visibility-overlap");

    const firstScope = yield* Scope.make("sequential");
    const secondScope = yield* Scope.make("sequential");
    yield* visibility.trackViewing(threadId).pipe(Scope.provide(firstScope));
    yield* visibility.trackViewing(threadId).pipe(Scope.provide(secondScope));

    assert.equal(yield* visibility.isVisible(threadId), true);

    yield* Scope.close(firstScope, Exit.void);
    assert.equal(yield* visibility.isVisible(threadId), true);

    yield* Scope.close(secondScope, Exit.void);
    assert.equal(yield* visibility.isVisible(threadId), false);
    assert.deepEqual(Array.from(yield* visibility.listVisibleThreadIds()), []);
  }).pipe(Effect.provide(ThreadVisibilityLive)),
);

it.effect("does not leak entries across unrelated threads", () =>
  Effect.gen(function* () {
    const visibility = yield* ThreadVisibility;
    const viewed = ThreadId.make("thread-visibility-viewed");
    const other = ThreadId.make("thread-visibility-other");

    const scope = yield* Scope.make("sequential");
    yield* visibility.trackViewing(viewed).pipe(Scope.provide(scope));

    assert.equal(yield* visibility.isVisible(viewed), true);
    assert.equal(yield* visibility.isVisible(other), false);
    assert.deepEqual(Array.from(yield* visibility.listVisibleThreadIds()), [viewed]);
  }).pipe(Effect.provide(ThreadVisibilityLive)),
);
