import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "vite-plus/test";
import { CompositionMulticaRuntimeConfig } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";

import * as CompositionRuntimeMcpSessionRegistry from "../mcp/CompositionRuntimeMcpSessionRegistry.ts";
import { makeInMemoryCompositionRuntimeAdapter } from "./CompositionRuntimeAdapter.ts";
import {
  makeCompositionRuntimeAdapterRegistry,
  type CompositionRuntimeAdapterRegistry,
} from "./CompositionRuntimeAdapterRegistry.ts";
import {
  makeCompositionRuntimeSettingsReconciler,
  makeMulticaRuntimeAdapterFromSettings,
  type CompositionRuntimeSettings,
} from "./CompositionRuntimeSettings.ts";
import type {
  MulticaDaemonRuntimeAdapter,
  MulticaDaemonTaskExecutionBridge,
} from "./MulticaDaemonRuntimeAdapter.ts";

const makeSettings = (providerInstances: unknown): ServerSettings =>
  ({
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances,
  }) as ServerSettings;

const multicaInstance = (overrides: Record<string, unknown> = {}) => ({
  driver: "multica",
  enabled: true,
  environment: [{ name: "MULTICA_TOKEN", value: "secret-token", sensitive: true }],
  config: {
    runtimeId: "multica:daemon-1:runtime-1",
    daemonId: "daemon-1",
    daemonRuntimeId: "runtime-1",
    baseUrl: "http://127.0.0.1:9000",
    headers: [{ headerName: "Authorization", environmentVariable: "MULTICA_TOKEN" }],
    assigneeRoutes: [
      {
        t3AgentId: "agent-1",
        workspaceId: "workspace-1",
        multicaAgentId: "remote-agent-1",
      },
    ],
    ...overrides,
  },
});

const makeSettingsService = (
  getSettings: () => ServerSettings,
  changes: Stream.Stream<ServerSettings> = Stream.empty,
): CompositionRuntimeSettings["settings"] => ({
  getSettings: Effect.sync(getSettings),
  subscribeChanges: Effect.succeed(changes),
});

const makeReconciler = (
  settings: () => ServerSettings,
  registry: CompositionRuntimeAdapterRegistry,
  input?: {
    readonly warnings?: string[];
    readonly created?: Array<Record<string, unknown>>;
    readonly changes?: Stream.Stream<ServerSettings>;
    readonly taskExecutionBridge?: MulticaDaemonTaskExecutionBridge;
  },
) =>
  makeCompositionRuntimeSettingsReconciler({
    settings: makeSettingsService(settings, input?.changes),
    adapterRegistry: registry,
    createAdapter: (factoryInput) =>
      Effect.sync(() => {
        input?.created?.push({
          instanceId: factoryInput.instanceId,
          headers: factoryInput.headers,
          agentIds: factoryInput.agents.map((agent) => agent.agentId),
          ...(factoryInput.taskExecutionBridge === undefined
            ? {}
            : { hasTaskExecutionBridge: true }),
        });
        return makeInMemoryCompositionRuntimeAdapter({
          runtimeId: factoryInput.config.runtimeId,
          agents: factoryInput.agents,
        });
      }),
    logWarning: (message) =>
      Effect.sync(() => {
        input?.warnings?.push(message);
      }),
    ...(input?.taskExecutionBridge === undefined
      ? {}
      : { taskExecutionBridge: input.taskExecutionBridge }),
  });

