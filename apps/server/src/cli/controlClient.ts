import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  bootstrapRemoteBearerSession,
  resolveRemoteWebSocketConnectionUrl,
} from "@codework/client-runtime/authorization";
import {
  type ConnectionAttemptError,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@codework/client-runtime/connection";
import { fetchRemoteEnvironmentDescriptor } from "@codework/client-runtime/environment";
import {
  rpcSessionLayer,
  type RemoteEnvironmentRequestError,
  remoteHttpClientLayer,
  type RpcSession,
  RpcSessionFactory,
} from "@codework/client-runtime/rpc";
import { AuthStandardClientScopes } from "@codework/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Socket from "effect/unstable/socket/Socket";

export interface ControlConnectionOptions {
  readonly serverUrl: string;
  readonly accessToken?: string;
}

export interface ParsedControlServerUrl {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly pairingCredential?: string;
}

export type ControlRpcClient = RpcSession["client"];

export class ControlServerUrlError extends Data.TaggedError("ControlServerUrlError")<{
  readonly message: string;
}> {}

export class ControlAuthenticationRequiredError extends Data.TaggedError(
  "ControlAuthenticationRequiredError",
)<{
  readonly message: string;
}> {}

export type ControlClientError =
  | ControlServerUrlError
  | ControlAuthenticationRequiredError
  | RemoteEnvironmentRequestError
  | ConnectionAttemptError;

export interface ControlClientOpen {
  <A, E, R>(
    connection: ControlConnectionOptions,
    use: (client: ControlRpcClient) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ControlClientError, R>;
}

const CONTROL_CLIENT_METADATA = {
  label: "Code Work CLI",
  deviceType: "bot",
} as const;

const normalizeBaseUrl = (url: URL, protocol: "http:" | "https:" | "ws:" | "wss:") => {
  const normalized = new URL(url.origin);
  normalized.protocol = protocol;
  return normalized.toString();
};

export function parseControlServerUrl(serverUrl: string): ParsedControlServerUrl {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new ControlServerUrlError({ message: "Control server URL is invalid." });
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw new ControlServerUrlError({
      message: "Control server URL must use HTTP or WebSocket.",
    });
  }

  const pairingCredential =
    url.hash.startsWith("#token=") && url.hash.length > "#token=".length
      ? decodeURIComponent(url.hash.slice("#token=".length))
      : undefined;
  url.hash = "";

  const secure = url.protocol === "https:" || url.protocol === "wss:";
  return {
    httpBaseUrl: normalizeBaseUrl(url, secure ? "https:" : "http:"),
    wsBaseUrl: normalizeBaseUrl(url, secure ? "wss:" : "ws:"),
    ...(pairingCredential ? { pairingCredential } : {}),
  };
}

const nodeWebSocketConstructorLayer = Layer.succeed(
  Socket.WebSocketConstructor,
  (url, protocols) =>
    new NodeSocket.NodeWS.WebSocket(url, protocols) as unknown as globalThis.WebSocket,
);

const controlRpcSessionLayer = rpcSessionLayer.pipe(Layer.provide(nodeWebSocketConstructorLayer));
const controlClientLayer = Layer.merge(
  controlRpcSessionLayer,
  remoteHttpClientLayer(globalThis.fetch),
);

const directSocketUrl = (wsBaseUrl: string): string => {
  const url = new URL(wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/ws";
  }
  return url.toString();
};

const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.");

const prepareControlConnection = Effect.fn("cli.controlClient.prepare")(function* (
  options: ControlConnectionOptions,
) {
  const parsed = yield* Effect.try({
    try: () => parseControlServerUrl(options.serverUrl),
    catch: (error) =>
      error instanceof ControlServerUrlError
        ? error
        : new ControlServerUrlError({ message: "Control server URL is invalid." }),
  });
  const explicitAccessToken = options.accessToken?.trim();
  const bearerToken = explicitAccessToken
    ? explicitAccessToken
    : parsed.pairingCredential
      ? (yield* bootstrapRemoteBearerSession({
          httpBaseUrl: parsed.httpBaseUrl,
          credential: parsed.pairingCredential,
          scopes: AuthStandardClientScopes,
          clientMetadata: CONTROL_CLIENT_METADATA,
        })).access_token
      : undefined;
  if (bearerToken === undefined && !isLoopbackHostname(new URL(parsed.httpBaseUrl).hostname)) {
    return yield* new ControlAuthenticationRequiredError({
      message: "Remote control connections require a pairing link or bearer access token.",
    });
  }
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: parsed.httpBaseUrl,
  });
  const socketUrl = bearerToken
    ? yield* resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl: parsed.wsBaseUrl,
        httpBaseUrl: parsed.httpBaseUrl,
        bearerToken,
        clientMetadata: CONTROL_CLIENT_METADATA,
      })
    : directSocketUrl(parsed.wsBaseUrl);
  const target = new PrimaryConnectionTarget({
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    httpBaseUrl: parsed.httpBaseUrl,
    wsBaseUrl: parsed.wsBaseUrl,
  });

  return {
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    httpBaseUrl: parsed.httpBaseUrl,
    socketUrl,
    httpAuthorization: bearerToken ? { _tag: "Bearer", token: bearerToken } : null,
    target,
  } satisfies PreparedConnection;
});

export const openControlClient: ControlClientOpen = (options, use) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sessions = yield* RpcSessionFactory;
      const connection = yield* prepareControlConnection(options);
      const session = yield* sessions.connect(connection);
      yield* session.ready;
      return yield* use(session.client);
    }),
  ).pipe(Effect.provide(controlClientLayer));
