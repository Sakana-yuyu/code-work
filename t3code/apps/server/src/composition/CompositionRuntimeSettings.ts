import { createHash } from "node:crypto";

import { CompositionMulticaRuntimeConfig } from "@codework/contracts";
import type { ProviderInstanceConfig, ProviderInstanceEnvironment } from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../serverSettings.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as CompositionRuntimeMcpSessionRegistry from "../mcp/CompositionRuntimeMcpSessionRegistry.ts";
import {
  makeMulticaDaemonRuntimeAdapter,
  type MulticaDaemonRuntimeAdapter,
  type MulticaDaemonRuntimeAdapterOptions,
} from "./MulticaDaemonRuntimeAdapter.ts";
import {
  makeMulticaDaemonProtocol,
  makeMulticaFetchHttpTransport,
} from "./MulticaDaemonProtocol.ts";
import {
  makeMulticaTaskMcpLeaseStore,
  type MulticaTaskMcpLeaseStore,
} from "./MulticaTaskMcpLease.ts";
import { makeMulticaTaskExecutionProcessBridge } from "./MulticaTaskExecutionProcessBridge.ts";
import type { CompositionRuntimeAdapter } from "./CompositionRuntimeAdapter.ts";
import type { CompositionRuntimeAgent } from "./CompositionRuntimeAdapter.ts";
import {
  CompositionRuntimeAdapterRegistryService,
  type CompositionRuntimeAdapterRegistry,
} from "./CompositionRuntimeAdapterRegistry.ts";

export type CompositionRuntimeSettings = {
  readonly settings: Pick<ServerSettingsService["Service"], "getSettings" | "subscribeChanges">;
  readonly adapterRegistry: Pick<CompositionRuntimeAdapterRegistry, "register" | "unregister">;
  readonly processRunner?: Pick<ProcessRunner.ProcessRunner["Service"], "run">;
  readonly mcpSessionRegistry?: Pick<
    CompositionRuntimeMcpSessionRegistry.CompositionRuntimeMcpSessionRegistryShape,
    "activate" | "revokeHandshake" | "revokeRuntime"
  >;
  /** 可选的 Multica daemon extension；未提供时保持官方窄协议行为。 */
  readonly taskExecutionBridge?: MulticaDaemonRuntimeAdapterOptions["taskExecutionBridge"];
  readonly createAdapter?: (
    input: CompositionRuntimeSettingsFactoryInput,
  ) => Effect.Effect<CompositionRuntimeAdapter, CompositionRuntimeSettingsError>;
  readonly logWarning?: (message: string, cause?: unknown) => Effect.Effect<void>;
};

export class CompositionRuntimeSettingsError extends Schema.TaggedErrorClass<CompositionRuntimeSettingsError>()(
  "CompositionRuntimeSettingsError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Composition Runtime Settings 无效：${this.detail}`;
  }
}

export type CompositionRuntimeSettingsFactoryInput = {
  readonly instanceId: string;
  readonly config: CompositionMulticaRuntimeConfig;
  readonly environment: ProviderInstanceEnvironment;
  readonly headers: Readonly<Record<string, string>>;
  readonly agents: ReadonlyArray<CompositionRuntimeAgent>;
  readonly processRunner?: Pick<ProcessRunner.ProcessRunner["Service"], "run">;
  readonly mcpSessionRegistry?: Pick<
    CompositionRuntimeMcpSessionRegistry.CompositionRuntimeMcpSessionRegistryShape,
    "activate" | "revokeHandshake" | "revokeRuntime"
  >;
  readonly taskExecutionBridge?: MulticaDaemonRuntimeAdapterOptions["taskExecutionBridge"];
};

export interface CompositionRuntimeSettingsReconciler {
  readonly refresh: Effect.Effect<void>;
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly ready: Effect.Effect<void>;
}

export class CompositionRuntimeSettingsReconcilerService extends Context.Service<
  CompositionRuntimeSettingsReconcilerService,
  CompositionRuntimeSettingsReconciler
>()("t3/composition/CompositionRuntimeSettings/CompositionRuntimeSettingsReconcilerService") {}

type ManagedAdapter = {
  readonly instanceId: string;
  readonly runtimeId: string;
  readonly fingerprint: string;
  readonly adapter: CompositionRuntimeAdapter;
};

const decodeMulticaConfig = Schema.decodeUnknownSync(CompositionMulticaRuntimeConfig);

