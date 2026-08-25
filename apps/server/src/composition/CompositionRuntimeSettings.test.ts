import { describe, expect, it } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";

import { makeInMemoryCompositionRuntimeAdapter } from "./CompositionRuntimeAdapter.ts";
import {
  makeCompositionRuntimeAdapterRegistry,
  type CompositionRuntimeAdapterRegistry,
} from "./CompositionRuntimeAdapterRegistry.ts";
import {
  makeCompositionRuntimeSettingsReconciler,
  type CompositionRuntimeSettings,
} from "./CompositionRuntimeSettings.ts";

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
  });

describe("CompositionRuntimeSettings", () => {
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
