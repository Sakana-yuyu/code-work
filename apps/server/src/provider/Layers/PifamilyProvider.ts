/**
 * pi-family（Pi / OhMyPi）共享快照构建。
 *
 * 两个 Provider 都以 BYOK 为唯一模型来源：模型列表来自网关路由
 * （openai + anthropic，gemini 不经网关），auth 固定上报 byok。
 *
 * @module provider/Layers/PifamilyProvider
 */
import {
  ProviderDriverKind,
  type PiAgentSettings,
  type OmpAgentSettings,
  type ZCodeAgentSettings,
  type ServerProvider,
  type ServerProviderModel,
} from "@codework/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@codework/shared/shell";
import { HostProcessEnvironment, HostProcessWorkingDirectory } from "@codework/shared/hostProcess";

import {
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  parseGenericCliVersion,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import type { PifamilyModelRoute } from "../pifamily/byokProviderConfig.ts";
import {
  cliProviderCatalogIdentity,
  makeCliProviderCatalog,
  type CliProviderCatalog,
  withCatalogAbortSignal,
} from "../CliProviderCatalog.ts";
import { makeNativeProviderCatalog, type NativeProviderCatalog } from "../NativeProviderCatalog.ts";

export type PifamilyDriverKind = "piAgent" | "ompAgent" | "zcodeAgent";

type PifamilySnapshotSettings = PiAgentSettings | OmpAgentSettings | ZCodeAgentSettings;

const PRESENTATIONS: Record<PifamilyDriverKind, { displayName: string; badgeLabel: string }> = {
  piAgent: { displayName: "Pi", badgeLabel: "BYOK" },
  ompAgent: { displayName: "OhMyPi", badgeLabel: "BYOK" },
  zcodeAgent: { displayName: "ZCode", badgeLabel: "BYOK" },
};

export function pifamilyProviderModels(
  routes: ReadonlyArray<Pick<PifamilyModelRoute, "adapterId" | "displayName" | "modelId">>,
): ReadonlyArray<ServerProviderModel> {
  return routes.map((route) => ({
    slug: route.adapterId,
    name: route.displayName,
    ...(route.modelId.trim().length > 0 ? { subProvider: route.modelId.trim() } : {}),
    isCustom: false,
    capabilities: null,
  }));
}

/** 目录只取实际呈现的路由字段；网关凭据、进程环境和实例身份留在运行时。 */
export const fetchPifamilyProviderCatalog = Effect.fn("fetchPifamilyProviderCatalog")(
  function* (input: {
    readonly driverKind: PifamilyDriverKind;
    readonly routes: ReadonlyArray<PifamilyModelRoute>;
    readonly catalog?: CliProviderCatalog;
  }) {
    const routes = input.routes.map(({ adapterId, displayName, modelId }) => ({
      adapterId,
      displayName,
      modelId: modelId.trim(),
    }));
    const catalog = input.catalog ?? (yield* makeCliProviderCatalog());
    return yield* catalog
      .fetchCatalog({
        key: cliProviderCatalogIdentity({
          driver: ProviderDriverKind.make(input.driverKind),
          operation: "configured-models",
          config: { routes },
        }),
        load: Effect.sync(() => ({ models: pifamilyProviderModels(routes) })),
      })
      .pipe(Effect.orDie);
  },
);

export const buildInitialPifamilyProviderSnapshot = Effect.fn(
  "buildInitialPifamilyProviderSnapshot",
)(function* (input: {
  readonly driverKind: PifamilyDriverKind;
  readonly settings: PifamilySnapshotSettings;
  readonly routes: ReadonlyArray<PifamilyModelRoute>;
  readonly catalog?: CliProviderCatalog;
}): Effect.fn.Return<ServerProviderDraft> {
  const { models } = yield* fetchPifamilyProviderCatalog(input);
  const now = yield* DateTime.now;
  return buildServerProvider({
    presentation: PRESENTATIONS[input.driverKind],
    enabled: input.settings.enabled,
    checkedAt: DateTime.formatIso(now),
    models,
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: input.settings.enabled
        ? "正在检查 CLI；模型由 BYOK 网关提供。"
        : "该供应商已在 Code Work 设置中禁用。",
    },
  });
});