const settingsError = (cause: unknown): CompositionRuntimeSettingsError =>
  new CompositionRuntimeSettingsError({
    detail: cause instanceof Error ? cause.message : String(cause),
  });

const defaultLogWarning = (message: string, cause?: unknown): Effect.Effect<void> =>
  Effect.logWarning(message, {
    cause: cause instanceof Error ? cause.message : cause === undefined ? undefined : String(cause),
  });

const makeHeaders = (
  config: CompositionMulticaRuntimeConfig,
  environment: ProviderInstanceEnvironment,
): Readonly<Record<string, string>> => {
  const values = new Map(environment.map((variable) => [variable.name, variable.value]));
  const headers: Record<string, string> = {};
  for (const binding of config.headers) {
    if (headers[binding.headerName] !== undefined) {
      throw new Error(`Multica Header '${binding.headerName}' 重复。`);
    }
    const value = values.get(binding.environmentVariable);
    if (value === undefined || value.length === 0) {
      throw new Error(
        `Multica Header '${binding.headerName}' 依赖环境变量 '${binding.environmentVariable}'，但该变量没有物化值。`,
      );
    }
    headers[binding.headerName] = value;
  }
  return headers;
};

const makeAgents = (
  config: CompositionMulticaRuntimeConfig,
): ReadonlyArray<CompositionRuntimeAgent> => {
  const agentIds = new Set<string>();
  const agents: CompositionRuntimeAgent[] = [];
  for (const route of config.assigneeRoutes) {
    if (agentIds.has(route.t3AgentId)) {
      if (route.t3SquadId !== undefined) continue;
      throw new Error(`Multica assignee route '${route.t3AgentId}' 重复。`);
    }
    agentIds.add(route.t3AgentId);
    agents.push({
      agentId: route.t3AgentId,
      runtimeId: config.runtimeId,
      displayName: `Multica ${route.t3AgentId}`,
      ...(config.version === undefined ? {} : { version: config.version }),
      status: "online",
      capabilities: [...config.capabilities],
    });
  }
  return agents;
};

const RUNTIME_MCP_HANDSHAKE_TTL_MS = 24 * 60 * 60 * 1_000;

const makeRuntimeMcpTokens = (
  config: CompositionMulticaRuntimeConfig,
  environment: ProviderInstanceEnvironment,
): ReadonlyMap<string, string> => {
  const values = new Map(environment.map((variable) => [variable.name, variable.value]));
  const tokens = new Map<string, string>();
  const tokenOwners = new Map<string, string>();
  for (const route of config.assigneeRoutes) {
    const environmentVariable = route.t3McpCredentialEnvironmentVariable;
    if (environmentVariable === undefined) continue;
    const token = values.get(environmentVariable)?.trim();
    if (token === undefined || token.length === 0) {
      throw new Error(
        `Multica Agent '${route.t3AgentId}' 的 T3 MCP 凭据环境变量 '${environmentVariable}' 没有物化值。`,
      );
    }
    const existingToken = tokens.get(route.t3AgentId);
    if (existingToken !== undefined && existingToken !== token) {
      throw new Error(`Multica Agent '${route.t3AgentId}' 配置了多个不同的 T3 MCP 凭据。`);
    }
    const existingOwner = tokenOwners.get(token);
    if (existingOwner !== undefined && existingOwner !== route.t3AgentId) {
      throw new Error(
        `Multica Agent '${route.t3AgentId}' 与 '${existingOwner}' 不能共用同一个 T3 MCP 凭据。`,
      );
    }
    tokens.set(route.t3AgentId, token);
    tokenOwners.set(token, route.t3AgentId);
  }
  return tokens;
};

type RuntimeMcpBridgeBundle = {
  readonly capabilityBridge?: MulticaDaemonRuntimeAdapterOptions["capabilityBridge"];
  readonly taskMcpLeaseBridge?: MulticaDaemonRuntimeAdapterOptions["taskMcpLeaseBridge"];
};

