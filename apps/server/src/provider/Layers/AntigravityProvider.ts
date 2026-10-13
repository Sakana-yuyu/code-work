import {
  type AntigravitySettings,
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
import {
  cliProviderCatalogIdentity,
  makeCliProviderCatalog,
  type CliProviderCatalog,
} from "../CliProviderCatalog.ts";

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
  displayName: "Antigravity",
  badgeLabel: "CLI",
  showInteractionModeToggle: true,
} as const;
const EMPTY_MODELS: ReadonlyArray<ServerProviderModel> = [];
const CUSTOM_MODEL_CAPABILITIES = { optionDescriptors: [] } as const;

export const fetchAntigravityCatalog = Effect.fn("fetchAntigravityCatalog")(function* (
  settings: Pick<AntigravitySettings, "customModels">,
  catalog?: CliProviderCatalog,
) {
  // 目录只取配置模型；二进制、认证及环境变化留在实时健康检查中。
  const customModels = providerCustomModelSlugs(EMPTY_MODELS, settings.customModels);
  const providerCatalog = catalog ?? (yield* makeCliProviderCatalog());
  return yield* providerCatalog
    .fetchCatalog({
      key: cliProviderCatalogIdentity({
        driver: ProviderDriverKind.make("antigravity"),
        operation: "configured-models",
        config: { customModels, capabilities: CUSTOM_MODEL_CAPABILITIES },
      }),
      load: Effect.sync(() => ({
        models: providerModelsFromSettings(EMPTY_MODELS, customModels, CUSTOM_MODEL_CAPABILITIES),
      })),
    })
    .pipe(Effect.orDie);
});

export function resolveConfiguredAntigravityModel(
  settings: Pick<AntigravitySettings, "customModels">,
  requested: string | undefined,
): string | undefined {
  const model = requested?.trim();
  return model && settings.customModels.includes(model) ? model : undefined;
}

export const buildInitialAntigravityProviderSnapshot = Effect.fn(
  "buildInitialAntigravityProviderSnapshot",
)(function* (
  settings: AntigravitySettings,
  catalog?: CliProviderCatalog,
): Effect.fn.Return<ServerProviderDraft> {
  const now = yield* DateTime.now;
  const { models } = yield* fetchAntigravityCatalog(settings, catalog);
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
        ? "正在检查 Antigravity CLI；首次使用请运行 `agy` 完成官方登录。"
        : "Antigravity CLI 已在 Code Work 设置中禁用。",
    },
  });
});

export const checkAntigravityProviderStatus = Effect.fn("checkAntigravityProviderStatus")(
  function* (
    settings: AntigravitySettings,
    environment?: NodeJS.ProcessEnv,
    catalog?: CliProviderCatalog,
  ): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const { models } = yield* fetchAntigravityCatalog(settings, catalog);
    // 探测不受开关影响：禁用只决定状态文案，安装与否必须如实上报，
    // 否则已装 CLI 的禁用实例会一直挂着「安装 CLI」按钮。
    const probe = yield* Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const resolved = yield* resolveSpawnCommand(settings.binaryPath, ["--version"], {
        ...(environment ? { env: environment } : {}),
      });
      const child = yield* spawner.spawn(
        ChildProcess.make(resolved.command, resolved.args, {
          ...(environment ? { env: environment } : { extendEnv: true }),
          shell: resolved.shell,
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
          message: "Antigravity CLI 已在 Code Work 设置中禁用。",
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
            ? `Antigravity CLI ${settings.binaryPath} 未找到。`
            : "Antigravity CLI 版本检查失败。",
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
            ? "Antigravity CLI 已安装；首次使用运行 `agy` 完成官方登录。"
            : "Antigravity CLI 版本命令返回失败。",
      },
    });
  },
);

export function enrichAntigravitySnapshot(input: {
  readonly snapshot: ServerProvider;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<void> {
  return input.publishSnapshot(input.snapshot);
}
