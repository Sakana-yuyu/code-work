import {
  CompositionRuntimeToolCancellation,
  CompositionRuntimeToolInvocation,
  CompositionToolResult,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  COMPOSITION_RUNTIME_TOOL_BRIDGE_PROTOCOL,
  COMPOSITION_RUNTIME_TOOL_CANCEL_PATH,
  COMPOSITION_RUNTIME_TOOL_INVOKE_PATH,
} from "./CompositionRuntimeToolBridgeHttp.ts";

export class CompositionRuntimeToolBridgeProtocolFailure extends Schema.TaggedErrorClass<CompositionRuntimeToolBridgeProtocolFailure>()(
  "CompositionRuntimeToolBridgeProtocolFailure",
  {
    operation: Schema.String,
    code: Schema.String,
    detail: Schema.String,
    status: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    const suffix = this.status === undefined ? "" : `（HTTP ${this.status}）`;
    return `Code Work Runtime Tool Bridge 操作失败：${this.operation}${suffix}：${this.code}`;
  }
}

export type CompositionRuntimeToolBridgeHttpTransport = {
  readonly request: <T>(input: {
    readonly method: "POST";
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: unknown;
  }) => Effect.Effect<
    { readonly status: number; readonly body: unknown },
    CompositionRuntimeToolBridgeProtocolFailure
  >;
};

export type CompositionRuntimeToolBridgeClient = {
  readonly invoke: (
    input: CompositionRuntimeToolInvocation,
  ) => Effect.Effect<CompositionToolResult, CompositionRuntimeToolBridgeProtocolFailure>;
  readonly cancel: (
    input: CompositionRuntimeToolCancellation,
  ) => Effect.Effect<CompositionToolResult, CompositionRuntimeToolBridgeProtocolFailure>;
};

const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const encodeUnknownJson = Schema.encodeUnknownSync(UnknownJson);
const decodeUnknownJson = Schema.decodeUnknownSync(UnknownJson);
const decodeToolResult = Schema.decodeUnknownSync(CompositionToolResult);
const isBridgeProtocolFailure = Schema.is(CompositionRuntimeToolBridgeProtocolFailure);

const normalizeBaseUrl = (baseUrl: string): string => {
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) throw new Error("Code Work Tool Bridge baseUrl 不能为空。");
  return trimmed.replace(/\/+$/, "");
};

const nonEmpty = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${field} 不能为空。`);
  return trimmed;
};

const makeFailure = (operation: string, code: string, detail: string, status?: number) =>
  new CompositionRuntimeToolBridgeProtocolFailure({
    operation,
    code,
    detail,
    ...(status === undefined ? {} : { status }),
  });

const decodeResponse = (operation: string, body: unknown): CompositionToolResult => {
  try {
    return decodeToolResult(body);
  } catch {
    throw makeFailure(operation, "invalid_response", "Code Work Tool Bridge 返回了无效的工具结果。");
  }
};

export type CompositionRuntimeToolBridgeClientOptions = {
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly transport?: CompositionRuntimeToolBridgeHttpTransport;
  readonly fetchImpl?: typeof fetch;
};

export const makeCompositionRuntimeToolBridgeClient = (
  options: CompositionRuntimeToolBridgeClientOptions,
): CompositionRuntimeToolBridgeClient => {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const transport =
    options.transport ??
    makeCompositionRuntimeToolBridgeFetchTransport({
      baseUrl,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });

  const request = <A extends CompositionRuntimeToolInvocation | CompositionRuntimeToolCancellation>(
    operation: string,
    path: string,
    input: A,
  ): Effect.Effect<CompositionToolResult, CompositionRuntimeToolBridgeProtocolFailure> =>
    Effect.try({
      try: () => {
        const idempotencyKey = nonEmpty(input.idempotencyKey, "idempotencyKey");
        return {
          idempotencyKey,
          body: input,
        };
      },
      catch: (cause) =>
        makeFailure(
          operation,
          "invalid_input",
          cause instanceof Error ? cause.message : String(cause),
        ),
    }).pipe(
      Effect.flatMap(({ idempotencyKey, body }) =>
        transport
          .request({
            method: "POST",
            url: `${baseUrl}${path}`,
            headers: {
              ...(options.headers ?? {}),
              accept: "application/json",
              "content-type": "application/json",
              "idempotency-key": idempotencyKey,
              "x-t3-composition-protocol": COMPOSITION_RUNTIME_TOOL_BRIDGE_PROTOCOL,
            },
            body,
          })
          .pipe(
            Effect.flatMap((response) => {
              if (response.status < 200 || response.status >= 300) {
                return Effect.fail(
                  makeFailure(
                    operation,
                    "http_error",
                    "Code Work Tool Bridge 请求未成功。",
                    response.status,
                  ),
                );
              }
              return Effect.try({
                try: () => decodeResponse(operation, response.body),
                catch: (cause) =>
                  isBridgeProtocolFailure(cause)
                    ? cause
                    : makeFailure(
                        operation,
                        "invalid_response",
                        cause instanceof Error ? cause.message : String(cause),
                      ),
              });
            }),
          ),
      ),
    );

  return {
    invoke: (input) => request("invoke", COMPOSITION_RUNTIME_TOOL_INVOKE_PATH, input),
    cancel: (input) => request("cancel", COMPOSITION_RUNTIME_TOOL_CANCEL_PATH, input),
  };
};

export type CompositionRuntimeToolBridgeFetchTransportOptions = {
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
};

export const makeCompositionRuntimeToolBridgeFetchTransport = (
  options: CompositionRuntimeToolBridgeFetchTransportOptions,
): CompositionRuntimeToolBridgeHttpTransport => {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("当前运行时没有可用的 fetch 实现。");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Code Work Tool Bridge timeoutMs 必须大于 0。");
  }

  return {
    request: (input) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetchImpl(input.url || baseUrl, {
            method: input.method,
            headers: { ...(options.headers ?? {}), ...input.headers },
            body: encodeUnknownJson(input.body),
            signal: AbortSignal.timeout(timeoutMs),
          });
          const text = await response.text();
          if (text.trim().length === 0) return { status: response.status, body: undefined };
          try {
            return { status: response.status, body: decodeUnknownJson(text) };
          } catch (cause) {
            throw makeFailure(
              "http",
              "invalid_json",
              cause instanceof Error ? cause.message : String(cause),
              response.status,
            );
          }
        },
        catch: (cause) =>
          isBridgeProtocolFailure(cause)
            ? cause
            : makeFailure(
                "http",
                cause instanceof DOMException && cause.name === "AbortError"
                  ? "timeout"
                  : "transport_error",
                cause instanceof Error ? cause.message : String(cause),
              ),
      }),
  };
};