interface PifamilyProbeInput {
  readonly driverKind: PifamilyDriverKind;
  readonly settings: PifamilySnapshotSettings;
  readonly routes: ReadonlyArray<PifamilyModelRoute>;
  readonly catalog?: CliProviderCatalog;
  readonly environment?: NodeJS.ProcessEnv;
  /** Driver 已清洗并补齐受管环境时，禁止重新继承被剥离的宿主变量。 */
  readonly completeEnvironment?: boolean;
  readonly spawnArgsPrefix?: ReadonlyArray<string>;
  readonly displayBinaryPath?: string;
  readonly assumeInstalled?: boolean;
}

const runPifamilyProviderProbe = Effect.fn("runPifamilyProviderProbe")(function* (input: {
  readonly driverKind: PifamilyDriverKind;
  readonly settings: PifamilySnapshotSettings;
  readonly routes: ReadonlyArray<PifamilyModelRoute>;
  readonly catalog?: CliProviderCatalog;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** 探针命令前置参数（ZCode 内嵌运行时的 bundle 路径）。 */
  readonly spawnArgsPrefix?: ReadonlyArray<string>;
  /** 探针用错误/文案里的命令标识（替代裸 binaryPath）。 */
  readonly displayBinaryPath?: string;
  /** 运行时常驻内置（如 vendored ZCode bundle）：跳过 spawn 探针直接视为已安装。 */
  readonly assumeInstalled?: boolean;
}): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const { models } = yield* fetchPifamilyProviderCatalog(input);
  const label = PRESENTATIONS[input.driverKind].displayName;

  // 禁用实例不启动 CLI 探针；启用后才验证安装状态。内嵌运行时
  // （vendored bundle 随包分发）不存在"CLI 未安装"状态，直接跳过探针。
  const probe = !input.settings.enabled
    ? Result.succeed({ stdout: "", stderr: "", code: 1 })
    : input.assumeInstalled === true
      ? Result.succeed({ stdout: "", stderr: "", code: 0 })
      : yield* Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const resolved = yield* resolveSpawnCommand(
            input.settings.binaryPath,
            [...(input.spawnArgsPrefix ?? []), "--version"],
            { cwd: input.cwd, env: input.environment, extendEnv: false },
          );
          const child = yield* spawner.spawn(
            ChildProcess.make(resolved.command, resolved.args, {
              // 完整入口已经捕获宿主与受管变量；解析和执行不能再次继承不同环境。
              cwd: input.cwd,
              env: input.environment,
              extendEnv: false,
              shell: resolved.shell,
              forceKillAfter: "2 seconds",
            }),
          );
          const [stdout, stderr, code] = yield* Effect.all(
            [
              collectStreamAsString(child.stdout),
              collectStreamAsString(child.stderr),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          return { stdout, stderr, code: Number(code) };
        }).pipe(Effect.scoped, Effect.result);

  if (!input.settings.enabled) {
    return buildServerProvider({
      presentation: PRESENTATIONS[input.driverKind],
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: Result.isSuccess(probe) && probe.success.code === 0,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: `${label} 已在 Code Work 设置中禁用。`,
      },
    });
  }

  if (Result.isFailure(probe)) {
    return buildServerProvider({
      presentation: PRESENTATIONS[input.driverKind],
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause(probe.failure),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(probe.failure)
          ? `${label} CLI ${input.displayBinaryPath ?? input.settings.binaryPath} 未找到。`
          : `${label} CLI 版本检查失败。`,
      },
    });
  }

  const version = parseGenericCliVersion(`${probe.success.stdout}\n${probe.success.stderr}`);
  const noRoutes = input.routes.length === 0;
  return buildServerProvider({
    presentation: PRESENTATIONS[input.driverKind],
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: probe.success.code === 0,
      version,
      status: probe.success.code === 0 ? (noRoutes ? "warning" : "ready") : "error",
      auth: noRoutes
        ? { status: "unknown" }
        : { status: "authenticated", type: "byok", label: "BYOK Gateway" },
      message:
        input.assumeInstalled === true
          ? noRoutes
            ? `${label} 运行时已内置；BYOK 网关没有可用的 OpenAI/Anthropic 模型通道。`
            : `${label} 运行时已内置；模型由 BYOK 网关提供。`
          : noRoutes
            ? `${label} CLI 已安装，但 BYOK 网关没有可用的 OpenAI/Anthropic 模型通道。`
            : probe.success.code === 0
              ? `${label} CLI 已安装；模型由 BYOK 网关提供。`
              : `${label} CLI 版本命令返回失败。`,
    },
  });
});

