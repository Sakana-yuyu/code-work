import {
  type GrokSettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@codework/contracts";
import * as EffectAcpErrors from "effect-acp/errors";
import * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@codework/shared/observability";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createModelCapabilities } from "@codework/shared/model";
import { resolveSpawnCommand } from "@codework/shared/shell";
import { HostProcessEnvironment, HostProcessWorkingDirectory } from "@codework/shared/hostProcess";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  isValidGrokReasoningEffortToken,
  buildGrokAcpSpawnInput,
  resolveGrokAcpBaseModelId,
} from "../acp/GrokAcpSupport.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { discoverGrokSkills } from "../Drivers/GrokSkills.ts";
import {
  cliProviderCatalogIdentity,
  withCatalogAbortSignal,
  type CliProviderCatalog,
} from "../CliProviderCatalog.ts";
import {
  makeNativeProviderCatalog,
  type NativeProviderCatalog,
  type NativeProviderCatalogError,
} from "../NativeProviderCatalog.ts";

const GROK_PRESENTATION = {
  displayName: "Grok",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const GROK_REFRESH_TIMEOUT_MS = 15_000;
const GROK_MODELS_LIST_METHOD = "x.ai/models/list";
const decodeGrokModelsEnvelope = Schema.decodeUnknownEffect(
  Schema.Struct({
    result: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Unknown),
  }),
);
const decodeGrokModelState = Schema.decodeUnknownEffect(EffectAcpSchema.SessionModelState);

const GROK_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "grok-build",
    name: "Grok Build",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialGrokProviderSnapshot(
  grokSettings: GrokSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = grokModelsFromSettings(grokSettings.customModels);

    if (!grokSettings.enabled) {
      return buildServerProvider({
        presentation: GROK_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Grok is disabled in Code Work settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Grok CLI availability...",
      },
    });
  });
}

function grokModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = GROK_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function grokReasoningOptionsFromModel(model: EffectAcpSchema.ModelInfo): {
  readonly options: ReadonlyArray<{
    value: string;
    label: string;
    description?: string;
    isDefault?: boolean;
  }>;
  readonly currentValue: string | undefined;
} {
  const meta = model._meta;
  if (!meta || meta.supportsReasoningEffort === false) {
    return { options: [], currentValue: undefined };
  }

  const currentEffort = nonEmptyString(meta.reasoningEffort);
  const advertisedOptions = Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts : [];
  const seen = new Set<string>();
  const options: Array<{
    value: string;
    label: string;
    description?: string;
    advertisedDefault: boolean;
  }> = [];

  for (const entry of advertisedOptions) {
    if (!isRecord(entry)) {
      continue;
    }
    const rawValue = nonEmptyString(entry.value);
    const rawId = nonEmptyString(entry.id);
    const value =
      rawValue && isValidGrokReasoningEffortToken(rawValue)
        ? rawValue
        : rawId && isValidGrokReasoningEffortToken(rawId)
          ? rawId
          : undefined;
    if (value === undefined || seen.has(value)) {
      continue;
    }
    seen.add(value);
    const description = nonEmptyString(entry.description);
    options.push({
      value,
      label: nonEmptyString(entry.label) ?? value,
      ...(description ? { description } : {}),
      advertisedDefault: entry.default === true || entry.isDefault === true,
    });
  }

  const currentValue =
    currentEffort && options.some((option) => option.value === currentEffort)
      ? currentEffort
      : undefined;
  const advertisedDefaults = options.filter((option) => option.advertisedDefault);
  const selectedDefault =
    advertisedDefaults.find((option) => option.value === currentValue)?.value ??
    advertisedDefaults[0]?.value;
  return {
    options: options.map(({ value, label, description }) => ({
      value,
      label,
      ...(description ? { description } : {}),
      ...(value === selectedDefault ? { isDefault: true } : {}),
    })),
    currentValue: currentValue ?? selectedDefault,
  };
}

export function buildGrokModelCapabilities(model: EffectAcpSchema.ModelInfo): ModelCapabilities {
  const reasoning = grokReasoningOptionsFromModel(model);
  return reasoning.options.length > 0
    ? createModelCapabilities({
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: reasoning.options.map((option) => ({
              id: option.value,
              label: option.label,
              ...(option.description ? { description: option.description } : {}),
              ...(option.isDefault ? { isDefault: true } : {}),
            })),
            ...(reasoning.currentValue ? { currentValue: reasoning.currentValue } : {}),
          },
        ],
      })
    : EMPTY_CAPABILITIES;
}

function buildGrokDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const slug = resolveGrokAcpBaseModelId(model.modelId);
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        capabilities: buildGrokModelCapabilities(model),
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

