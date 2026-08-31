import { ThreadId } from "@codework/contracts";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect } from "vite-plus/test";

import {
  disposeDeletedThreadTerminals,
  logCleanupCauseUnlessInterrupted,
} from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it.effect("swallows ordinary cleanup failures", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        logCleanupCauseUnlessInterrupted({
          effect: Effect.fail("cleanup failed"),
          message: "thread deletion cleanup skipped provider session stop",
          threadId,
        }),
      );

      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  );

  it.effect("preserves interrupt causes", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        logCleanupCauseUnlessInterrupted({
          effect: Effect.interrupt,
          message: "thread deletion cleanup skipped provider session stop",
          threadId,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      }
    }),
  );
});

describe("disposeDeletedThreadTerminals", () => {
  it.effect("线程删除使用 owner-aware disposeThread 并请求删除历史", () =>
    Effect.gen(function* () {
      const calls: Array<{ threadId: string; deleteHistory?: boolean }> = [];
      const threadId = ThreadId.make("thread-deletion-owned-terminals");

      yield* disposeDeletedThreadTerminals(
        {
          disposeThread: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return [];
            }),
        },
        threadId,
      );

      expect(calls).toEqual([{ threadId, deleteHistory: true }]);
    }),
  );
});
