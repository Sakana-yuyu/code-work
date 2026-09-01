import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeCompositionRuntimeAgentDriver } from "./CompositionRuntimeAgentDriver.ts";
import {
  makeMulticaDaemonRuntimeAdapter,
  type MulticaDaemonRuntimeAdapterOptions,
} from "./MulticaDaemonRuntimeAdapter.ts";
import type {
  MulticaDaemonProtocol,
  MulticaHeartbeatResponse,
  MulticaTask,
} from "./MulticaDaemonProtocol.ts";

const runtimeId = "multica:daemon-1:runtime-1";
const daemonRuntimeId = "runtime-1";

const heartbeat = (status: string, runtimeGone = false): MulticaHeartbeatResponse => ({
  runtimeId: daemonRuntimeId,
  status,
  serverCapabilities: ["rpc-v1", "squad"],
  runtimeGone,
});

const protocolWithHeartbeat = (response: MulticaHeartbeatResponse): MulticaDaemonProtocol => ({
  register: () => Effect.die("测试未实现 register"),
  heartbeat: () => Effect.succeed(response),
  claimTask: () => Effect.succeed<MulticaTask | null>(null),
  startTask: () => Effect.void,
  reportProgress: () => Effect.void,
  completeTask: () => Effect.void,
  failTask: () => Effect.void,
  acknowledgeCancellation: () => Effect.void,
  getTaskStatus: () => Effect.succeed({ status: "running" }),
  quickCreateTask: () => Effect.succeed({ taskId: "unused" }),
});

const adapterWithHeartbeat = (response: MulticaHeartbeatResponse) =>
  makeMulticaDaemonRuntimeAdapter({
    runtimeId,
    daemonId: "daemon-1",
    daemonRuntimeId,
    baseUrl: "https://multica.test",
    protocol: protocolWithHeartbeat(response),
    agents: [
      {
        agentId: "agent-1",
        runtimeId,
        status: "online",
        capabilities: ["squad"],
      },
    ],
    capabilities: ["rpc-v1", "squad"],
  } satisfies MulticaDaemonRuntimeAdapterOptions);

describe("Multica heartbeat 状态投影", () => {
  it.effect("把官方 ok 状态投影为在线 Runtime 和可发现 Agent", () =>
    Effect.gen(function* () {
      const adapter = adapterWithHeartbeat(heartbeat("ok"));
      const driver = makeCompositionRuntimeAgentDriver({ adapter, agentId: "agent-1" });

      expect(yield* adapter.probe()).toMatchObject({ status: "online" });
      expect(yield* adapter.probeMultica()).toMatchObject({ status: "online" });
      expect(yield* adapter.heartbeat()).toMatchObject({ status: "online" });
      expect(yield* driver.getProfile!()).toMatchObject({
        status: "degraded",
        reasonCode: "runtime_capability_handshake_unsupported",
      });
    }),
  );

  it.effect("runtimeGone 优先于 ok 并保持离线事实", () =>
    Effect.gen(function* () {
      const adapter = adapterWithHeartbeat(heartbeat("ok", true));
      const driver = makeCompositionRuntimeAgentDriver({ adapter, agentId: "agent-1" });

      expect(yield* adapter.probe()).toMatchObject({
        status: "offline",
        reasonCode: "runtime_gone",
      });
      expect(yield* adapter.heartbeat()).toMatchObject({ status: "offline" });
      expect(yield* driver.getProfile!()).toMatchObject({
        status: "unavailable",
        reasonCode: "runtime_gone",
      });
    }),
  );

  it.effect("未知 heartbeat 状态继续 fail-safe 为离线", () =>
    Effect.gen(function* () {
      const adapter = adapterWithHeartbeat(heartbeat("future-state"));
      const driver = makeCompositionRuntimeAgentDriver({ adapter, agentId: "agent-1" });

      expect(yield* adapter.probe()).toMatchObject({ status: "offline" });
      expect(yield* adapter.probeMultica()).toMatchObject({ status: "offline" });
      expect(yield* adapter.heartbeat()).toMatchObject({ status: "offline" });
      expect(yield* driver.getProfile!()).toMatchObject({
        status: "unavailable",
        reasonCode: "runtime_offline",
      });
    }),
  );
});
