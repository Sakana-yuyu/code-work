import {
  type KimiSettings,
  ProviderDriverKind,
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
  cliProviderCatalogIdentity,
  makeCliProviderCatalog,
  type CliProviderCatalog,
  withCatalogAbortSignal,
} from "../CliProviderCatalog.ts";
import { makeNativeProviderCatalog, type NativeProviderCatalog } from "../NativeProviderCatalog.ts";

import {
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  providerCustomModelSlugs,
  providerModelsFromSettings,
  parseGenericCliVersion,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PRESENTATION = {
  displayName: "Kimi",
  badgeLabel: "ACP",
  showInteractionModeToggle: true,
} as const;

const EMPTY_MODELS: ReadonlyArray<ServerProviderModel> = [];
const CUSTOM_MODEL_CAPABILITIES = { optionDescriptors: [] } as const;

export const fetchKimiCatalog = Effect.fn("fetchKimiCatalog")(function* (
  settings: Pick<KimiSettings, "customModels">,
  catalog?: CliProviderCatalog,
) {
  // 键与加载器共用本次数组快照，后续设置编辑不会污染已经发布的目录。
  const customModels = providerCustomModelSlugs(EMPTY_MODELS, settings.customModels);
  const providerCatalog = catalog ?? (yield* makeCliProviderCatalog());
  return yield* providerCatalog
    .fetchCatalog({
      key: cliProviderCatalogIdentity({
        driver: ProviderDriverKind.make("kimi"),
        operation: "configured-models",
        config: { customModels, capabilities: CUSTOM_MODEL_CAPABILITIES },
      }),
      load: Effect.sync(() => ({
        models: providerModelsFromSettings(EMPTY_MODELS, customModels, CUSTOM_MODEL_CAPABILITIES),
      })),
    })
    .pipe(Effect.orDie);
});

export const buildInitialKimiProviderSnapshot = Effect.fn("buildInitialKimiProviderSnapshot")(
  function* (
    settings: KimiSettings,
    catalog?: CliProviderCatalog,
  ): Effect.fn.Return<ServerProviderDraft> {
    const now = yield* DateTime.now;
    const { models } = yield* fetchKimiCatalog(settings, catalog);
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(now),
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "正在检查 Kimi CLI；官方登录请运行 `kimi login`。"
          : "Kimi CLI 已在 Code Work 设置中禁用。",
      },
    });
  },
);

const runKimiProviderProbe = Effect.fn("runKimiProviderProbe")(function* (
  settings: KimiSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  catalog?: CliProviderCatalog,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const { models } = yield* fetchKimiCatalog(settings, catalog);
  // 探测不受开关影响：禁用只决定状态文案，安装与否必须如实上报，
  // 否则已装 CLI 的禁用实例会一直挂着「安装 CLI」按钮。
  const probe = yield* Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const resolved = yield* resolveSpawnCommand(settings.binaryPath, ["--version"], {
      cwd,
      env: environment,
      extendEnv: false,
    });
    const child = yield* spawner.spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        cwd,
        env: environment,
        extendEnv: false,
        shell: resolved.shell,
        forceKillAfter: "2 seconds",
      }),
    );
    const [stdout, stderr, code] = yield* Effect.all(
      [collectStreamAsString(child.stdout), collectStreamAsString(child.stderr), child.exitCode],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, code: Number(code) };
  }).pipe(Effect.scoped, Effect.result);
  if (!settings.enabled) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: Result.isSuccess(probe) && probe.success.code === 0,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Kimi CLI 已在 Code Work 设置中禁用。",
      },
    });
  }

  if (Result.isFailure(probe)) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause(probe.failure),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(probe.failure)
          ? `Kimi CLI ${settings.binaryPath} 未找到。`
          : "Kimi CLI 版本检查失败。",
      },
    });
  }

  const version = parseGenericCliVersion(`${probe.success.stdout}\n${probe.success.stderr}`);
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: probe.success.code === 0,
      version,
      status: probe.success.code === 0 ? "warning" : "error",
      auth: { status: "unknown" },
      message:
        probe.success.code === 0
          ? "Kimi CLI 已安装；认证状态由 ACP 会话确认，请运行 `kimi login` 完成官方登录。"
          : "Kimi CLI 版本命令返回失败。",
    },
  });
});

