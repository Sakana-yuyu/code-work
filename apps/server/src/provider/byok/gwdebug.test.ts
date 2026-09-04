import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpRouter } from "effect/unstable/http";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as ServerConfig from "../../config.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { byokGatewayRouteLayer } from "./modelGateway.ts";

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "codework-byok-gateway-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const secretLayer = ServerSecretStore.layer.pipe(
  Layer.provideMerge(configLayer),
  Layer.provideMerge(NodeCrypto.layer),
);

describe("gateway route registration", () => {
  it.effect("registers routes in the router", () =>
    byokGatewayRouteLayer.pipe(
      Layer.provideMerge(HttpRouter.layer),
      HttpRouter.provideRequest(secretLayer),
      HttpRouter.provideRequest(ServerSettingsService.layerTest()),
      HttpRouter.provideRequest(FetchHttpClient.layer),
      Layer.build,
      Effect.asVoid,
    ),
  );
});
