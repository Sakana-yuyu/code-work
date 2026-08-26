import {
  AuthOrchestrationOperateScope,
  CompositionRuntimeToolCancellation,
  CompositionRuntimeToolInvocation,
  EnvironmentInternalError,
  EnvironmentScopeRequiredError,
  EnvironmentAuthInvalidError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import * as CompositionRuntimeToolBridge from "./CompositionRuntimeToolBridge.ts";

export const COMPOSITION_RUNTIME_TOOL_INVOKE_PATH = "/api/composition/runtime/tools/invoke";
export const COMPOSITION_RUNTIME_TOOL_CANCEL_PATH = "/api/composition/runtime/tools/cancel";
export const COMPOSITION_RUNTIME_TOOL_BRIDGE_PROTOCOL = "t3-composition-runtime/1" as const;

class CompositionRuntimeToolBridgeHttpError extends Schema.TaggedErrorClass<CompositionRuntimeToolBridgeHttpError>()(
  "CompositionRuntimeToolBridgeHttpError",
  { code: Schema.String },
) {}

const authenticateRawRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, () =>
      failEnvironmentInternal("internal_error"),
    ),
  );
  if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
    return yield* failEnvironmentScopeRequired(AuthOrchestrationOperateScope);
  }
  return session;
});

const decodeBody = <S extends Schema.Constraint>(schema: S) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(
      Effect.mapError(() => new CompositionRuntimeToolBridgeHttpError({ code: "invalid_request" })),
    );
    return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError(() => new CompositionRuntimeToolBridgeHttpError({ code: "invalid_request" })),
    );
  });

const validateBridgeHeaders = (idempotencyKey: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers["x-t3-composition-protocol"] !== COMPOSITION_RUNTIME_TOOL_BRIDGE_PROTOCOL) {
      return yield* new CompositionRuntimeToolBridgeHttpError({ code: "invalid_protocol" });
    }
    if (request.headers["idempotency-key"] !== idempotencyKey) {
      return yield* new CompositionRuntimeToolBridgeHttpError({ code: "idempotency_mismatch" });
    }
  });

const json = (body: unknown) =>
  HttpServerResponse.jsonUnsafe(body, {
    headers: { "cache-control": "no-store" },
  });

const routeErrorResponse = (error: CompositionRuntimeToolBridgeHttpError) =>
  Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error.code }, { status: 400 }));

const failureTag = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null && "_tag" in cause) {
    const tag = (cause as { readonly _tag?: unknown })._tag;
    if (typeof tag === "string" && tag.length > 0) return tag;
  }
  return "unexpected_failure";
};

const unexpectedRouteFailure = (route: string, cause: unknown) =>
  Effect.logWarning("Composition Runtime Tool Bridge 路由失败。", {
    route,
    errorTag: failureTag(cause),
  }).pipe(
    Effect.as(
      HttpServerResponse.jsonUnsafe(
        { error: "internal_error", errorTag: failureTag(cause) },
        { status: 500, headers: { "cache-control": "no-store" } },
      ),
    ),
  );

const invokeRoute = Effect.gen(function* () {
  yield* annotateEnvironmentRequest("composition.runtime.tools.invoke");
  yield* authenticateRawRoute;
  const input = yield* decodeBody(CompositionRuntimeToolInvocation);
  yield* validateBridgeHeaders(input.idempotencyKey);
  const bridge = yield* CompositionRuntimeToolBridge.CompositionRuntimeToolBridgeService;
  return json(yield* bridge.invoke(input));
}).pipe(
  Effect.catchTag("CompositionRuntimeToolBridgeHttpError", routeErrorResponse),
  Effect.catchTags({
    EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
    EnvironmentInternalError: HttpServerRespondable.toResponse,
    EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
  }),
  Effect.catchCause((cause) => unexpectedRouteFailure("invoke", cause)),
);

const cancelRoute = Effect.gen(function* () {
  yield* annotateEnvironmentRequest("composition.runtime.tools.cancel");
  yield* authenticateRawRoute;
  const input = yield* decodeBody(CompositionRuntimeToolCancellation);
  yield* validateBridgeHeaders(input.idempotencyKey);
  const bridge = yield* CompositionRuntimeToolBridge.CompositionRuntimeToolBridgeService;
  return json(yield* bridge.cancel(input));
}).pipe(
  Effect.catchTag("CompositionRuntimeToolBridgeHttpError", routeErrorResponse),
  Effect.catchTags({
    EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
    EnvironmentInternalError: HttpServerRespondable.toResponse,
    EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
  }),
  Effect.catchCause((cause) => unexpectedRouteFailure("cancel", cause)),
);

export const routeLayer = Layer.mergeAll(
  HttpRouter.add("POST", COMPOSITION_RUNTIME_TOOL_INVOKE_PATH, invokeRoute),
  HttpRouter.add("POST", COMPOSITION_RUNTIME_TOOL_CANCEL_PATH, cancelRoute),
);

export const makeRouteLayer = <E, R>(
  dependencies: Layer.Layer<
    | CompositionRuntimeToolBridge.CompositionRuntimeToolBridgeService
    | EnvironmentAuth.EnvironmentAuth,
    E,
    R
  >,
) => routeLayer.pipe(HttpRouter.provideRequest(dependencies));
