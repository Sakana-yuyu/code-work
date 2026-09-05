import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeTimersPromises from "node:timers/promises";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";
import { resolveProductSchemes } from "@codework/shared/productIdentity";

export const DESKTOP_HOST = "app";
export const DESKTOP_PRODUCTION_SCHEME = "codework";
export const DESKTOP_DEVELOPMENT_SCHEME = "codework-dev";
export const DESKTOP_PREVIEW_SCHEME = "codework-preview";
// 去品牌前的历史 deep-link scheme；必须保留旧值，让既有安装的 t3code:// 链接
// 继续路由到本应用，且不能与 canonical scheme 同名（protocol.handle 不允许重复）。
export const DESKTOP_LEGACY_PRODUCTION_SCHEME = "t3code";
export const DESKTOP_LEGACY_DEVELOPMENT_SCHEME = "t3code-dev";
export const DESKTOP_LEGACY_PREVIEW_SCHEME = "t3code-preview";

export function getDesktopScheme(isDevelopment: boolean): string {
  return isDevelopment ? DESKTOP_DEVELOPMENT_SCHEME : DESKTOP_PRODUCTION_SCHEME;
}

export function getDesktopSchemes(isDevelopment: boolean): readonly string[] {
  return resolveProductSchemes(isDevelopment ? "development" : "production");
}

function getProtocolAliases(scheme: string): readonly string[] {
  switch (scheme) {
    case DESKTOP_DEVELOPMENT_SCHEME:
    case DESKTOP_LEGACY_DEVELOPMENT_SCHEME:
      return [DESKTOP_DEVELOPMENT_SCHEME, DESKTOP_LEGACY_DEVELOPMENT_SCHEME];
    case DESKTOP_PREVIEW_SCHEME:
    case DESKTOP_LEGACY_PREVIEW_SCHEME:
      return [DESKTOP_PREVIEW_SCHEME, DESKTOP_LEGACY_PREVIEW_SCHEME];
    case DESKTOP_PRODUCTION_SCHEME:
    case DESKTOP_LEGACY_PRODUCTION_SCHEME:
      return [DESKTOP_PRODUCTION_SCHEME, DESKTOP_LEGACY_PRODUCTION_SCHEME];
    default:
      return [scheme];
  }
}

export function getDesktopOrigin(isDevelopment: boolean): string {
  return `${getDesktopScheme(isDevelopment)}://${DESKTOP_HOST}`;
}

export function getDesktopUrl(isDevelopment: boolean): string {
  return `${getDesktopOrigin(isDevelopment)}/`;
}

export class ElectronProtocolRegistrationError extends Schema.TaggedErrorClass<ElectronProtocolRegistrationError>()(
  "ElectronProtocolRegistrationError",
  {
    scheme: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to register Electron protocol scheme "${this.scheme}".`;
  }
}

export class ElectronProtocolUnregistrationError extends Schema.TaggedErrorClass<ElectronProtocolUnregistrationError>()(
  "ElectronProtocolUnregistrationError",
  {
    scheme: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to unregister Electron protocol scheme "${this.scheme}".`;
  }
}

export interface DesktopProtocolRegistrationInput {
  readonly scheme: string;
  readonly targetOrigin: URL;
  readonly backendOrigin: URL;
  readonly clerkFrontendApiHostname: string | undefined;
}

export class ElectronProtocol extends Context.Service<
  ElectronProtocol,
  {
    readonly registerDesktopProtocol: (
      input: DesktopProtocolRegistrationInput,
    ) => Effect.Effect<void, ElectronProtocolRegistrationError, Scope.Scope>;
  }
>()("@codework/desktop/electron/ElectronProtocol") {}

export function makeDesktopContentSecurityPolicy(input: DesktopProtocolRegistrationInput): string {
  const clerkOrigin = input.clerkFrontendApiHostname
    ? `https://${input.clerkFrontendApiHostname}`
    : undefined;
  const scriptSources = [
    "'self'",
    "'unsafe-inline'",
    "'wasm-unsafe-eval'",
    ...(clerkOrigin ? [clerkOrigin] : []),
    "https://challenges.cloudflare.com",
  ];

  // The renderer connects directly to user-configured environments in addition to
  // the build-configured Clerk, relay, and OTLP endpoints. Those environment
  // origins are not known when this response policy is created, so restrict
  // connections by the network schemes the client supports instead of by host.
  const connectSources = ["'self'", "http:", "https:", "ws:", "wss:"];

  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    `connect-src ${connectSources.join(" ")}`,
    `img-src 'self' ${getProtocolAliases(input.scheme)
      .map((scheme) => `${scheme}:`)
      .join(" ")} blob: data: http: https:`,
    "style-src 'self' 'unsafe-inline'",
    `font-src 'self' ${getProtocolAliases(input.scheme)
      .map((scheme) => `${scheme}:`)
      .join(" ")} data:`,
    "worker-src 'self' blob:",
    // 背景视频仅使用本地导入的 Blob，不开放远程视频或脚本来源。
    "media-src 'self' blob:",
    "frame-src 'self' https://challenges.cloudflare.com",
    "form-action 'self'",
  ].join("; ");
}