const makeRuntimeMcpCapabilityBridge = (
  runtimeId: string,
  tokens: ReadonlyMap<string, string>,
  mcpSessionRegistry: CompositionRuntimeSettingsFactoryInput["mcpSessionRegistry"],
  taskMcpEndpoint: string | undefined,
): RuntimeMcpBridgeBundle => {
  const taskMcpLeaseStore: MulticaTaskMcpLeaseStore | undefined =
    taskMcpEndpoint === undefined || mcpSessionRegistry === undefined
      ? undefined
      : makeMulticaTaskMcpLeaseStore({ registry: mcpSessionRegistry });
  if (tokens.size === 0 && taskMcpLeaseStore === undefined) return {};

  const capabilityBridge: NonNullable<RuntimeMcpBridgeBundle["capabilityBridge"]> = {
    handshakeCapabilities: (input) =>
      Effect.gen(function* () {
        if (taskMcpLeaseStore !== undefined && taskMcpEndpoint !== undefined) {
          const now = yield* Clock.currentTimeMillis;
          const leaseResult = yield* Effect.result(
            taskMcpLeaseStore.issue({
              ...input,
              endpoint: taskMcpEndpoint,
              expiresAtUnixMs: now + RUNTIME_MCP_HANDSHAKE_TTL_MS,
            }),
          );
          if (Result.isFailure(leaseResult)) {
            return {
              runtimeId,
              taskId: input.taskId,
              runId: input.runId,
              agentId: input.agentId,
              status: "rejected" as const,
              acceptedGrantIds: [],
              reasonCode: `multica_runtime_mcp_lease_${leaseResult.failure.code}`,
            };
          }
          return {
            runtimeId,
            taskId: input.taskId,
            runId: input.runId,
            agentId: input.agentId,
            status: "accepted" as const,
            acceptedGrantIds: [...input.capabilityGrantIds],
            handshakeId: leaseResult.success.capabilityHandshakeId,
            expiresAtUnixMs: leaseResult.success.expiresAtUnixMs,
          };
        }
        const rawToken = tokens.get(input.agentId);
        if (rawToken === undefined) {
          return {
            runtimeId,
            taskId: input.taskId,
            runId: input.runId,
            agentId: input.agentId,
            status: "rejected" as const,
            acceptedGrantIds: [],
            reasonCode: "multica_runtime_mcp_credential_missing",
          };
        }
        const now = yield* Clock.currentTimeMillis;
        const expiresAtUnixMs = now + RUNTIME_MCP_HANDSHAKE_TTL_MS;
        const activationEffect: Effect.Effect<
          CompositionRuntimeMcpSessionRegistry.CompositionRuntimeMcpBinding | undefined,
          CompositionRuntimeMcpSessionRegistry.CompositionRuntimeMcpBindingError
        > =
          mcpSessionRegistry === undefined
            ? Effect.succeed<
                CompositionRuntimeMcpSessionRegistry.CompositionRuntimeMcpBinding | undefined
              >(undefined)
            : mcpSessionRegistry.activate({
                rawToken,
                runtimeId,
                taskId: input.taskId,
                runId: input.runId,
                agentId: input.agentId,
                capabilityGrantIds: input.capabilityGrantIds,
                expiresAtUnixMs,
              });
        const activationResult = yield* Effect.result(activationEffect);
        if (Result.isFailure(activationResult)) {
          return {
            runtimeId,
            taskId: input.taskId,
            runId: input.runId,
            agentId: input.agentId,
            status: "rejected" as const,
            acceptedGrantIds: [],
            reasonCode: `multica_runtime_mcp_${activationResult.failure.code}`,
          };
        }
        if (activationResult.success === undefined) {
          return {
            runtimeId,
            taskId: input.taskId,
            runId: input.runId,
            agentId: input.agentId,
            status: "rejected" as const,
            acceptedGrantIds: [],
            reasonCode: "multica_runtime_mcp_server_unavailable",
          };
        }
        return {
          runtimeId,
          taskId: input.taskId,
          runId: input.runId,
          agentId: input.agentId,
          status: "accepted" as const,
          acceptedGrantIds: [...input.capabilityGrantIds],
          handshakeId: activationResult.success.capabilityHandshakeId,
          expiresAtUnixMs: activationResult.success.expiresAtUnixMs,
        };
      }),
    revokeCapabilityHandshake: ({ handshakeId }) =>
      taskMcpLeaseStore !== undefined
        ? taskMcpLeaseStore.revokeHandshake(handshakeId)
        : mcpSessionRegistry === undefined
          ? Effect.void
          : mcpSessionRegistry.revokeHandshake(handshakeId),
  };
  return {
    capabilityBridge,
    ...(taskMcpLeaseStore === undefined
      ? {}
      : {
          taskMcpLeaseBridge: {
            get: taskMcpLeaseStore.get,
            revokeRuntime: taskMcpLeaseStore.revokeRuntime,
          },
        }),
  };
};

