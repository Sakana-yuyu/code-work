import { createHash } from "node:crypto";

import type { ServerSettings } from "@codework/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../serverSettings.ts";
import {
  CompositionMcpRuntimeAdapterService,
  type CompositionMcpRuntimeServerState,
  type CompositionMcpRuntimeAdapterShape,
  type CompositionMcpRuntimeServerConfig,
} from "./CompositionMcpRuntimeAdapter.ts";

export type CompositionMcpRuntimeServiceSettings = Pick<
  ServerSettingsService["Service"],
  "getSettings" | "subscribeChanges"
>;

export type CompositionMcpRuntimeServiceOptions = {
  readonly settings: CompositionMcpRuntimeServiceSettings;
  readonly adapter: CompositionMcpRuntimeAdapterShape;
  readonly logWarning?: (message: string, cause?: unknown) => Effect.Effect<void>;
};

export type CompositionMcpRuntimeServiceShape = {
  readonly reconcile: (settings: ServerSettings) => Effect.Effect<void>;
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly listServers: () => Effect.Effect<ReadonlyArray<CompositionMcpRuntimeServerState>>;
  readonly connectServer: (
    serverId: string,
  ) => Effect.Effect<void, import("./CompositionMcpRuntimeAdapter.ts").CompositionMcpRuntimeError>;
  readonly disconnectServer: (serverId: string) => Effect.Effect<boolean>;
  readonly refreshServer: (
    serverId: string,
  ) => Effect.Effect<void, import("./CompositionMcpRuntimeAdapter.ts").CompositionMcpRuntimeError>;
};

export class CompositionMcpRuntimeService extends Context.Service<
  CompositionMcpRuntimeService,
  CompositionMcpRuntimeServiceShape
>()("t3/composition/CompositionMcpRuntimeService") {}

type ManagedServer = {
  readonly fingerprint: string;
};

const defaultLogWarning = (message: string, cause?: unknown): Effect.Effect<void> =>
  Effect.logWarning(message, {
    cause: cause instanceof Error ? cause.message : cause === undefined ? undefined : String(cause),
  });

const asRecord = (
  values: ReadonlyArray<{ readonly name: string; readonly value: string }>,
  kind: "header" | "environment",
): Readonly<Record<string, string>> => {
  const result: Record<string, string> = {};
  for (const entry of values) {
    if (result[entry.name] !== undefined) {
      throw new Error(`MCP ${kind} '${entry.name}' 重复。`);
    }
    result[entry.name] = entry.value;
  }
  return result;
};

const toRuntimeConfig = (
  serverId: string,
  config: ServerSettings["mcpServers"][string],
): CompositionMcpRuntimeServerConfig => ({
  serverId,
  name: config.name,
  transport: config.transport,
  command: config.command,
  args: [...(config.args ?? [])],
  cwd: config.cwd,
  url: config.url,
  env: asRecord(config.environment, "environment"),
  headers: asRecord(config.headers, "header"),
  trusted: config.trusted,
  enabled: config.enabled,
});

const fingerprintFor = (config: CompositionMcpRuntimeServerConfig): string =>
  createHash("sha256").update(JSON.stringify(config)).digest("hex");

const effectValue = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A | undefined> =>
  effect.pipe(Effect.catch(() => Effect.succeed(undefined)));

export const makeCompositionMcpRuntimeService = (
  options: CompositionMcpRuntimeServiceOptions,
): CompositionMcpRuntimeServiceShape => {
  const managed = new Map<string, ManagedServer>();
  const logWarning = options.logWarning ?? defaultLogWarning;
  let started = false;

  const warn = (message: string, cause?: unknown) =>
    logWarning(message, cause).pipe(Effect.catch(() => Effect.void));

  const reconcile = (settings: ServerSettings): Effect.Effect<void> =>
    Effect.gen(function* () {
      const configured = new Map<string, CompositionMcpRuntimeServerConfig>();
      for (const [serverId, config] of Object.entries(settings.mcpServers)) {
        try {
          configured.set(serverId, toRuntimeConfig(serverId, config));
        } catch (cause) {
          yield* warn(`跳过无效的 MCP Server 配置 '${serverId}'。`, cause);
        }
      }

      for (const [serverId, current] of managed) {
        const next = configured.get(serverId);
        if (next !== undefined && fingerprintFor(next) === current.fingerprint) {
          configured.delete(serverId);
          continue;
        }

        const removed = yield* effectValue(options.adapter.unregisterServer(serverId));
        if (removed === undefined) {
          yield* warn(`注销 MCP Server '${serverId}' 失败。`);
          continue;
        }
        managed.delete(serverId);
      }

      for (const [serverId, config] of configured) {
        const registered = yield* options.adapter.registerServer(config).pipe(
          Effect.as(true),
          Effect.catch((cause) =>
            warn(`注册 MCP Server '${serverId}' 失败。`, cause).pipe(Effect.as(false)),
          ),
        );
        if (!registered) continue;

        const fingerprint = fingerprintFor(config);
        managed.set(serverId, { fingerprint });

        if (config.enabled !== true || config.trusted !== true) continue;

        yield* options.adapter
          .connect(serverId)
          .pipe(
            Effect.catch((cause) =>
              warn(`连接 MCP Server '${serverId}' 失败，其他 Server 继续启动。`, cause),
            ),
          );
      }
    });

  const start: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    if (started) return;
    started = true;

    const currentSettings = yield* options.settings.getSettings.pipe(
      Effect.catch((cause) =>
        warn("读取 MCP Server 设置失败，跳过初始连接。", cause).pipe(Effect.as(undefined)),
      ),
    );
    if (currentSettings !== undefined) yield* reconcile(currentSettings);

    const changes = yield* options.settings.subscribeChanges;
    yield* Effect.forkScoped(
      Stream.runForEach(changes, (nextSettings) =>
        reconcile(nextSettings).pipe(
          Effect.catch((cause) => warn("MCP Server 设置刷新失败。", cause)),
        ),
      ),
    );
  });

  return {
    reconcile,
    start,
    listServers: options.adapter.listServers,
    connectServer: options.adapter.connect,
    disconnectServer: options.adapter.disconnect,
    refreshServer: (serverId) =>
      options.adapter.disconnect(serverId).pipe(Effect.andThen(options.adapter.connect(serverId))),
  };
};

const live = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const adapter = yield* CompositionMcpRuntimeAdapterService;
  return makeCompositionMcpRuntimeService({ settings, adapter });
});

export const layer = Layer.effect(CompositionMcpRuntimeService, live);
