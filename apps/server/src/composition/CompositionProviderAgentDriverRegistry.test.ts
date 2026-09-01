import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
  TurnId,
  type ProviderSession,
  type ProviderTurnStartResult,
} from "@codework/contracts";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { ProviderInstanceRegistryShape } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import {
  compositionProviderAgentId,
  makeCompositionProviderAgentDriverProjection,
} from "./CompositionProviderAgentDriverRegistry.ts";

const makeProviderInstance = (instanceId: string, supportsToolBroker = false): ProviderInstance =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driverKind: ProviderDriverKind.make("codex"),
    snapshot: {
      getSnapshot: Effect.succeed({
        enabled: true,
        installed: true,
        status: "ready",
        availability: "available",
        version: null,
      } as unknown as ServerProvider),
    },
    adapter: {
      capabilities: {
        sessionModelSwitch: "in-session",
        ...(supportsToolBroker ? { toolBrokerCanonicalTools: ["workspace.read_file"] } : {}),
      },
      ...(supportsToolBroker
        ? {
            handshakeCapabilities: () =>
              Effect.die("projection must route through ProviderService"),
            revokeCapabilityHandshake: () =>
              Effect.die("projection must route through ProviderService"),
            configureToolBroker: () => Effect.die("projection must route through ProviderService"),
            clearToolBroker: () => Effect.die("projection must route through ProviderService"),
          }
        : {}),
    },
  }) as unknown as ProviderInstance;

const makeProviderServiceHarness = () => {
  const calls: string[] = [];
  const session = {} as ProviderSession;
  const service: Pick<
    ProviderServiceShape,
    | "startSession"
    | "sendTurn"
    | "interruptTurn"
    | "stopSession"
    | "handshakeCapabilities"
    | "revokeCapabilityHandshake"
    | "configureToolBroker"
    | "clearToolBroker"
  > = {
    handshakeCapabilities: (_instanceId, input) => {
      calls.push(`handshake:${input.runId}:${input.capabilityGrantIds.join(",")}`);
      return Effect.succeed({
        ...input,
        status: "accepted" as const,
        handshakeId: `adapter-handshake:${input.runId}`,
        acceptedGrantIds: [...input.capabilityGrantIds],
      });
    },
    revokeCapabilityHandshake: (_instanceId, input) => {
      calls.push(`revoke:${input.handshakeId}`);
      return Effect.void;
    },
    configureToolBroker: (_instanceId, input) => {
      calls.push(`configure:${input.threadId}`);
      return Effect.void;
    },
    clearToolBroker: (_instanceId, threadId) => {
      calls.push(`clear:${threadId}`);
      return Effect.void;
    },
    startSession: (threadId, input) => {
      calls.push(`start:${threadId}:${input.providerInstanceId ?? ""}:${input.cwd ?? ""}`);
      return Effect.succeed(session);
    },
    sendTurn: (input) => {
      calls.push(`send:${input.threadId}:${input.input ?? ""}`);
      return Effect.succeed({
        threadId: input.threadId,
        turnId: TurnId.make("turn-1"),
      } satisfies ProviderTurnStartResult);
    },
    interruptTurn: (input) => {
      calls.push(`interrupt:${input.threadId}:${input.turnId ?? ""}`);
      return Effect.void;
    },
    stopSession: (input) => {
      calls.push(`stop:${input.threadId}`);
      return Effect.void;
    },
  };
  return { calls, service };
};

