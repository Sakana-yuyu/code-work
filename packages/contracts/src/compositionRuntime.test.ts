import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  CompositionAgentDriverProfile,
  CompositionEventEnvelope,
  CompositionIdeResolveResult,
  CompositionMulticaRuntimeConfig,
  CompositionMulticaProbeResult,
  CompositionRuntimeCapabilityHandshakeRequest,
  CompositionRuntimeCapabilityHandshakeResult,
  CompositionMcpRuntimeServerConfig,
  CompositionMcpServerId,
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
const decodeMcpServerConfig = Schema.decodeUnknownSync(CompositionMcpRuntimeServerConfig);
const decodeAgentDriverProfile = Schema.decodeUnknownSync(CompositionAgentDriverProfile);

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

  it("固定 Agent Driver 能力投影的跨端字段和降级语义", () => {
    const decoded = decodeAgentDriverProfile({
      schemaVersion: 1,
      agentId: "multica-local:agent",
      runtimeId: "multica-local",
      driverKind: "multica",
      status: "degraded",
      capabilities: ["squad", "leader", "task-graph"],
      supportsToolBroker: false,
      supportsCapabilityHandshake: false,
      supportsWorkspace: false,
      supportsTerminal: false,
      supportsGit: false,
      supportsMcp: false,
      supportsBrowser: false,
      supportsIde: false,
      supportsProviderApi: false,
      supportsResume: false,
      supportsSquad: true,
      supportsLeader: true,
      supportsTaskGraph: true,
      reasonCode: "runtime_capability_handshake_unsupported",
    });

    expect(decoded.status).toBe("degraded");
    expect(decoded.supportsToolBroker).toBe(false);
    expect(decoded.capabilities).toEqual(["squad", "leader", "task-graph"]);
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
          t3McpCredentialEnvironmentVariable: "MULTICA_AGENT_1_T3_MCP_TOKEN",
        },
      ],
    });

    expect(decoded.headers).toEqual([
      { headerName: "Authorization", environmentVariable: "MULTICA_TOKEN" },
    ]);
    expect(decoded.assigneeRoutes[0]?.multicaAgentId).toBe("agent-remote-1");
    expect(decoded.assigneeRoutes[0]?.t3SquadId).toBe("squad-1");
    expect(decoded.assigneeRoutes[0]?.t3McpCredentialEnvironmentVariable).toBe(
      "MULTICA_AGENT_1_T3_MCP_TOKEN",
    );
    expect((decoded as Record<string, unknown>).token).toBeUndefined();
  });

  it("为 MCP server 提供可持久化的 transport、trust 和敏感字段状态", () => {
    const decoded = decodeMcpServerConfig({
      name: "  Local Tools  ",
      transport: "stdio",
      command: "  node  ",
      args: ["server.mjs"],
      environment: [
        {
          name: "MCP_TOKEN",
          value: "secret-value",
          sensitive: true,
        },
      ],
      headers: [
        {
          name: "Authorization",
          value: "Bearer secret-value",
          sensitive: true,
        },
      ],
      trusted: true,
      trustFingerprint: "sha256:local-tools",
    });

    expect(decoded.name).toBe("Local Tools");
    expect(decoded.command).toBe("node");
    expect(decoded.enabled).toBe(true);
    expect(decoded.trusted).toBe(true);
    expect(decoded.environment[0]?.sensitive).toBe(true);
    expect(CompositionMcpServerId.make("local-tools")).toBe("local-tools");
  });

  it("默认 MCP server 不可信且兼容旧设置中的空 mcpServers", () => {
    const decoded = decodeMcpServerConfig({
      name: "Remote Tools",
      transport: "http",
      url: "https://mcp.example.test",
    });
    expect(decoded.enabled).toBe(true);
    expect(decoded.trusted).toBe(false);
    expect(decoded.environment).toEqual([]);
    expect(decoded.headers).toEqual([]);
  });
});
