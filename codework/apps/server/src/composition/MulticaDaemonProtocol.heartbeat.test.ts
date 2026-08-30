import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeMulticaDaemonProtocol,
  type MulticaHttpResponse,
  type MulticaHttpTransport,
} from "./MulticaDaemonProtocol.ts";

const protocolWithHeartbeatResponse = (body: unknown) =>
  makeMulticaDaemonProtocol({
    baseUrl: "https://multica.test",
    transport: {
      request: <T>() => Effect.succeed({ status: 200, body } as MulticaHttpResponse<T>),
    } satisfies MulticaHttpTransport,
  });

describe("Multica heartbeat runtime_id 兼容", () => {
  it.effect("接受与请求一致的显式 runtime_id", () =>
    Effect.gen(function* () {
      const result = yield* protocolWithHeartbeatResponse({
        runtime_id: "runtime-1",
        status: "online",
      }).heartbeat("runtime-1");

      expect(result).toMatchObject({ runtimeId: "runtime-1", status: "online" });
    }),
  );

  it.effect("未回显 runtime_id 时沿用请求值", () =>
    Effect.gen(function* () {
      const result = yield* protocolWithHeartbeatResponse({ status: "ok" }).heartbeat("runtime-1");

      expect(result).toMatchObject({ runtimeId: "runtime-1", status: "ok" });
    }),
  );

  it.effect("拒绝与请求不一致的显式 runtime_id", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        protocolWithHeartbeatResponse({
          runtime_id: "runtime-2",
          status: "online",
        }).heartbeat("runtime-1"),
      );

      expect(failure).toMatchObject({
        operation: "heartbeat",
        code: "invalid_response",
      });
    }),
  );
});
