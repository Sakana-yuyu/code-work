import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  CompositionEventEnvelope,
  CompositionIdeResolveResult,
  CompositionMulticaRuntimeConfig,
  CompositionMulticaProbeResult,
  CompositionRuntimeCapabilityHandshakeRequest,
  CompositionRuntimeCapabilityHandshakeResult,
  CompositionRuntimeProbeResult,
} from "./compositionRuntime.ts";

const decodeEnvelope = Schema.decodeUnknownSync(CompositionEventEnvelope);
const decodeRuntimeProbe = Schema.decodeUnknownSync(CompositionRuntimeProbeResult);
const decodeIdeResult = Schema.decodeUnknownSync(CompositionIdeResolveResult);
const decodeMulticaProbe = Schema.decodeUnknownSync(CompositionMulticaProbeResult);
const decodeCapabilityHandshakeRequest = Schema.decodeUnknownSync(
  CompositionRuntimeCapabilityHandshakeRequest,
);
const decodeCapabilityHandshakeResult = Schema.decodeUnknownSync(
  CompositionRuntimeCapabilityHandshakeResult,
);
const decodeMulticaConfig = Schema.decodeUnknownSync(CompositionMulticaRuntimeConfig);

describe("composition runtime contracts", () => {
  it("keeps the event envelope additive to task events", () => {
    const event = decodeEnvelope({
      schemaVersion: 1,
      eventId: "event-1",
      kind: "composition.task",
      taskId: "task-1",
      runId: "run-1",
      agentId: "agent-1",
      sequence: 0,
      eventType: "message",
      status: "running",
      summary: "已接收任务",
      source: "t3",
      occurredAtUnixMs: 1,
      terminal: false,
    });

    expect(event.kind).toBe("composition.task");
    expect(event.terminal).toBe(false);
  });

  it("requires runtime capabilities to come from a probe result", () => {
    const decoded = decodeRuntimeProbe({
      runtimeId: "codex-local",
      driverKind: "cli",
      status: "online",
      version: "1.0.0",
      capabilities: ["task.cancel", "mcp"],
      supportsResume: true,
      supportsMcp: true,
    });

    expect(decoded.capabilities).toEqual(["task.cancel", "mcp"]);
    expect(() =>
      decodeRuntimeProbe({
        runtimeId: "named-but-unknown",
        driverKind: "cli",
        status: "online",
        capabilities: [],
        supportsResume: true,
        supportsMcp: true,
      }),
    ).not.toThrow();
  });

  it("requires an accepted capability handshake to carry a traceable handshake ID", () => {
    const request = decodeCapabilityHandshakeRequest({
      runtimeId: "runtime-1",
      taskId: "task-1",
      runId: "run-1",
      agentId: "agent-1",
      capabilityGrantIds: ["grant-1"],
    });
    expect(request.capabilityGrantIds).toEqual(["grant-1"]);

    const accepted = decodeCapabilityHandshakeResult({
      ...request,
      status: "accepted",
      handshakeId: "handshake-1",
      acceptedGrantIds: ["grant-1"],
    });
    expect(accepted.handshakeId).toBe("handshake-1");
    expect(
      decodeCapabilityHandshakeResult({
        ...request,
        status: "unsupported",
        acceptedGrantIds: [],
        reasonCode: "runtime_capability_handshake_unsupported",
      }).handshakeId,
    ).toBeUndefined();
  });

  it("represents an unknown IDE profile as unavailable instead of guessing", () => {
    const decoded = decodeIdeResult({
      sessionId: "ide-session-1",
      profile: "unknown",
      verifiedOperations: [],
      status: "unavailable",
      reasonCode: "ide_profile_unknown",
    });

    expect(decoded.status).toBe("unavailable");
    expect(decoded.profile).toBe("unknown");
  });

  it("keeps Multica daemon support explicit and probeable", () => {
    const decoded = decodeMulticaProbe({
      runtimeId: "multica-local",
      status: "offline",
      capabilities: [],
      supportsSquad: false,
      supportsLeader: false,
      supportsTaskGraph: false,
      reasonCode: "runtime_offline",
    });

    expect(decoded.status).toBe("offline");
    expect(decoded.supportsSquad).toBe(false);
  });

  it("只保存 Header 到环境变量的绑定，不把秘密放进 Multica 配置合同", () => {
    const decoded = decodeMulticaConfig({
      runtimeId: "multica:daemon-1:runtime-1",
      daemonId: "daemon-1",
      daemonRuntimeId: "runtime-1",
      baseUrl: "https://multica.test",
      headers: [{ headerName: "Authorization", environmentVariable: "MULTICA_TOKEN" }],
      assigneeRoutes: [
        {
          t3AgentId: "agent-1",
          t3SquadId: "squad-1",
          workspaceId: "workspace-1",
          multicaAgentId: "agent-remote-1",
        },
      ],
    });

    expect(decoded.headers).toEqual([
      { headerName: "Authorization", environmentVariable: "MULTICA_TOKEN" },
    ]);
    expect(decoded.assigneeRoutes[0]?.multicaAgentId).toBe("agent-remote-1");
    expect(decoded.assigneeRoutes[0]?.t3SquadId).toBe("squad-1");
    expect((decoded as Record<string, unknown>).token).toBeUndefined();
  });
});