/** 路由准备、配置目录、版本及官方凭据共用完整刷新所有权，回调不携带实例身份。 */
export const fetchPifamilyRefreshCatalog = Effect.fn("fetchPifamilyRefreshCatalog")(function* (
  request: PifamilyProbeInput & {
    readonly nativeCatalog?: NativeProviderCatalog;
    readonly preparationIdentity?: Readonly<Record<string, string | boolean | undefined>>;
    readonly prepareRoutes?: (
      signal: AbortSignal,
    ) => Effect.Effect<ReadonlyArray<PifamilyModelRoute>>;
    readonly finish?: (
      draft: ServerProviderDraft,
      signal: AbortSignal,
    ) => Effect.Effect<ServerProviderDraft>;
  },
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const input = {
    ...request,
    settings: { ...request.settings },
    routes: request.routes.map((route) => ({ ...route })),
    ...(request.spawnArgsPrefix === undefined
      ? {}
      : { spawnArgsPrefix: [...request.spawnArgsPrefix] }),
    ...(request.environment === undefined ? {} : { environment: { ...request.environment } }),
    ...(request.preparationIdentity === undefined
      ? {}
      : { preparationIdentity: { ...request.preparationIdentity } }),
  };
  const environment = input.completeEnvironment
    ? { ...input.environment }
    : { ...(yield* HostProcessEnvironment), ...input.environment };
  const cwd = yield* HostProcessWorkingDirectory;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const native = input.nativeCatalog ?? (yield* makeNativeProviderCatalog());
  let routes: ReadonlyArray<PifamilyModelRoute> = input.routes;
  let latest: ServerProviderDraft | undefined;
  const snapshot = yield* native.fetchCatalog({
    key: cliProviderCatalogIdentity({
      driver: ProviderDriverKind.make(input.driverKind),
      operation: "pifamily/provider-refresh",
      config: {
        binaryPath: input.settings.binaryPath,
        enabled: input.settings.enabled,
        spawnArgsPrefix: input.spawnArgsPrefix,
        displayBinaryPath: input.displayBinaryPath,
        assumeInstalled: input.assumeInstalled,
        routes: input.routes.map(({ adapterId, displayName, modelId }) => ({
          adapterId,
          displayName,
          modelId: modelId.trim(),
        })),
        preparationIdentity: input.preparationIdentity,
        hasPreparation: input.prepareRoutes !== undefined,
        hasFinish: input.finish !== undefined,
      },
      cwd,
      environment,
    }),
    timeoutMs: 15_000,
    onTimeout: () =>
      buildServerProvider({
        presentation: PRESENTATIONS[input.driverKind],
        enabled: input.settings.enabled,
        checkedAt,
        models: latest?.models ?? pifamilyProviderModels(routes),
        probe: {
          installed: latest?.installed ?? false,
          version: latest?.version ?? null,
          status: "error",
          auth: { status: "unknown" },
          message: `${PRESENTATIONS[input.driverKind].displayName} 目录刷新在15000ms工作预算内未完成。`,
        },
      }),
    load: (controller) =>
      withCatalogAbortSignal(
        Effect.gen(function* () {
          if (input.prepareRoutes)
            routes = (yield* input.prepareRoutes(controller.signal)).map((route) => ({ ...route }));
          latest = yield* runPifamilyProviderProbe({ ...input, routes, environment, cwd });
          if (input.finish) latest = yield* input.finish(latest, controller.signal);
          return latest;
        }),
        controller.signal,
      ),
  });
  return { ...snapshot, checkedAt: DateTime.formatIso(yield* DateTime.now) };
});

/** 旧健康入口的配置参数保持兼容，统一转入完整刷新。 */
export const checkPifamilyProviderStatus = (
  input: PifamilyProbeInput & { readonly nativeCatalog?: NativeProviderCatalog },
) => fetchPifamilyRefreshCatalog(input);

export function enrichPifamilySnapshot(input: {
  readonly snapshot: ServerProvider;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<void> {
  return input.publishSnapshot(input.snapshot);
}