export const makeMulticaRuntimeAdapterFromSettings = (
  input: CompositionRuntimeSettingsFactoryInput,
): Effect.Effect<MulticaDaemonRuntimeAdapter, CompositionRuntimeSettingsError> =>
  Effect.gen(function* () {
    const runtimeMcpTokens = yield* Effect.try({
      try: () =>
        input.config.taskMcpEndpoint === undefined
          ? makeRuntimeMcpTokens(input.config, input.environment)
          : new Map<string, string>(),
      catch: settingsError,
    });
    const runtimeMcpBridge = yield* Effect.try({
      try: () =>
        makeRuntimeMcpCapabilityBridge(
          input.config.runtimeId,
          runtimeMcpTokens,
          input.mcpSessionRegistry,
          input.config.taskMcpEndpoint,
        ),
      catch: settingsError,
    });
    let taskExecutionBridge = input.taskExecutionBridge;
    if (taskExecutionBridge === undefined && input.config.taskExecutionExtension !== undefined) {
      if (input.processRunner === undefined) {
        return yield* new CompositionRuntimeSettingsError({
          detail: "Multica taskExecutionExtension 已配置，但 ProcessRunner 未注入。",
        });
      }
      const extension = input.config.taskExecutionExtension;
      taskExecutionBridge = makeMulticaTaskExecutionProcessBridge({
        command: extension.command,
        args: [...extension.args],
        ...(extension.cwd === undefined ? {} : { cwd: extension.cwd }),
        ...(extension.timeoutMs === undefined ? {} : { timeoutMs: extension.timeoutMs }),
        processRunner: input.processRunner,
      });
    }
    const transport = yield* Effect.try({
      try: () =>
        makeMulticaFetchHttpTransport({
          baseUrl: input.config.baseUrl,
          headers: input.headers,
        }),
      catch: settingsError,
    });
    const protocol = yield* Effect.try({
      try: () =>
        makeMulticaDaemonProtocol({
          baseUrl: input.config.baseUrl,
          transport,
        }),
      catch: settingsError,
    });
    return makeMulticaDaemonRuntimeAdapter({
      runtimeId: input.config.runtimeId,
      daemonId: input.config.daemonId,
      daemonRuntimeId: input.config.daemonRuntimeId,
      baseUrl: input.config.baseUrl,
      protocol,
      agents: input.agents,
      taskAssigneeRoutes: input.config.assigneeRoutes.map((route) => ({
        t3AgentId: route.t3AgentId,
        ...(route.t3SquadId === undefined ? {} : { t3SquadId: route.t3SquadId }),
        workspaceId: route.workspaceId,
        ...(route.multicaAgentId === undefined ? {} : { multicaAgentId: route.multicaAgentId }),
        ...(route.multicaSquadId === undefined ? {} : { multicaSquadId: route.multicaSquadId }),
      })),
      ...(input.config.version === undefined ? {} : { version: input.config.version }),
      capabilities: input.config.capabilities,
      supportsResume: input.config.supportsResume,
      supportsMcp: input.config.supportsMcp,
      supportsSquad: input.config.supportsSquad,
      supportsLeader: input.config.supportsLeader,
      supportsTaskGraph: input.config.supportsTaskGraph,
      ...(runtimeMcpBridge.capabilityBridge === undefined
        ? {}
        : { capabilityBridge: runtimeMcpBridge.capabilityBridge }),
      ...(runtimeMcpBridge.taskMcpLeaseBridge === undefined
        ? {}
        : { taskMcpLeaseBridge: runtimeMcpBridge.taskMcpLeaseBridge }),
      ...(taskExecutionBridge === undefined ? {} : { taskExecutionBridge }),
    });
  });

const defaultCreateAdapter = (
  input: CompositionRuntimeSettingsFactoryInput,
): Effect.Effect<CompositionRuntimeAdapter, CompositionRuntimeSettingsError> =>
  makeMulticaRuntimeAdapterFromSettings(input);

const fingerprintFor = (input: CompositionRuntimeSettingsFactoryInput): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        instanceId: input.instanceId,
        config: input.config,
        headers: input.headers,
        agents: input.agents,
        environment: input.environment,
      }),
    )
    .digest("hex");

const instanceEnabled = (instance: ProviderInstanceConfig): boolean => instance.enabled !== false;

const revokeTaskMcpLeases = (adapter: CompositionRuntimeAdapter): Effect.Effect<void> => {
  if ("revokeTaskMcpLeases" in adapter && typeof adapter.revokeTaskMcpLeases === "function") {
    return adapter.revokeTaskMcpLeases();
  }
  return Effect.void;
};