function withContentSecurityPolicy(response: Response, policy: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", policy);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Must run synchronously during process bootstrap, before Electron emits `ready`.
 */
export function registerDesktopSchemePrivilegesSync(): void {
  Electron.protocol.registerSchemesAsPrivileged(
    [
      DESKTOP_PRODUCTION_SCHEME,
      DESKTOP_DEVELOPMENT_SCHEME,
      DESKTOP_PREVIEW_SCHEME,
      DESKTOP_LEGACY_PRODUCTION_SCHEME,
      DESKTOP_LEGACY_DEVELOPMENT_SCHEME,
      DESKTOP_LEGACY_PREVIEW_SCHEME,
    ].map((scheme) => ({
      scheme,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        // @clerk/electron 的 renderer 传输需要 stream 特权；它自己的注册在
        // app ready 后会被跳过（见 @clerk/electron 的 pnpm patch），所以这里
        // 必须一次性带上完整特权集。
        stream: true,
      },
    })),
  );
}

const registerDesktopSchemePrivileges = Effect.sync(registerDesktopSchemePrivilegesSync).pipe(
  Effect.withSpan("desktop.electron.protocol.registerSchemePrivileges"),
);

export const layerSchemePrivileges = Layer.effectDiscard(registerDesktopSchemePrivileges);

async function proxyRequest(
  request: Request,
  targetOrigin: URL,
  contentSecurityPolicy: string,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (requestUrl.host !== DESKTOP_HOST) {
    return new Response(null, { status: 404 });
  }

  const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, targetOrigin);
  const headers = new Headers(request.headers);
  const headersToRemove: string[] = [];
  for (const name of headers.keys()) {
    if (
      name === "host" ||
      name === "origin" ||
      name === "referer" ||
      name === "connection" ||
      name === "content-length" ||
      name === "accept-encoding" ||
      name === "upgrade-insecure-requests" ||
      name.startsWith("sec-fetch-")
    ) {
      headersToRemove.push(name);
    }
  }
  for (const name of headersToRemove) {
    headers.delete(name);
  }
  const init: RequestInit = {
    method: request.method,
    headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    (init as RequestInit & { duplex: "half" }).duplex = "half";
  }
  const response =
    request.method === "GET" || request.method === "HEAD"
      ? await fetchWithTransientRetry(targetUrl.toString(), init)
      : await Electron.net.fetch(targetUrl.toString(), init);
  return withContentSecurityPolicy(response, contentSecurityPolicy);
}

const TRANSIENT_FETCH_RETRY_DELAYS_MS = [0, 50, 150] as const;

async function fetchWithTransientRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;

  for (const delayMs of TRANSIENT_FETCH_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await NodeTimersPromises.setTimeout(delayMs);
    }

    try {
      return await Electron.net.fetch(url, init);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

export const make = Effect.gen(function* () {
  const registered = yield* Ref.make<readonly string[]>([]);

  const registerDesktopProtocol = Effect.fn("desktop.electron.protocol.registerDesktopProtocol")(
    function* (input: DesktopProtocolRegistrationInput) {
      if ((yield* Ref.get(registered)).length > 0) return;

      const contentSecurityPolicy = makeDesktopContentSecurityPolicy(input);
      const schemes = getProtocolAliases(input.scheme);
      const handler = (request: Request) =>
        proxyRequest(request, input.targetOrigin, contentSecurityPolicy);

      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            const handled: string[] = [];
            try {
              for (const scheme of schemes) {
                Electron.protocol.handle(scheme, handler);
                handled.push(scheme);
              }
            } catch (cause) {
              for (const scheme of handled) {
                try {
                  Electron.protocol.unhandle(scheme);
                } catch {
                  // Preserve the registration failure; cleanup is best effort.
                }
              }
              throw cause;
            }
          },
          catch: (cause) => new ElectronProtocolRegistrationError({ scheme: input.scheme, cause }),
        }).pipe(Effect.andThen(Ref.set(registered, schemes))),
        () =>
          Effect.gen(function* () {
            const registeredSchemes = yield* Ref.get(registered);
            for (const scheme of registeredSchemes) {
              yield* Effect.try({
                try: () => Electron.protocol.unhandle(scheme),
                catch: (cause) =>
                  new ElectronProtocolUnregistrationError({
                    scheme,
                    cause,
                  }),
              });
            }
            yield* Ref.set(registered, []);
          }).pipe(Effect.orDie),
      );
    },
  );

  return ElectronProtocol.of({ registerDesktopProtocol });
});

export const layer = Layer.effect(ElectronProtocol, make);
