import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";

export const BYOK_HTTP_TIMEOUT_MS = 15_000;
export const BYOK_HTTP_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const BYOK_HTTP_MAX_REDIRECTS = 3;

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

const execute = (
  client: HttpClient.HttpClient,
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

const follow = (
  client: HttpClient.HttpClient,
  url: URL,
  headers: Readonly<Record<string, string>>,
  redirects: number,
): Effect.Effect<ByokHttpResponse, ByokHttpError> =>
  Effect.gen(function* () {
    const response = yield* execute(client, url, headers);
    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && location !== undefined) {
      if (redirects >= BYOK_HTTP_MAX_REDIRECTS)
        return yield* Effect.fail(
          error("redirect_blocked", "The model catalog endpoint redirected too many times."),
        );
      let target: URL;
      try {
        target = new URL(location, url);
      } catch {
        return yield* Effect.fail(
          error("redirect_blocked", "The model catalog endpoint returned an invalid redirect."),
        );
      }
      if (target.protocol !== "http:" && target.protocol !== "https:")
        return yield* Effect.fail(
          error("redirect_blocked", "The model catalog redirect uses an unsupported protocol."),
        );
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
}): Effect.Effect<ByokHttpResponse, ByokHttpError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => parseURL(input.url),
      catch: (cause) => cause as ByokHttpError,
    });
    const client = yield* HttpClient.HttpClient;
    const result = yield* follow(client, url, input.headers ?? {}, 0).pipe(
      Effect.timeoutOption(BYOK_HTTP_TIMEOUT_MS),
    );
    if (Option.isNone(result))
      return yield* Effect.fail(error("timeout", "The model catalog request timed out."));
    return result.value;
  });
