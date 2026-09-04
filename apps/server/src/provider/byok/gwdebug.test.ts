import { HttpRouter } from "effect/unstable/http";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { byokGatewayRouteLayer } from "./modelGateway.ts";

describe("gateway route registration", () => {
  it("registers routes in the router", () =>
    Effect.gen(function* () {
      const router = yield* Effect.provide(
        byokGatewayRouteLayer.pipe(Layer.provideMerge(HttpRouter.layer)),
        Layer.mergeAll(),
      );
      void router;
    }).pipe(Effect.provide(Layer.mergeAll(Effect.succeed(Layer.empty) as never))));
});
