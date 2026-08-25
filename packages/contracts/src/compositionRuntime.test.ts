import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  CompositionEventEnvelope,
  CompositionIdeResolveResult,
  CompositionMulticaProbeResult,
  CompositionRuntimeProbeResult,
} from "./compositionRuntime.ts";

const decodeEnvelope = Schema.decodeUnknownSync(CompositionEventEnvelope);
const decodeRuntimeProbe = Schema.decodeUnknownSync(CompositionRuntimeProbeResult);
const decodeIdeResult = Schema.decodeUnknownSync(CompositionIdeResolveResult);
const decodeMulticaProbe = Schema.decodeUnknownSync(CompositionMulticaProbeResult);

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
});