const discoverGrokModelsViaAcp = (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // 目录探针和自己的 taskkill 使用有限清理宽限，会话路径保留默认策略。
    const probeSpawner = ChildProcessSpawner.make((command) =>
      childProcessSpawner.spawn(
        ChildProcess.isStandardCommand(command)
          ? ChildProcess.make(command.command, command.args, {
              ...command.options,
              forceKillAfter: "2 seconds",
            })
          : command,
      ),
    );
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn: { ...buildGrokAcpSpawnInput(grokSettings, cwd, environment), extendEnv: false },
        cwd,
        // 与 CLI 的目录命令一致：读目录只握手，不触发认证写入或创建会话。
        authMethodId: "",
        clientInfo: { name: "code-work-provider-probe", version: "0.0.0" },
      }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, probeSpawner))),
    );
    const acp = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(context),
    );
    yield* acp.prepareClient();
    const response = yield* acp.request(GROK_MODELS_LIST_METHOD, {});
    const envelope = yield* decodeGrokModelsEnvelope(response).pipe(
      Effect.mapError(() =>
        EffectAcpErrors.AcpRequestError.internalError("Grok 模型目录响应格式无效。"),
      ),
    );
    // 上游扩展在 JSON-RPC 结果中再包装 result/error；即使同时有模型也以错误为准。
    if (envelope.error !== undefined && envelope.error !== null) {
      return yield* EffectAcpErrors.AcpRequestError.internalError("Grok 模型目录请求失败。");
    }
    const modelState = yield* decodeGrokModelState(envelope.result).pipe(
      Effect.mapError(() =>
        EffectAcpErrors.AcpRequestError.internalError("Grok 模型目录数据无效。"),
      ),
    );
    return buildGrokDiscoveredModelsFromSessionModelState(modelState);
  }).pipe(Effect.scoped);

const runGrokVersionCommand = (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) =>
  Effect.gen(function* () {
    const command = grokSettings.binaryPath || "grok";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      cwd,
      env: environment,
      extendEnv: false,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd,
        env: environment,
        extendEnv: false,
        shell: spawnCommand.shell,
        forceKillAfter: "2 seconds",
      }),
    );
  });

/** 路由读取与模型覆盖都属于同一次准备；覆盖函数只使用本轮已读的配置。 */
export interface GrokCatalogPreparation {
  readonly configFileContents?: string | undefined;
  readonly mapSnapshot?: (snapshot: ServerProviderDraft) => ServerProviderDraft;
}

