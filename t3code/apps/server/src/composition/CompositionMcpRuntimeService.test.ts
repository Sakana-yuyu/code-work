import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  makeCompositionMcpRuntimeService,
  type CompositionMcpRuntimeServiceSettings,
} from "./CompositionMcpRuntimeService.ts";
import type {
  CompositionMcpRuntimeAdapterShape,
  CompositionMcpRuntimeServerConfig,
} from "./CompositionMcpRuntimeAdapter.ts";

const localServer = {
  name: "Local Tools",
  transport: "stdio" as const,
  command: "node",
  args: ["server.mjs"],
  environment: [{ name: "MCP_TOKEN", value: "secret", sensitive: true }],
  headers: [{ name: "Authorization", value: "Bearer secret", sensitive: true }],
  enabled: true,
  trusted: true,
  schemaVersion: 1 as const,
};

const remoteServer = {
  name: "Remote Tools",
  transport: "http" as const,
  url: "https://mcp.example.test",
  environment: [],
  headers: [],
  enabled: true,
  trusted: false,
  schemaVersion: 1 as const,
};

const settingsWithServers = (mcpServers: ServerSettings["mcpServers"]): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  mcpServers,
});

const makeFakeAdapter = () => {
  const registered = new Map<string, CompositionMcpRuntimeServerConfig>();
  const registerCalls: CompositionMcpRuntimeServerConfig[] = [];
  const connectCalls: string[] = [];
  const unregisterCalls: string[] = [];

  const adapter: CompositionMcpRuntimeAdapterShape = {
    registerServer: (config) =>
      Effect.sync(() => {
        registered.set(config.serverId, config);
        registerCalls.push(config);
      }),
    unregisterServer: (serverId) =>
      Effect.sync(() => {
        unregisterCalls.push(serverId);
        return registered.delete(serverId);
      }),
    connect: (serverId) =>
      Effect.sync(() => {
        connectCalls.push(serverId);
      }),
    disconnect: () => Effect.succeed(false),
    listServers: () => Effect.succeed([]),
    cancel: () => Effect.succeed(false),
  };

  return { adapter, registered, registerCalls, connectCalls, unregisterCalls };
};

const makeSettings = (settings: ServerSettings): CompositionMcpRuntimeServiceSettings => ({
  getSettings: Effect.succeed(settings),
  subscribeChanges: Effect.succeed(Stream.empty),
});

it.effect("reconciles configured MCP servers without connecting untrusted entries", () =>
  Effect.gen(function* () {
    const fake = makeFakeAdapter();
    const settings = settingsWithServers({
      local_tools: localServer,
      remote_tools: remoteServer,
    });
    const service = makeCompositionMcpRuntimeService({
      settings: makeSettings(settings),
      adapter: fake.adapter,
    });

    yield* service.reconcile(settings);

    assert.deepEqual(fake.connectCalls, ["local_tools"]);
    assert.deepEqual(fake.registerCalls[0], {
      serverId: "local_tools",
      name: "Local Tools",
      transport: "stdio",
      command: "node",
      args: ["server.mjs"],
      cwd: undefined,
      url: undefined,
      env: { MCP_TOKEN: "secret" },
      headers: { Authorization: "Bearer secret" },
      trusted: true,
      enabled: true,
    });
    assert.deepEqual(fake.registered.get("remote_tools"), {
      serverId: "remote_tools",
      name: "Remote Tools",
      transport: "http",
      command: undefined,
      args: [],
      cwd: undefined,
      url: "https://mcp.example.test",
      env: {},
      headers: {},
      trusted: false,
      enabled: true,
    });

    yield* service.reconcile(settingsWithServers({ remote_tools: remoteServer }));
    assert.deepEqual(fake.unregisterCalls, ["local_tools"]);
  }),
);

it.effect("重新注册配置发生变化的 MCP Server", () =>
  Effect.gen(function* () {
    const fake = makeFakeAdapter();
    const initial = settingsWithServers({ local_tools: localServer });
    const changed = settingsWithServers({
      local_tools: {
        ...localServer,
        args: ["changed-server.mjs"],
      },
    });
    const service = makeCompositionMcpRuntimeService({
      settings: makeSettings(initial),
      adapter: fake.adapter,
    });

    yield* service.reconcile(initial);
    yield* service.reconcile(changed);

    assert.deepEqual(fake.unregisterCalls, ["local_tools"]);
    assert.deepEqual(fake.connectCalls, ["local_tools", "local_tools"]);
    assert.deepEqual(fake.registerCalls.at(-1)?.args, ["changed-server.mjs"]);
  }),
);

it.effect("start 读取当前设置并建立变更订阅", () =>
  Effect.gen(function* () {
    const fake = makeFakeAdapter();
    const initial = settingsWithServers({ local_tools: localServer });
    const service = makeCompositionMcpRuntimeService({
      settings: makeSettings(initial),
      adapter: fake.adapter,
    });

    yield* service.start;

    assert.deepEqual(fake.connectCalls, ["local_tools"]);
    assert.deepEqual(
      fake.registerCalls.map((config) => config.serverId),
      ["local_tools"],
    );
  }),
);
