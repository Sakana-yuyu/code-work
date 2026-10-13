import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { withByokCatalogSignal } from "./ByokHttpClient.ts";

export const BYOK_HTTP_TIMEOUT_MS = 15_000;
export const BYOK_HTTP_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const BYOK_HTTP_MAX_REDIRECTS = 3;

class CatalogHttpScope extends Context.Reference<
  { readonly scope: Scope.Scope; readonly signal: AbortSignal } | undefined
>("codework/provider/byok/CatalogHttpScope", { defaultValue: () => undefined }) {}

/** 目录的所有候选与跳转属于同一次共享加载，不能在单个候选结束时取消传输。 */
export const withByokCatalogHttpScope = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const controller = new AbortController();
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
    return yield* effect.pipe(
      Effect.provideService(CatalogHttpScope, { scope, signal: controller.signal }),
    );
  }).pipe(Effect.scoped);

export type ByokHttpErrorCode =
  | "invalid_endpoint"
  | "timeout"
  | "response_too_large"
  | "redirect_blocked"
  | "network";
export interface ByokHttpError {
  readonly _tag: "ByokHttpError";
  readonly code: ByokHttpErrorCode;
  readonly message: string;
  readonly status?: number;
}
export interface ByokHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly truncated: boolean;
}

const error = (code: ByokHttpErrorCode, message: string, status?: number): ByokHttpError => ({
  _tag: "ByokHttpError",
  code,
  message,
  ...(status === undefined ? {} : { status }),
});
const SAFE_RESPONSE_HEADERS = new Set(["content-type", "location", "retry-after"]);
const SENSITIVE_REQUEST_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "referer",
  "x-api-key",
  "x-goog-api-key",
]);
const parseURL = (value: string): URL => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw error("invalid_endpoint", "The model catalog endpoint is invalid.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw error("invalid_endpoint", "The model catalog endpoint must use HTTP or HTTPS.");
  return parsed;
};

const resolveRedirectURL = (location: string, base: URL): URL | ByokHttpError => {
  try {
    const target = new URL(location, base);
    return target.protocol === "http:" || target.protocol === "https:"
      ? target
      : error("redirect_blocked", "The model catalog redirect uses an unsupported protocol.");
  } catch {
    return error("redirect_blocked", "The model catalog endpoint returned an invalid redirect.");
  }
};
const responseHeaders = (headers: Readonly<Record<string, string>>) =>
  Object.fromEntries(
    Object.entries(headers).filter(([key]) => SAFE_RESPONSE_HEADERS.has(key.toLowerCase())),
  );
const redirectHeaders = (headers: Readonly<Record<string, string>>, from: URL, to: URL) =>
  from.origin === to.origin
    ? headers
    : Object.fromEntries(
        Object.entries(headers).filter(
          ([key]) => !SENSITIVE_REQUEST_HEADERS.has(key.toLowerCase()),
        ),
      );

const execute = <E>(
  client: HttpClient.HttpClient.With<E, Scope.Scope>,
  url: URL,
  headers: Readonly<Record<string, string>>,
) =>
  client
    .execute(
      Object.entries(headers).reduce(
        (request, [key, value]) => HttpClientRequest.setHeader(request, key, value),
        HttpClientRequest.get(url.toString()),
      ),
    )
    .pipe(Effect.mapError(() => error("network", "The model catalog request failed.")));

const follow = <E>(
  client: HttpClient.HttpClient.With<E, Scope.Scope>,
  url: URL,
  headers: Readonly<Record<string, string>>,
  redirects: number,
): Effect.Effect<ByokHttpResponse, ByokHttpError, Scope.Scope> =>
  Effect.gen(function* () {
    const response = yield* execute(client, url, headers);
    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && location !== undefined) {
      if (redirects >= BYOK_HTTP_MAX_REDIRECTS)
        return yield* Effect.fail(
          error("redirect_blocked", "The model catalog endpoint redirected too many times."),
        );
      const target = resolveRedirectURL(location, url);
      if (!(target instanceof URL)) return yield* Effect.fail(target);
      return yield* follow(client, target, redirectHeaders(headers, url, target), redirects + 1);
    }
    const collected = yield* collectUint8StreamText({
      stream: response.stream,
      maxBytes: BYOK_HTTP_MAX_RESPONSE_BYTES,
    }).pipe(
      Effect.mapError(() => error("network", "The model catalog response could not be read.")),
    );
    if (collected.truncated)
      return yield* Effect.fail(
        error("response_too_large", "The model catalog response is too large.", response.status),
      );
    return {
      status: response.status,
      headers: responseHeaders(response.headers),
      body: collected.text,
      truncated: false,
    };
  });

export const fetchByokCatalog = (input: {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** 多地址发现传入整轮剩余预算；余额等单请求调用沿用默认上限。 */
  readonly timeoutMs?: number;
}): Effect.Effect<ByokHttpResponse, ByokHttpError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => parseURL(input.url),
      catch: (cause) => cause as ByokHttpError,
    });
    const client = yield* HttpClient.HttpClient;
    const catalogScope = yield* CatalogHttpScope;
    // 请求头仅来自此处的显式输入，避免默认 headers 在跨源剥离后被 HTTP 层重新补回。
    const options = { redirect: "manual" as const };
    const request = follow(HttpClient.withScope(client), url, input.headers ?? {}, 0).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, options),
    );
    const result = yield* (
      catalogScope
        ? request.pipe(
            Effect.provideService(Scope.Scope, catalogScope.scope),
            withByokCatalogSignal(catalogScope.signal),
          )
        : request.pipe(Effect.scoped)
    ).pipe(Effect.timeoutOption(input.timeoutMs ?? BYOK_HTTP_TIMEOUT_MS));
    if (Option.isNone(result))
      return yield* Effect.fail(error("timeout", "The model catalog request timed out."));
    return result.value;
  });