export const fetchGrokCatalog = Effect.fn("fetchGrokCatalog")(function* <
  E = never,
  R = never,
>(request: {
  readonly settings: GrokSettings;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly skillsWorkingDirectory?: string | undefined;
  readonly nativeCatalog?: NativeProviderCatalog | undefined;
  readonly configFileContents?: string | undefined;
  readonly preparationIdentity?: Readonly<Record<string, string | boolean | undefined>>;
  readonly prepare?: (signal: AbortSignal) => Effect.Effect<GrokCatalogPreparation, E, R>;
}): Effect.fn.Return<
  ServerProviderDraft,
  NativeProviderCatalogError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Exclude<R, Scope.Scope>
> {
  const input = {
    ...request,
    environment: request.environment ? { ...request.environment } : undefined,
    preparationIdentity: request.preparationIdentity
      ? { ...request.preparationIdentity }
      : undefined,
  };
  const grokSettings = { ...input.settings, customModels: [...input.settings.customModels] };
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const inheritedEnvironment = { ...(yield* HostProcessEnvironment) };
  if (input.environment) {
    for (const key of Object.keys(inheritedEnvironment)) {
      if (key.startsWith("CODEWORK_ACP_") && !Object.hasOwn(input.environment, key)) {
        delete inheritedEnvironment[key];
      }
    }
  }
  const processEnvironment = { ...inheritedEnvironment, ...input.environment };
  const modelWorkingDirectory = yield* HostProcessWorkingDirectory;
  const skillsWorkingDirectory = input.skillsWorkingDirectory ?? modelWorkingDirectory;
  const nativeSettings = { ...grokSettings, customModels: [] };
  const modelEnvironment =
    buildGrokAcpSpawnInput(nativeSettings, modelWorkingDirectory, processEnvironment).env ??
    processEnvironment;
  if (!grokSettings.enabled && !input.prepare) {
    return yield* buildInitialGrokProviderSnapshot(grokSettings);
  }
  const native = input.nativeCatalog ?? (yield* makeNativeProviderCatalog());
  let installed = false;
  let version: string | null = null;
  let skills: ServerProviderDraft["skills"] = [];
  let mapSnapshot: GrokCatalogPreparation["mapSnapshot"];
  const makeSnapshot = (
    status: "ready" | "error" | "warning",
    message?: string,
    models = grokModelsFromSettings([]),
  ) => {
    const snapshot = buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models,
      skills,
      probe: {
        installed,
        version,
        status,
        auth: { status: "unknown" },
        ...(message === undefined ? {} : { message }),
      },
    });
    return mapSnapshot ? mapSnapshot(snapshot) : snapshot;
  };
  const snapshot = yield* native.fetchCatalogWithError({
    key: cliProviderCatalogIdentity({
      driver: ProviderDriverKind.make("grok"),
      operation: "grok/provider-refresh",
      config: {
        binaryPath: nativeSettings.binaryPath || "grok",
        enabled: nativeSettings.enabled,
        skillsWorkingDirectory,
        modelEnvironment,
        configFileContents: input.configFileContents,
        preparationIdentity: input.preparationIdentity,
        hasPreparation: input.prepare !== undefined,
      },
      cwd: modelWorkingDirectory,
      environment: processEnvironment,
    }),
    timeoutMs: GROK_REFRESH_TIMEOUT_MS,
    onTimeout: () =>
      makeSnapshot("error", `Grok provider refresh timed out after ${GROK_REFRESH_TIMEOUT_MS}ms.`),
    load: (controller) =>
      withCatalogAbortSignal(
        Effect.gen(function* () {
          if (input.prepare) {
            const prepared = yield* input.prepare(controller.signal);
            mapSnapshot = prepared.mapSnapshot;
          }
          if (!nativeSettings.enabled) {
            return makeSnapshot("warning", "Grok is disabled in Code Work settings.");
          }
          const versionResult = yield* runGrokVersionCommand(
            nativeSettings,
            processEnvironment,
            modelWorkingDirectory,
          ).pipe(Effect.result);
          if (Result.isFailure(versionResult)) {
            const error = versionResult.failure;
            installed = !isCommandMissingCause(error);
            yield* Effect.logWarning("Grok CLI health check failed.", { errorTag: error._tag });
            return makeSnapshot(
              "error",
              isCommandMissingCause(error)
                ? "Grok CLI (`grok`) is not installed or not on PATH."
                : "Failed to execute Grok CLI health check.",
            );
          }
          installed = true;
          const output = versionResult.success;
          version = parseGenericCliVersion(`${output.stdout}\n${output.stderr}`);
          if (output.code !== 0)
            return makeSnapshot("error", "Grok CLI is installed but failed to run.");
          skills = yield* discoverGrokSkills(
            nativeSettings,
            processEnvironment,
            skillsWorkingDirectory,
            {
              signal: controller.signal,
              completeEnvironment: true,
            },
          );
          // 当前协议没有稳定账户身份。只共享整次在途工作，不保留未知身份模型完成值。
          const discovery = yield* withCatalogAbortSignal(
            discoverGrokModelsViaAcp(nativeSettings, modelEnvironment, modelWorkingDirectory),
            controller.signal,
          ).pipe(Effect.exit);
          if (Exit.isFailure(discovery)) {
            if (Cause.hasInterrupts(discovery.cause))
              return yield* Effect.failCause(discovery.cause);
            yield* Effect.logWarning("Grok ACP model discovery failed", {
              errorTag: causeErrorTag(discovery.cause),
            });
            return makeSnapshot(
              "error",
              "Grok CLI is installed but ACP model discovery failed. Update Grok CLI to a version supporting x.ai/models/list and check server logs for details.",
            );
          }
          return makeSnapshot(
            "ready",
            undefined,
            discovery.value.length > 0 ? discovery.value : grokModelsFromSettings([]),
          );
        }),
        controller.signal,
      ),
  });
  return {
    ...snapshot,
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    models:
      grokSettings.routeThroughByok && input.prepare
        ? snapshot.models
        : grokModelsFromSettings(grokSettings.customModels, snapshot.models),
  };
});

/** 旧状态入口仍可直接调用；有错误的路由准备只由完整目录入口接入。 */
export const checkGrokProviderStatus = (
  grokSettings: GrokSettings,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
  _catalog?: CliProviderCatalog,
  configFileContents?: string,
  nativeCatalog?: NativeProviderCatalog,
) =>
  fetchGrokCatalog({
    settings: grokSettings,
    environment,
    skillsWorkingDirectory: cwd,
    configFileContents,
    nativeCatalog,
  }).pipe(Effect.orDie);

export const enrichGrokSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Grok version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
