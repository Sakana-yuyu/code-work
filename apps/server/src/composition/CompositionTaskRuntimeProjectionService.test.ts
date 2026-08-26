import { describe, expect, it } from "vite-plus/test";
import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  makeInMemoryCompositionRuntimeAdapter,
  type CompositionRuntimeAdapter,
} from "./CompositionRuntimeAdapter.ts";
import { makeCompositionRuntimeAdapterRegistry } from "./CompositionRuntimeAdapterRegistry.ts";
import { superviseCompositionRuntimeEventStreams } from "./CompositionTaskRuntimeProjectionService.ts";

const event: ProviderRuntimeEvent = {
  eventId: EventId.make("runtime-stream-test-event"),
  provider: ProviderDriverKind.make("multica"),
  threadId: ThreadId.make("runtime-stream-test"),
  createdAt: "2026-08-26T00:00:00.000Z",
  type: "runtime.warning",
  payload: { message: "测试事件" },
};

describe("CompositionTaskRuntimeProjectionService Runtime 事件流监督", () => {
  it("Runtime Adapter 热替换时中断旧流并启动新流", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registry = makeCompositionRuntimeAdapterRegistry();
          const firstStarted = yield* Deferred.make<void>();
          const secondStarted = yield* Deferred.make<void>();
          const interrupted: string[] = [];

          const firstBase = makeInMemoryCompositionRuntimeAdapter({ runtimeId: "runtime-reload" });
          const first: CompositionRuntimeAdapter = {
            ...firstBase,
            streamEvents: () =>
              Stream.concat(
                Stream.fromEffect(Deferred.succeed(firstStarted, undefined).pipe(Effect.as(event))),
                Stream.never,
              ).pipe(Stream.ensuring(Effect.sync(() => interrupted.push("first")))),
          };
          const secondBase = makeInMemoryCompositionRuntimeAdapter({ runtimeId: "runtime-reload" });
          const second: CompositionRuntimeAdapter = {
            ...secondBase,
            streamEvents: () =>
              Stream.concat(
                Stream.fromEffect(
                  Deferred.succeed(secondStarted, undefined).pipe(Effect.as(event)),
                ),
                Stream.never,
              ).pipe(Stream.ensuring(Effect.sync(() => interrupted.push("second")))),
          };

          yield* registry.register(first);
          yield* superviseCompositionRuntimeEventStreams({
            adapterRegistry: registry,
            projectRuntimeEvent: () => Effect.void,
          });
          yield* Deferred.await(firstStarted);

          yield* registry.unregister("runtime-reload");
          yield* registry.register(second);
          yield* Deferred.await(secondStarted);

          expect(interrupted).toEqual(["first"]);
        }),
      ),
    );
  });
});
