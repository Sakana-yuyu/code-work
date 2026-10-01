import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";

import {
  ProviderDriverKind,
  DEFAULT_RUNTIME_MODE,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
  TurnId,
  type ProviderSession,
  type ProviderTurnStartResult,
  type OrchestrationThreadShell,
  type RuntimeMode,
} from "@codework/contracts";
import { PersistenceSqlError } from "../persistence/Errors.ts";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  CompositionAgentDriverRegistryService,
  makeCompositionAgentDriverRegistry,
} from "./CompositionAgentDriverRegistry.ts";
import { CompositionRuntimeToolBridgeService } from "./CompositionRuntimeToolBridge.ts";
import type { ProviderInstanceRegistryShape } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import {
  layer as projectionLayer,
  CompositionProviderAgentDriverProjectionService,
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
  effectIt.effect("每次派发读取关联对话模式，缺失或查询失败不创建全权限会话", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("cursor-mode");
      const provider = makeProviderServiceHarness();
      const sessions: unknown[] = [],
        contexts: unknown[] = [];
      let mode: RuntimeMode = "approval-required";
      let missing = false,
        failed = false;
      const lookedUp: string[] = [];
      const projection = makeCompositionProviderAgentDriverProjection({
        providerRegistry: {
          listInstances: Effect.succeed([makeProviderInstance(instanceId, true)]),
        },
        providerService: {
          ...provider.service,
          startSession: (threadId, input) => {
            sessions.push(input.runtimeMode);
            return provider.service.startSession(threadId, input);
          },
          configureToolBroker: (instanceId, input) => {
            contexts.push(input.context.runtimeMode);
            return provider.service.configureToolBroker(instanceId, input);
          },
        },
        toolBrokerBridge: {
          invoke: () => Effect.die("unused"),
          cancel: () => Effect.die("unused"),
          releaseRunResources: () => Effect.void,
        },
        threadQuery: {
          getThreadShellById: (threadId) =>
            Effect.gen(function* () {
              lookedUp.push(threadId);
              if (failed)
                return yield* new PersistenceSqlError({
                  operation: "getThreadShellById",
                  detail: "隔离查询失败",
                });
              return missing
                ? Option.none()
                : Option.some({ runtimeMode: mode } as OrchestrationThreadShell);
            }),
        },
      });
      yield* projection.refresh;
      const agentId = compositionProviderAgentId(instanceId);
      const driver = yield* projection.registry.get(agentId);
      expect(driver).toBeDefined();
      let sequence = 0;
      const start = (linked: boolean) => {
        sequence++;
        const task = {
          taskId: "mode-task-" + sequence,
          projectId: "mode-project",
          ...(linked ? { threadId: "mode-thread" } : {}),
          assigneeKind: "agent" as const,
          assigneeId: agentId,
          mode: "serial" as const,
          status: "queued" as const,
          promptDigest: "sha256:mode",
          dependsOnTaskIds: [],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
        };
        const run = {
          runId: "mode-run-" + sequence,
          taskId: task.taskId,
          agentId,
          runtimeId: agentId,
          status: "queued" as const,
          attempt: 1,
          capabilityGrantIds: ["mode-grant"],
        };
        return driver!
          .startTask({
            task,
            run,
            prompt: "写入隔离文件",
            workspaceRoot: "C:/workspace",
          })
          .pipe(Effect.tap(() => driver!.revokeCapabilityHandshake!({ task, run })));
      };
      for (const expected of ["approval-required", "full-access", "approval-required"] as const) {
        mode = expected;
        yield* start(true);
      }
      yield* start(false);
      expect(sessions).toEqual([
        "approval-required",
        "full-access",
        "approval-required",
        DEFAULT_RUNTIME_MODE,
      ]);
      expect(contexts).toEqual(sessions);
      expect(lookedUp).toEqual(["mode-thread", "mode-thread", "mode-thread"]);
      const beforeCalls = provider.calls.length;
      missing = true;
      expect(yield* Effect.result(start(true))).toMatchObject({
        _tag: "Failure",
        failure: { code: "provider_thread_not_found" },
      });
      failed = true;
      expect(yield* Effect.result(start(true))).toMatchObject({
        _tag: "Failure",
        failure: { code: "provider_runtime_mode_lookup_failed" },
      });
      expect(provider.calls).toHaveLength(beforeCalls);
    }),
  );
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
        releaseRunResources: () => Effect.void,
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

for (const withBridge of [false, true]) {
  effectIt.effect("生产Projection要求宿主工具Bridge：" + withBridge, () =>
    Effect.gen(function* () {
      const provider = makeProviderServiceHarness();
      const changes = yield* PubSub.unbounded<void>();
      const registry = makeCompositionAgentDriverRegistry();
      const dependencies = Context.empty().pipe(
        Context.add(CompositionAgentDriverRegistryService, registry),
        Context.add(ProviderInstanceRegistry, {
          listInstances: Effect.succeed([makeProviderInstance("live-acp", true)]),
          subscribeChanges: PubSub.subscribe(changes),
        } as unknown as ProviderInstanceRegistryShape),
        Context.add(ProviderService, provider.service as ProviderServiceShape),
        Context.add(ProjectionSnapshotQuery, {
          getThreadShellById: () => Effect.succeed(Option.none()),
        } as unknown as ProjectionSnapshotQueryShape),
      );
      const services = withBridge
        ? Context.add(dependencies, CompositionRuntimeToolBridgeService, {
            invoke: () => Effect.die("尚未调用工具"),
            cancel: () => Effect.die("尚未取消工具"),
            releaseRunResources: () => Effect.void,
          })
        : dependencies;
      const result = yield* Layer.build(projectionLayer).pipe(
        // 负向用例故意省略必需服务，验证运行时拒绝缺失依赖而非静默降级。
        Effect.provide(
          services as Context.Context<
            | ProviderInstanceRegistry
            | ProviderService
            | ProjectionSnapshotQuery
            | CompositionAgentDriverRegistryService
            | CompositionRuntimeToolBridgeService
          >,
        ),
        Effect.exit,
        Effect.scoped,
      );
      if (!withBridge) {
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(Cause.pretty(result.cause)).toContain("CompositionRuntimeToolBridgeService");
        return;
      }
      expect(result._tag).toBe("Success");
      if (result._tag !== "Success") return yield* Effect.failCause(result.cause);
      const projection = Context.get(result.value, CompositionProviderAgentDriverProjectionService);
      const profiles = yield* projection.registry.listProfiles;
      expect(profiles[0]?.supportsToolBroker).toBe(true);
      expect(profiles[0]?.supportsCapabilityHandshake).toBe(true);
    }),
  );
}