/** 路由准备、配置目录和版本探针由一次完整加载持有，不在发布前追加异步尾读。 */
export const fetchKimiProviderCatalog = Effect.fn("fetchKimiProviderCatalog")(function* (request: {
  readonly settings: KimiSettings;
  readonly environment?: NodeJS.ProcessEnv;
  readonly catalog?: CliProviderCatalog;
  readonly nativeCatalog?: NativeProviderCatalog;
  readonly preparationIdentity?: Readonly<Record<string, string | boolean | undefined>>;
  readonly prepare?: (
    signal: AbortSignal,
  ) => Effect.Effect<(snapshot: ServerProviderDraft) => ServerProviderDraft>;
}): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const settings = { ...request.settings, customModels: [...request.settings.customModels] };
  const explicitEnvironment = request.environment ? { ...request.environment } : undefined;
  const preparationIdentity = request.preparationIdentity
    ? { ...request.preparationIdentity }
    : undefined;
  const prepare = request.prepare;
  const catalog = request.catalog;
  const suppliedNative = request.nativeCatalog;
  const environment = { ...(yield* HostProcessEnvironment), ...explicitEnvironment };
  const cwd = yield* HostProcessWorkingDirectory;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const native = suppliedNative ?? (yield* makeNativeProviderCatalog());
  let mapSnapshot: ((snapshot: ServerProviderDraft) => ServerProviderDraft) | undefined;
  const snapshot = yield* native.fetchCatalog({
    key: cliProviderCatalogIdentity({
      driver: ProviderDriverKind.make("kimi"),
      operation: "kimi/provider-refresh",
      config: {
        binaryPath: settings.binaryPath,
        enabled: settings.enabled,
        customModels: providerCustomModelSlugs(EMPTY_MODELS, settings.customModels),
        preparationIdentity,
        hasPreparation: prepare !== undefined,
      },
      cwd,
      environment,
    }),
    timeoutMs: 15_000,
    onTimeout: () => {
      const draft = buildServerProvider({
        presentation: PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: providerModelsFromSettings(
          EMPTY_MODELS,
          settings.customModels,
          CUSTOM_MODEL_CAPABILITIES,
        ),
        probe: {
          installed: false,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Kimi CLI 目录刷新在15000ms工作预算内未完成。",
        },
      });
      return mapSnapshot ? mapSnapshot(draft) : draft;
    },
    load: (controller) =>
      withCatalogAbortSignal(
        Effect.gen(function* () {
          if (prepare) mapSnapshot = yield* prepare(controller.signal);
          const draft = yield* runKimiProviderProbe(settings, environment, cwd, catalog);
          return mapSnapshot ? mapSnapshot(draft) : draft;
        }),
        controller.signal,
      ),
  });
  return { ...snapshot, checkedAt: DateTime.formatIso(yield* DateTime.now) };
});

/** 旧状态调用保持参数兼容，完整加载所有权可以由注册表注入。 */
export const checkKimiProviderStatus = (
  settings: KimiSettings,
  environment?: NodeJS.ProcessEnv,
  catalog?: CliProviderCatalog,
  nativeCatalog?: NativeProviderCatalog,
) =>
  fetchKimiProviderCatalog({
    settings,
    ...(environment === undefined ? {} : { environment }),
    ...(catalog === undefined ? {} : { catalog }),
    ...(nativeCatalog === undefined ? {} : { nativeCatalog }),
  });

export function enrichKimiSnapshot(input: {
  readonly snapshot: ServerProvider;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<void> {
  return input.publishSnapshot(input.snapshot);
}