describe("CompositionRuntimeSettings", () => {
  it("taskMcpEndpoint 启用每 Run Lease 时不读取静态 Agent token，并可从 Adapter 取回 overlay", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* CompositionRuntimeMcpSessionRegistry.__testing
          .make({ now: () => 1_000 })
          .pipe(Effect.provide(NodeServices.layer));
        const config = yield* Schema.decodeUnknownEffect(CompositionMulticaRuntimeConfig)({
          ...multicaInstance().config,
          taskMcpEndpoint: "http://127.0.0.1:4317/mcp/composition-runtime",
        });
        const adapter = yield* makeMulticaRuntimeAdapterFromSettings({
          instanceId: "multica_local",
          config,
          environment: [],
          headers: {},
          agents: [
            {
              agentId: "agent-1",
              runtimeId: config.runtimeId,
              displayName: "Multica Agent",
              status: "online",
              capabilities: ["t3.toolbroker"],
            },
          ],
          mcpSessionRegistry: registry,
        });

        const handshake = yield* adapter.handshakeCapabilities!({
          runtimeId: config.runtimeId,
          taskId: "task-f2",
          runId: "run-f2",
          agentId: "agent-1",
          capabilityGrantIds: ["grant-terminal"],
        });
        expect(handshake.status).toBe("accepted");
        expect(handshake.handshakeId).toBeDefined();

        const lease = yield* adapter.getTaskMcpLease(handshake.handshakeId!);
        expect(lease).toMatchObject({
          runtimeId: config.runtimeId,
          taskId: "task-f2",
          runId: "run-f2",
          agentId: "agent-1",
          endpoint: "http://127.0.0.1:4317/mcp/composition-runtime",
          mcpConfig: {
            mcpServers: {
              "t3-composition-runtime": {
                type: "http",
                url: "http://127.0.0.1:4317/mcp/composition-runtime",
              },
            },
          },
        });
        expect(lease?.rawToken).toMatch(/^t3mcp_/);

        yield* adapter.revokeCapabilityHandshake!({ handshakeId: handshake.handshakeId! });
        expect(yield* adapter.getTaskMcpLease(handshake.handshakeId!)).toBeUndefined();
      }),
    );
  });

  it("Reconciler 将 taskExecutionBridge 透传给 Multica Adapter 工厂", async () => {
    const registry = makeCompositionRuntimeAdapterRegistry();
    const created: Array<Record<string, unknown>> = [];
    const bridge: MulticaDaemonTaskExecutionBridge = {
      injectTaskStart: () => Effect.void,
    };
    const reconciler = makeReconciler(
      () =>
        makeSettings({
          multica_local: multicaInstance({ taskMcpEndpoint: "http://127.0.0.1:4317/mcp" }),
        }),
      registry,
      { created, taskExecutionBridge: bridge },
    );

    await Effect.runPromise(reconciler.refresh);

    expect(created).toEqual([
      {
        instanceId: "multica_local",
        headers: { Authorization: "secret-token" },
        agentIds: ["agent-1"],
        hasTaskExecutionBridge: true,
      },
    ]);
  });

  it("从 Multica provider instance 构造 headers、Agent 投影并注册 Adapter", async () => {
    const registry = makeCompositionRuntimeAdapterRegistry();
    const created: Array<Record<string, unknown>> = [];
    const reconciler = makeReconciler(
      () =>
        makeSettings({
          multica_local: multicaInstance(),
        }),
      registry,
      { created },
    );

    await Effect.runPromise(reconciler.refresh);

    expect(created).toEqual([
      {
        instanceId: "multica_local",
        headers: { Authorization: "secret-token" },
        agentIds: ["agent-1"],
      },
    ]);
    await expect(
      Effect.runPromise(registry.get("multica:daemon-1:runtime-1")),
    ).resolves.toBeDefined();
  });

  it("禁用或删除配置时只注销 reconciler 自己管理的 Adapter", async () => {
    const registry = makeCompositionRuntimeAdapterRegistry();
    const external = makeInMemoryCompositionRuntimeAdapter({ runtimeId: "external-runtime" });
    await Effect.runPromise(registry.register(external));

    let settings = makeSettings({ multica_local: multicaInstance() });
    const reconciler = makeReconciler(() => settings, registry);
    await Effect.runPromise(reconciler.refresh);

    settings = makeSettings({});
    await Effect.runPromise(reconciler.refresh);

    await expect(
      Effect.runPromise(registry.get("multica:daemon-1:runtime-1")),
    ).resolves.toBeUndefined();
    await expect(Effect.runPromise(registry.get("external-runtime"))).resolves.toBe(external);
  });

  it("非法配置只记录警告，不阻断其它 Runtime 的注册", async () => {
    const registry = makeCompositionRuntimeAdapterRegistry();
    const warnings: string[] = [];
    const reconciler = makeReconciler(
      () =>
        makeSettings({
          invalid_multica: multicaInstance({ runtimeId: "" }),
          valid_multica: multicaInstance({ runtimeId: "multica:daemon-2:runtime-2" }),
        }),
      registry,
      { warnings },
    );

    await expect(Effect.runPromise(reconciler.refresh)).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    await expect(
      Effect.runPromise(registry.get("multica:daemon-2:runtime-2")),
    ).resolves.toBeDefined();
    await expect(
      Effect.runPromise(registry.get("multica:daemon-1:runtime-1")),
    ).resolves.toBeUndefined();
  });

  it("使用每个 Multica Agent 的独立环境凭据建立可撤销 MCP capability handshake", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registryContext = yield* Layer.build(
            CompositionRuntimeMcpSessionRegistry.layer.pipe(Layer.provide(NodeServices.layer)),
          );
          const runtimeMcpRegistry = Context.get(
            registryContext,
            CompositionRuntimeMcpSessionRegistry.CompositionRuntimeMcpSessionRegistry,
          );
          const config = yield* Schema.decodeUnknownEffect(CompositionMulticaRuntimeConfig)(
            multicaInstance({
              assigneeRoutes: [
                {
                  t3AgentId: "agent-1",
                  workspaceId: "workspace-1",
                  multicaAgentId: "remote-agent-1",
                  t3McpCredentialEnvironmentVariable: "MULTICA_AGENT_1_T3_MCP_TOKEN",
                },
              ],
            }).config,
          );
          const adapter = yield* makeMulticaRuntimeAdapterFromSettings({
            instanceId: "multica_local",
            config,
            environment: [
              { name: "MULTICA_TOKEN", value: "secret-token", sensitive: true },
              {
                name: "MULTICA_AGENT_1_T3_MCP_TOKEN",
                value: "agent-1-runtime-token",
                sensitive: true,
              },
            ],
            headers: { Authorization: "secret-token" },
            agents: [
              {
                agentId: "agent-1",
                runtimeId: config.runtimeId,
                displayName: "Multica agent-1",
                status: "online",
                capabilities: [],
              },
            ],
            mcpSessionRegistry: runtimeMcpRegistry,
          });

          const handshake = yield* adapter.handshakeCapabilities!({
            runtimeId: config.runtimeId,
            taskId: "task-1",
            runId: "run-1",
            agentId: "agent-1",
            capabilityGrantIds: ["grant-workspace"],
          });
          expect(handshake).toMatchObject({
            status: "accepted",
            acceptedGrantIds: ["grant-workspace"],
          });
          expect(handshake.handshakeId).toBeDefined();

          expect(yield* runtimeMcpRegistry.resolve("agent-1-runtime-token")).toMatchObject({
            runtimeId: config.runtimeId,
            taskId: "task-1",
            runId: "run-1",
            agentId: "agent-1",
            capabilityGrantIds: ["grant-workspace"],
            capabilityHandshakeId: handshake.handshakeId,
          });

          yield* adapter.revokeCapabilityHandshake!({
            handshakeId: handshake.handshakeId!,
          });
          expect(yield* runtimeMcpRegistry.resolve("agent-1-runtime-token")).toBeUndefined();
        }),
      ),
    );
  });

  it("拒绝两个 Multica Agent 共用同一个 T3 MCP 凭据", async () => {
    const config = Schema.decodeUnknownSync(CompositionMulticaRuntimeConfig)(
      multicaInstance({
        assigneeRoutes: [
          {
            t3AgentId: "agent-1",
            workspaceId: "workspace-1",
            multicaAgentId: "remote-agent-1",
            t3McpCredentialEnvironmentVariable: "AGENT_1_TOKEN",
          },
          {
            t3AgentId: "agent-2",
            workspaceId: "workspace-1",
            multicaAgentId: "remote-agent-2",
            t3McpCredentialEnvironmentVariable: "AGENT_2_TOKEN",
          },
        ],
      }).config,
    );

    await expect(
      Effect.runPromise(
        makeMulticaRuntimeAdapterFromSettings({
          instanceId: "multica_local",
          config,
          environment: [
            { name: "MULTICA_TOKEN", value: "secret-token", sensitive: true },
            { name: "AGENT_1_TOKEN", value: "shared-runtime-token", sensitive: true },
            { name: "AGENT_2_TOKEN", value: "shared-runtime-token", sensitive: true },
          ],
          headers: { Authorization: "secret-token" },
          agents: [
            {
              agentId: "agent-1",
              runtimeId: config.runtimeId,
              displayName: "Multica agent-1",
              status: "online",
              capabilities: [],
            },
            {
              agentId: "agent-2",
              runtimeId: config.runtimeId,
              displayName: "Multica agent-2",
              status: "online",
              capabilities: [],
            },
          ],
        }),
      ),
    ).rejects.toThrow("不能共用同一个 T3 MCP 凭据");
  });

  it("轮换 Agent MCP 凭据会重建 Adapter 并撤销旧 binding", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registryContext = yield* Layer.build(
            CompositionRuntimeMcpSessionRegistry.layer.pipe(Layer.provide(NodeServices.layer)),
          );
          const mcpSessionRegistry = Context.get(
            registryContext,
            CompositionRuntimeMcpSessionRegistry.CompositionRuntimeMcpSessionRegistry,
          );
          const configOverrides = {
            assigneeRoutes: [
              {
                t3AgentId: "agent-1",
                workspaceId: "workspace-1",
                multicaAgentId: "remote-agent-1",
                t3McpCredentialEnvironmentVariable: "AGENT_1_TOKEN",
              },
            ],
          };
          const makeInstance = (token: string) => ({
            ...multicaInstance(configOverrides),
            environment: [
              { name: "MULTICA_TOKEN", value: "daemon-token", sensitive: true },
              { name: "AGENT_1_TOKEN", value: token, sensitive: true },
            ],
          });
          let settings = makeSettings({ multica_local: makeInstance("old-agent-token") });
          const adapterRegistry = makeCompositionRuntimeAdapterRegistry();
          const created: MulticaDaemonRuntimeAdapter[] = [];
          const reconciler = makeCompositionRuntimeSettingsReconciler({
            settings: {
              getSettings: Effect.sync(() => settings),
              subscribeChanges: Effect.succeed(Stream.empty),
            },
            adapterRegistry,
            mcpSessionRegistry,
            createAdapter: (input) =>
              makeMulticaRuntimeAdapterFromSettings(input).pipe(
                Effect.tap((adapter) => Effect.sync(() => created.push(adapter))),
              ),
          });

          yield* reconciler.refresh;
          const first = created[0];
          expect(first).toBeDefined();
          const firstHandshake = yield* first!.handshakeCapabilities!({
            runtimeId: first!.runtimeId,
            taskId: "task-rotation",
            runId: "run-old",
            agentId: "agent-1",
            capabilityGrantIds: ["grant-workspace"],
          });
          expect(firstHandshake.status).toBe("accepted");
          expect(yield* mcpSessionRegistry.resolve("old-agent-token")).toBeDefined();

          settings = makeSettings({ multica_local: makeInstance("new-agent-token") });
          yield* reconciler.refresh;

          expect(created).toHaveLength(2);
          expect(yield* mcpSessionRegistry.resolve("old-agent-token")).toBeUndefined();
          const second = created[1];
          expect(second).toBeDefined();
          const secondHandshake = yield* second!.handshakeCapabilities!({
            runtimeId: second!.runtimeId,
            taskId: "task-rotation",
            runId: "run-new",
            agentId: "agent-1",
            capabilityGrantIds: ["grant-workspace"],
          });
          expect(secondHandshake.status).toBe("accepted");
          expect(yield* mcpSessionRegistry.resolve("new-agent-token")).toBeDefined();
        }),
      ),
    );
  });

  it("start 会监听 Settings 变化并替换自己管理的 Adapter", async () => {
    const registry = makeCompositionRuntimeAdapterRegistry();
    const changes = Effect.runSync(Queue.unbounded<ServerSettings>());
    const replaced = Effect.runSync(Deferred.make<void>());
    let settings = makeSettings({ multica_local: multicaInstance() });
    const adapterRegistry: CompositionRuntimeAdapterRegistry = {
      ...registry,
      register: (adapter) =>
        registry
          .register(adapter)
          .pipe(
            Effect.tap(() =>
              adapter.runtimeId === "multica:daemon-2:runtime-2"
                ? Deferred.succeed(replaced, undefined)
                : Effect.void,
            ),
          ),
    };
    const reconciler = makeCompositionRuntimeSettingsReconciler({
      settings: {
        getSettings: Effect.sync(() => settings),
        subscribeChanges: Effect.succeed(Stream.fromQueue(changes)),
      },
      adapterRegistry,
      createAdapter: (factoryInput) =>
        Effect.sync(() => {
          return makeInMemoryCompositionRuntimeAdapter({
            runtimeId: factoryInput.config.runtimeId,
            agents: factoryInput.agents,
          });
        }),
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* reconciler.start;
          settings = makeSettings({
            multica_local: multicaInstance({ runtimeId: "multica:daemon-2:runtime-2" }),
          });
          yield* Queue.offer(changes, settings);
          yield* Deferred.await(replaced);
          expect(yield* registry.get("multica:daemon-1:runtime-1")).toBeUndefined();
          expect(yield* registry.get("multica:daemon-2:runtime-2")).toBeDefined();
        }),
      ),
    );
  });
});