const makeFactoryInput = (
  instanceId: string,
  instance: ProviderInstanceConfig,
): CompositionRuntimeSettingsFactoryInput => {
  const config = decodeMulticaConfig(instance.config);
  if (!config.enabled || !instanceEnabled(instance)) {
    throw new Error("Multica Runtime 已禁用。");
  }
  const environment = instance.environment ?? [];
  const headers = makeHeaders(config, environment);
  const agents = makeAgents(config);
  return { instanceId, config, environment, headers, agents };
};

export const makeCompositionRuntimeSettingsReconciler = (
  options: CompositionRuntimeSettings,
): CompositionRuntimeSettingsReconciler => {
  const managed = new Map<string, ManagedAdapter>();
  const createAdapter = options.createAdapter ?? defaultCreateAdapter;
  const logWarning = options.logWarning ?? defaultLogWarning;

  const warn = (message: string, cause?: unknown) =>
    logWarning(message, cause).pipe(Effect.catch(() => Effect.void));

  const refresh: Effect.Effect<void> = Effect.gen(function* () {
    const settings = yield* options.settings.getSettings.pipe(
      Effect.catch((cause) =>
        warn("读取 Runtime Settings 失败，保留现有 Adapter。", cause).pipe(Effect.as(undefined)),
      ),
    );
    if (settings === undefined) return;

    const candidates = new Map<string, CompositionRuntimeSettingsFactoryInput>();
    for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
      if (instance.driver !== "multica" || !instanceEnabled(instance)) continue;
      try {
        candidates.set(instanceId, {
          ...makeFactoryInput(instanceId, instance),
          ...(options.mcpSessionRegistry === undefined
            ? {}
            : { mcpSessionRegistry: options.mcpSessionRegistry }),
          ...(options.processRunner === undefined ? {} : { processRunner: options.processRunner }),
          ...(options.taskExecutionBridge === undefined
            ? {}
            : { taskExecutionBridge: options.taskExecutionBridge }),
        });
      } catch (cause) {
        yield* warn(`跳过无效的 Multica Runtime 配置 '${instanceId}'。`, cause);
      }
    }

    const nextManaged = new Map<string, ManagedAdapter>();
    for (const [instanceId, current] of managed) {
      const input = candidates.get(instanceId);
      if (input !== undefined && current.fingerprint === fingerprintFor(input)) {
        nextManaged.set(instanceId, current);
        candidates.delete(instanceId);
        continue;
      }
      yield* options.adapterRegistry.unregister(current.runtimeId);
      yield* revokeTaskMcpLeases(current.adapter);
      yield* options.mcpSessionRegistry?.revokeRuntime(current.runtimeId) ?? Effect.void;
    }

    for (const [instanceId, input] of candidates) {
      const adapter = yield* createAdapter(input).pipe(
        Effect.catch((cause) =>
          warn(`创建 Multica Runtime Adapter '${instanceId}' 失败。`, cause).pipe(
            Effect.as<CompositionRuntimeAdapter | undefined>(undefined),
          ),
        ),
      );
      if (adapter === undefined) continue;
      const registered = yield* options.adapterRegistry.register(adapter).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          warn(`注册 Multica Runtime Adapter '${instanceId}' 失败。`, cause).pipe(Effect.as(false)),
        ),
      );
      if (!registered) continue;
      nextManaged.set(instanceId, {
        instanceId,
        runtimeId: adapter.runtimeId,
        fingerprint: fingerprintFor(input),
        adapter,
      });
    }

    managed.clear();
    for (const [instanceId, entry] of nextManaged) managed.set(instanceId, entry);
  });

  const start = Effect.gen(function* () {
    yield* refresh;
    const changes = yield* options.settings.subscribeChanges;
    yield* Effect.forkScoped(
      Stream.runForEach(changes, () =>
        refresh.pipe(Effect.catch((cause) => warn("Runtime Settings 刷新失败。", cause))),
      ),
    );
  });

  return { refresh, start, ready: Effect.void };
};

const live = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const adapterRegistry = yield* CompositionRuntimeAdapterRegistryService;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const mcpSessionRegistry =
    yield* CompositionRuntimeMcpSessionRegistry.CompositionRuntimeMcpSessionRegistry;
  const reconciler = makeCompositionRuntimeSettingsReconciler({
    settings,
    adapterRegistry,
    mcpSessionRegistry,
    processRunner,
  });
  yield* reconciler.start;
  return reconciler;
});

export const layer = Layer.effect(CompositionRuntimeSettingsReconcilerService, live);