describe("CompositionProviderAgentDriverRegistry", () => {
  it("projects provider instances into stable Composition Agent Drivers", async () => {
    let instances = [makeProviderInstance("codex_personal")];
    const providerRegistry = {
      listInstances: Effect.sync(() => instances),
    } as Pick<ProviderInstanceRegistryShape, "listInstances">;
    const provider = makeProviderServiceHarness();
    const projection = makeCompositionProviderAgentDriverProjection({
      providerRegistry,
      providerService: provider.service,
    });

    await Effect.runPromise(projection.refresh);
    const driver = await Effect.runPromise(
      projection.registry.get(
        compositionProviderAgentId(ProviderInstanceId.make("codex_personal")),
      ),
    );
    expect(driver).toBeDefined();

    await expect(Effect.runPromise(driver!.getProfile!())).resolves.toMatchObject({
      driverKind: "provider",
      providerKind: "codex",
      status: "degraded",
      supportsProviderApi: true,
      supportsToolBroker: false,
      reasonCode: "provider_toolbroker_bridge_unavailable",
    });

    await Effect.runPromise(
      driver!.startTask({
        task: {
          taskId: "task-1",
          projectId: "project-1",
          threadId: "thread-1",
          assigneeKind: "agent",
          assigneeId: compositionProviderAgentId(ProviderInstanceId.make("codex_personal")),
          mode: "serial",
          status: "queued",
          promptDigest: "sha256:prompt",
          dependsOnTaskIds: [],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
        },
        run: {
          runId: "run-1",
          taskId: "task-1",
          agentId: compositionProviderAgentId(ProviderInstanceId.make("codex_personal")),
          runtimeId: "provider:codex_personal",
          status: "queued",
          attempt: 1,
          capabilityGrantIds: [],
        },
        prompt: "检查工作区",
        workspaceRoot: "C:/workspace",
      }),
    );
    expect(provider.calls).toEqual([
      "start:thread-1:codex_personal:C:/workspace",
      "send:thread-1:检查工作区",
    ]);
  });

  it("removes stale provider drivers on refresh", async () => {
    let instances = [makeProviderInstance("codex_personal")];
    const providerRegistry = {
      listInstances: Effect.sync(() => instances),
    } as Pick<ProviderInstanceRegistryShape, "listInstances">;
    const projection = makeCompositionProviderAgentDriverProjection({
      providerRegistry,
      providerService: makeProviderServiceHarness().service,
    });

    await Effect.runPromise(projection.refresh);
    instances = [makeProviderInstance("claude_work")];
    await Effect.runPromise(projection.refresh);

    await expect(
      Effect.runPromise(
        projection.registry.get(
          compositionProviderAgentId(ProviderInstanceId.make("codex_personal")),
        ),
      ),
    ).resolves.toBeUndefined();
    await expect(
      Effect.runPromise(
        projection.registry.get(compositionProviderAgentId(ProviderInstanceId.make("claude_work"))),
      ),
    ).resolves.toBeDefined();
  });

  it("routes capability handshake through ProviderService instead of fabricating acceptance", async () => {
    const instanceId = ProviderInstanceId.make("cursor_personal");
    const providerRegistry = {
      listInstances: Effect.succeed([makeProviderInstance(instanceId, true)]),
    } as Pick<ProviderInstanceRegistryShape, "listInstances">;
    const provider = makeProviderServiceHarness();
    const projection = makeCompositionProviderAgentDriverProjection({
      providerRegistry,
      providerService: provider.service,
      toolBrokerBridge: {
        invoke: () => Effect.die("unused"),
        cancel: () => Effect.die("unused"),
      },
    });
    await Effect.runPromise(projection.refresh);
    const agentId = compositionProviderAgentId(instanceId);
    const driver = await Effect.runPromise(projection.registry.get(agentId));
    expect(driver).toBeDefined();
    await expect(Effect.runPromise(driver!.getProfile!())).resolves.toMatchObject({
      status: "available",
      supportsToolBroker: true,
      supportsCapabilityHandshake: true,
      supportsWorkspace: true,
    });

    const task = {
      taskId: "task-toolbroker",
      projectId: "project-toolbroker",
      threadId: "thread-toolbroker",
      assigneeKind: "agent" as const,
      assigneeId: agentId,
      mode: "serial" as const,
      status: "queued" as const,
      promptDigest: "sha256:toolbroker",
      dependsOnTaskIds: [],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1,
    };
    const run = {
      runId: "run-toolbroker",
      taskId: task.taskId,
      agentId,
      runtimeId: agentId,
      status: "queued" as const,
      attempt: 1,
      capabilityGrantIds: ["grant-workspace-read"],
    };
    const started = await Effect.runPromise(
      driver!.startTask({ task, run, prompt: "读取工作区", workspaceRoot: "C:/workspace" }),
    );
    expect(started.capabilityHandshakeId).toBe("adapter-handshake:run-toolbroker");
    expect(provider.calls).toEqual([
      "handshake:run-toolbroker:grant-workspace-read",
      "configure:thread-toolbroker",
      "start:thread-toolbroker:cursor_personal:C:/workspace",
      "send:thread-toolbroker:读取工作区",
    ]);

    await Effect.runPromise(
      driver!.revokeCapabilityHandshake!({
        task,
        run: {
          ...run,
          status: "running",
          capabilityHandshakeId: started.capabilityHandshakeId,
        },
      }),
    );
    expect(provider.calls.slice(-2)).toEqual([
      "clear:thread-toolbroker",
      "revoke:adapter-handshake:run-toolbroker",
    ]);
  });
});
