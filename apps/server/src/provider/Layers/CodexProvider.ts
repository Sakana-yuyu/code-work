import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Types from "effect/Types";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as CodexErrors from "effect-codex-app-server/errors";

import type {
  CodexSettings,
  ServerProvider,
  ServerProviderState,
  ModelCapabilities,
  ProviderOptionDescriptor,
  ServerProviderModel,
  ServerProviderSkill,
} from "@codework/contracts";
import {
  PREFERRED_DEFAULT_CODEX_MODELS,
  ProviderDriverKind,
  ServerSettingsError,
} from "@codework/contracts";

import { createModelCapabilities } from "@codework/shared/model";
import { HostProcessEnvironment, HostProcessWorkingDirectory } from "@codework/shared/hostProcess";
import { resolveSpawnCommand } from "@codework/shared/shell";
import { codexAppServerArgs, resolveCodexLaunchArgs } from "./codexLaunchArgs.ts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import packageJson from "../../../package.json" with { type: "json" };
import {
  cliProviderCatalogIdentity,
  makeCliProviderCatalog,
  type CliProviderCatalog,
} from "../CliProviderCatalog.ts";
import { makeNativeProviderCatalog, type NativeProviderCatalog } from "../NativeProviderCatalog.ts";
import { requestCodexCollaborationModes } from "../CodexCollaborationModes.ts";
const isCodexAppServerSpawnError = Schema.is(CodexErrors.CodexAppServerSpawnError);
const isCodexAppServerError = Schema.is(CodexErrors.CodexAppServerError);

const CODEX_APP_SERVER_PROBE_FORCE_KILL_AFTER = "2 seconds" as const;

export const CODEX_INSTALLATION_DAMAGED_MESSAGE =
  "Codex CLI installation appears incomplete or damaged. Repair it from Provider settings, then refresh status.";

// The `codex` launcher shim fails fast with
// "Missing optional dependency @openai/codex-<platform>" when npm dropped the
// platform package — the one CLI-broken signature a reinstall reliably fixes.
const CODEX_MISSING_PLATFORM_PACKAGE_PATTERN = /missing optional dependency @openai\/codex-/i;

const CODEX_PRESENTATION = {
  displayName: "Codex",
  showInteractionModeToggle: false,
} as const;

export interface CodexAppServerProviderSnapshot {
  readonly account: CodexSchema.V2GetAccountResponse;
  readonly version: string | undefined;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly catalogMessage?: string;
}

const REASONING_EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

const DEFAULT_SERVICE_TIER_ID = "default";

function reasoningEffortLabel(reasoningEffort: string): string {
  return REASONING_EFFORT_LABELS[reasoningEffort] ?? reasoningEffort;
}

function codexAccountAuthLabel(account: CodexSchema.V2GetAccountResponse["account"]) {
  if (!account) return undefined;
  if (account.type === "apiKey") return "OpenAI API Key";
  if (account.type === "amazonBedrock") return "Amazon Bedrock";
  if (account.type !== "chatgpt") return undefined;

  switch (account.planType) {
    case "free":
      return "ChatGPT Free Subscription";
    case "go":
      return "ChatGPT Go Subscription";
    case "plus":
      return "ChatGPT Plus Subscription";
    case "pro":
      return "ChatGPT Pro 20x Subscription";
    case "prolite":
      return "ChatGPT Pro 5x Subscription";
    case "team":
      return "ChatGPT Team Subscription";
    case "self_serve_business_prolite":
    case "self_serve_business_usage_based":
    case "business":
      return "ChatGPT Business Subscription";
    case "ent26":
    case "enterprise_cbp_automation":
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "ChatGPT Enterprise Subscription";
    case "edu":
    case "edu_plus":
    case "edu_pro":
      return "ChatGPT Edu Subscription";
    case "unknown":
      return "ChatGPT Subscription";
    default:
      account.planType satisfies never;
      return undefined;
  }
}

function codexAccountEmail(account: CodexSchema.V2GetAccountResponse["account"]) {
  if (!account || account.type !== "chatgpt") return undefined;
  return account.email;
}

export function mapCodexModelCapabilities(
  model: CodexSchema.V2ModelListResponse__Model,
): ModelCapabilities {
  const reasoningOptions = model.supportedReasoningEfforts.map(({ reasoningEffort }) =>
    reasoningEffort === model.defaultReasoningEffort
      ? {
          id: reasoningEffort,
          label: reasoningEffortLabel(reasoningEffort),
          isDefault: true,
        }
      : {
          id: reasoningEffort,
          label: reasoningEffortLabel(reasoningEffort),
        },
  );
  const defaultReasoning = reasoningOptions.find((option) => option.isDefault)?.id;
  const serviceTiers =
    model.serviceTiers && model.serviceTiers.length > 0
      ? model.serviceTiers
      : (model.additionalSpeedTiers ?? []).map((id) => ({
          id,
          name: id === "fast" ? "Fast" : id,
          description: "",
        }));
  const catalogDefaultServiceTier = serviceTiers.some(
    (tier) => tier.id === model.defaultServiceTier,
  )
    ? model.defaultServiceTier
    : null;
  const defaultServiceTier = catalogDefaultServiceTier ?? DEFAULT_SERVICE_TIER_ID;
  const optionDescriptors: ProviderOptionDescriptor[] = [];

  if (reasoningOptions.length > 0) {
    optionDescriptors.push({
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: reasoningOptions,
      ...(defaultReasoning ? { currentValue: defaultReasoning } : {}),
    });
  }
  if (serviceTiers.length > 0) {
    optionDescriptors.push({
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        {
          id: DEFAULT_SERVICE_TIER_ID,
          label: "Standard",
          ...(defaultServiceTier === DEFAULT_SERVICE_TIER_ID ? { isDefault: true } : {}),
        },
        ...serviceTiers.map((tier) => ({
          id: tier.id,
          label: tier.name,
          ...(tier.description ? { description: tier.description } : {}),
          ...(defaultServiceTier === tier.id ? { isDefault: true } : {}),
        })),
      ],
      currentValue: defaultServiceTier,
    });
  }

  return createModelCapabilities({
    optionDescriptors,
  });
}

const toDisplayName = (model: CodexSchema.V2ModelListResponse__Model): string => {
  // Capitalize 'gpt' to 'GPT-' and capitalize any letter following a dash
  return model.displayName
    .replace(/^gpt/i, "GPT") // Handle start with 'gpt' or 'GPT'
    .replace(/-([a-z])/g, (_, c) => "-" + c.toUpperCase());
};

function parseCodexModelListResponse(
  response: CodexSchema.V2ModelListResponse,
): ReadonlyArray<ServerProviderModel> {
  return response.data.map((model) => ({
    slug: model.model,
    name: toDisplayName(model),
    isCustom: false,
    ...(model.isDefault ? { isDefault: true } : {}),
    capabilities: mapCodexModelCapabilities(model),
  }));
}

/**
 * Prefer our own default-model ranking when one of the preferred slugs is in
 * the live catalog; otherwise keep whatever Codex itself flagged as default.
 */
export function applyPreferredCodexDefaultModel(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const preferredSlug = PREFERRED_DEFAULT_CODEX_MODELS.find((slug) =>
    models.some((model) => model.slug === slug && !model.isCustom),
  );
  if (!preferredSlug) {
    return models;
  }
  return models.map((model) => {
    if (model.slug === preferredSlug) {
      return model.isDefault ? model : { ...model, isDefault: true };
    }
    if (!model.isDefault) {
      return model;
    }
    const { isDefault: _isDefault, ...rest } = model;
    return rest;
  });
}

function appendCustomCodexModels(
  models: ReadonlyArray<ServerProviderModel>,
  customModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  if (customModels.length === 0) {
    return models;
  }

  const seen = new Set(models.map((model) => model.slug));
  const fallbackCapabilities = models.find((model) => model.capabilities)?.capabilities ?? null;
  const customEntries: ServerProviderModel[] = [];
  for (const rawModel of customModels) {
    const slug = rawModel.trim();
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    customEntries.push({
      slug,
      name: slug,
      isCustom: true,
      capabilities: fallbackCapabilities,
    });
  }
  return customEntries.length === 0 ? models : [...models, ...customEntries];
}

function parseCodexSkillsListResponse(
  response: CodexSchema.V2SkillsListResponse,
  cwd: string,
): ReadonlyArray<ServerProviderSkill> {
  const matchingEntry = response.data.find((entry) => entry.cwd === cwd);
  const skills = matchingEntry
    ? matchingEntry.skills
    : response.data.flatMap((entry) => entry.skills);

  return skills.map((skill) => {
    const shortDescription =
      skill.shortDescription ?? skill.interface?.shortDescription ?? undefined;

    const parsedSkill: Types.Mutable<ServerProviderSkill> = {
      name: skill.name,
      path: skill.path,
      enabled: skill.enabled,
    };

    if (skill.description) {
      parsedSkill.description = skill.description;
    }
    if (skill.scope) {
      parsedSkill.scope = skill.scope;
    }
    if (skill.interface?.displayName) {
      parsedSkill.displayName = skill.interface.displayName;
    }
    if (shortDescription) {
      parsedSkill.shortDescription = shortDescription;
    }

    return parsedSkill;
  });
}

const requestAllCodexModels = Effect.fn("requestAllCodexModels")(function* (
  client: CodexClient.CodexAppServerClient["Service"],
) {
  const models: ServerProviderModel[] = [];
  let cursor: string | null | undefined = undefined;

  do {
    const response: CodexSchema.V2ModelListResponse = yield* client.request(
      "model/list",
      cursor ? { cursor } : {},
    );
    models.push(...parseCodexModelListResponse(response));
    cursor = response.nextCursor;
  } while (cursor);

  return models;
});

export function buildCodexInitializeParams(): CodexSchema.V1InitializeParams {
  return {
    clientInfo: {
      name: "codework_desktop",
      title: "Code Work Desktop",
      version: packageJson.version,
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

interface CodexProviderProbeInput {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly launchArgs?: string;
  readonly cwd: string;
  readonly customModels?: ReadonlyArray<string>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly catalog?: CliProviderCatalog;
  readonly signal?: AbortSignal;
}

const makeCodexProviderProbeClient = Effect.fn("makeCodexProviderProbeClient")(function* (
  input: Pick<CodexProviderProbeInput, "binaryPath" | "launchArgs" | "cwd"> & {
    readonly environment: NodeJS.ProcessEnv;
  },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = input.environment;
  const spawnCommand = yield* resolveSpawnCommand(
    input.binaryPath,
    codexAppServerArgs(input.launchArgs),
    {
      env: environment,
      extendEnv: false,
      cwd: input.cwd,
    },
  );
  yield* Effect.annotateCurrentSpan({
    "codex.binary_path": input.binaryPath,
    "codex.spawn_command": spawnCommand.command,
    "codex.spawn_shell": spawnCommand.shell,
    "codex.path_present": Boolean(environment.PATH ?? environment.Path ?? environment.path),
  });
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: input.cwd,
        env: environment,
        extendEnv: false,
        forceKillAfter: CODEX_APP_SERVER_PROBE_FORCE_KILL_AFTER,
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new CodexErrors.CodexAppServerSpawnError({
            command: `${input.binaryPath} app-server`,
            cause,
          }),
      ),
    );
  const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));
  const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
    Effect.provide(clientContext),
  );

  const initialize = yield* client.request("initialize", {
    clientInfo: {
      name: "codework_desktop",
      title: "Code Work Desktop",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  });
  yield* client.notify("initialized", undefined);

  // Extract the version string after the first '/' in userAgent, up to the next space or the end
  const versionMatch = initialize.userAgent.match(/\/([^\s]+)/);
  const version = versionMatch ? versionMatch[1] : undefined;
  return { client, version };
});

/** 独立调用自有进程；整次原生刷新传入已有 client，仅复用完成目录，不另建共享所有者。 */
export const fetchCodexCatalog = Effect.fn("fetchCodexCatalog")(function* (
  input: Pick<CodexProviderProbeInput, "binaryPath" | "launchArgs" | "cwd"> & {
    readonly environment: NodeJS.ProcessEnv;
    readonly version: string | undefined;
    readonly account: CodexSchema.V2GetAccountResponse;
    readonly catalog: CliProviderCatalog;
    readonly client?: CodexClient.CodexAppServerClient["Service"];
  },
) {
  const probeInput = {
    binaryPath: input.binaryPath,
    ...(input.launchArgs === undefined ? {} : { launchArgs: input.launchArgs }),
    cwd: input.cwd,
    environment: { ...input.environment },
  };
  // 协议未提供 API Key / Bedrock 的稳定身份；同 home 换凭据不能命中旧目录。
  const account = input.account.account;
  const existingClient = input.client;
  const canReuseCompleted = account?.type === "chatgpt" && Boolean(account.email?.trim());
  return yield* input.catalog
    .fetchCatalog({
      ...(!canReuseCompleted ? { forceRefresh: true } : {}),
      ...(existingClient ? { shareInFlight: false } : {}),
      key: cliProviderCatalogIdentity({
        driver: ProviderDriverKind.make("codex"),
        operation: "model/list+skills/list+collaborationMode/list",
        config: {
          binaryPath: probeInput.binaryPath,
          launchArgs: codexAppServerArgs(probeInput.launchArgs),
          version: input.version,
          account: input.account,
        },
        cwd: probeInput.cwd,
        environment: probeInput.environment,
      }),
      load: Effect.gen(function* () {
        const client = existingClient ?? (yield* makeCodexProviderProbeClient(probeInput)).client;
        const [skillsResponse, models, modes] = yield* Effect.all(
          [
            client.request("skills/list", { cwds: [probeInput.cwd] }),
            requestAllCodexModels(client),
            requestCodexCollaborationModes(client),
          ],
          { concurrency: "unbounded" },
        );
        const modeDescriptor = modes.descriptor;
        return {
          models: modeDescriptor
            ? models.map((model) => ({
                ...model,
                capabilities: createModelCapabilities({
                  optionDescriptors: [
                    ...(model.capabilities?.optionDescriptors ?? []),
                    modeDescriptor,
                  ],
                }),
              }))
            : models,
          skills: parseCodexSkillsListResponse(skillsResponse, probeInput.cwd),
          ...("message" in modes ? { catalogMessage: modes.message } : {}),
        };
      }).pipe(Effect.scoped),
    })
    .pipe(
      Effect.mapError((error) =>
        isCodexAppServerError(error.cause)
          ? error.cause
          : CodexErrors.CodexAppServerRequestError.internalError(
              "Codex 模型目录读取失败。",
              undefined,
              { method: "model/list", operation: "receive-response", cause: error.cause },
            ),
      ),
    );
});

const probeCodexAppServerProvider = Effect.fn("probeCodexAppServerProvider")(function* (
  input: CodexProviderProbeInput,
) {
  // 整次刷新已冻结 home 和环境；账户与目录使用同一个无会话 client。
  const environment = input.environment ?? { ...(yield* HostProcessEnvironment) };
  const probeInput = { ...input, environment };
  const { client, version } = yield* makeCodexProviderProbeClient(probeInput);

  const accountResponse = yield* client.request("account/read", {});
  if (!accountResponse.account && accountResponse.requiresOpenaiAuth) {
    return {
      account: accountResponse,
      version,
      models: appendCustomCodexModels([], input.customModels ?? []),
      skills: [],
    } satisfies CodexAppServerProviderSnapshot;
  }

  const catalog = input.catalog ?? (yield* makeCliProviderCatalog());
  const { models, skills, catalogMessage } = yield* fetchCodexCatalog({
    ...probeInput,
    version,
    account: accountResponse,
    catalog,
    client,
  });

  return {
    account: accountResponse,
    version,
    models: applyPreferredCodexDefaultModel(
      appendCustomCodexModels(models, input.customModels ?? []),
    ),
    skills: skills ?? [],
    ...(catalogMessage ? { catalogMessage } : {}),
  } satisfies CodexAppServerProviderSnapshot;
});

const emptyCodexModelsFromSettings = (codexSettings: CodexSettings): ServerProvider["models"] => {
  const models = new Set<string>();
  for (const model of codexSettings.customModels) {
    const trimmed = model.trim();
    if (trimmed.length > 0) {
      models.add(trimmed);
    }
  }
  return Array.from(models, (model) => ({
    slug: model,
    name: model,
    isCustom: true,
    capabilities: null,
  }));
};

const makePendingCodexProvider = (
  codexSettings: CodexSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = emptyCodexModelsFromSettings(codexSettings);

    if (!codexSettings.enabled) {
      return buildServerProvider({
        presentation: CODEX_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        skills: [],
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Codex is disabled in Code Work settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      skills: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Codex provider status has not been checked in this session yet.",
      },
    });
  });

function accountProbeStatus(account: CodexAppServerProviderSnapshot["account"]): {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProvider["auth"];
  readonly message?: string;
} {
  const authLabel = codexAccountAuthLabel(account.account);
  const authEmail = codexAccountEmail(account.account);
  const auth = {
    status: account.account ? ("authenticated" as const) : ("unknown" as const),
    ...(account.account?.type ? { type: account.account?.type } : {}),
    ...(authLabel ? { label: authLabel } : {}),
    ...(authEmail ? { email: authEmail } : {}),
  } satisfies ServerProvider["auth"];

  if (account.account) {
    return { status: "ready", auth };
  }

  if (account.requiresOpenaiAuth) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  return { status: "ready", auth };
}

export interface CodexDamageProbeInput {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

/**
 * Cheap `codex --version` recheck used when the app-server probe already
 * failed. A shim that spawns but dies during the handshake can mean npm
 * dropped the platform package — the launcher throws "Missing optional
 * dependency" before the app-server even starts. Anything else is left as a
 * generic probe failure, since a reinstall would not fix it.
 */
const detectDamagedCodexInstall = (
  input: CodexDamageProbeInput,
): Effect.Effect<boolean, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    if (input.signal?.aborted) return yield* Effect.interrupt;
    const environment = input.environment ?? { ...(yield* HostProcessEnvironment) };
    const spawnCommand = yield* resolveSpawnCommand(input.binaryPath, ["--version"], {
      env: environment,
      extendEnv: false,
      ...(input.cwd ? { cwd: input.cwd } : {}),
    });
    const result = yield* spawnAndCollect(
      input.binaryPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        extendEnv: false,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        forceKillAfter: CODEX_APP_SERVER_PROBE_FORCE_KILL_AFTER,
        shell: spawnCommand.shell,
      }),
    );
    return CODEX_MISSING_PLATFORM_PACKAGE_PATTERN.test(`${result.stdout}\n${result.stderr}`);
  }).pipe(Effect.orElseSucceed(() => false));

/** RPC 以 Effect interruption 取消；共同信号只桥接整次刷新，不为各请求新建 controller。 */
const interruptCodexRefreshOnAbort = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  signal: AbortSignal,
) =>
  Effect.suspend(() => {
    if (signal.aborted) return Effect.interrupt;
    const aborted = Effect.callback<never>((resume) => {
      const interrupt = () => resume(Effect.interrupt);
      signal.addEventListener("abort", interrupt, { once: true });
      if (signal.aborted) interrupt();
      return Effect.sync(() => signal.removeEventListener("abort", interrupt));
    });
    return Effect.raceFirst(aborted, effect);
  });

export const checkCodexProviderStatus = Effect.fn("checkCodexProviderStatus")(function* (
  codexSettings: CodexSettings,
  probe: (input: {
    readonly binaryPath: string;
    readonly homePath?: string;
    readonly launchArgs?: string;
    readonly cwd: string;
    readonly customModels: ReadonlyArray<string>;
    readonly environment?: NodeJS.ProcessEnv;
    readonly catalog?: CliProviderCatalog;
    readonly signal?: AbortSignal;
  }) => Effect.Effect<
    CodexAppServerProviderSnapshot,
    CodexErrors.CodexAppServerError,
    ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  > = probeCodexAppServerProvider,
  environment?: NodeJS.ProcessEnv,
  detectDamagedInstall: (
    input: CodexDamageProbeInput,
  ) => Effect.Effect<
    boolean,
    never,
    ChildProcessSpawner.ChildProcessSpawner
  > = detectDamagedCodexInstall,
  catalog?: CliProviderCatalog,
  nativeCatalog?: NativeProviderCatalog,
): Effect.fn.Return<
  ServerProviderDraft,
  ServerSettingsError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const homePath = codexSettings.homePath ? expandHomePath(codexSettings.homePath) : undefined;
  const resolvedEnvironment = {
    ...(yield* HostProcessEnvironment),
    ...environment,
    ...(homePath ? { CODEX_HOME: homePath } : {}),
  };
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const customModels = [...codexSettings.customModels];

  if (!codexSettings.enabled) {
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: false,
      checkedAt,
      models: appendCustomCodexModels([], customModels),
      skills: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Codex is disabled in Code Work settings.",
      },
    });
  }

  const providerCatalog = catalog ?? (yield* makeCliProviderCatalog());
  const providerRefresh = nativeCatalog ?? (yield* makeNativeProviderCatalog());
  const probeInput = {
    binaryPath: codexSettings.binaryPath,
    ...(homePath ? { homePath } : {}),
    launchArgs: resolveCodexLaunchArgs(codexSettings.launchArgs, resolvedEnvironment),
    cwd: yield* HostProcessWorkingDirectory,
    customModels: [],
    environment: resolvedEnvironment,
    catalog: providerCatalog,
  };
  const timeoutDraft = () =>
    buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      skills: [],
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Timed out while checking Codex app-server provider status.",
      },
    });
  const native = yield* providerRefresh.fetchCatalog({
    key: cliProviderCatalogIdentity({
      driver: ProviderDriverKind.make("codex"),
      operation: "native-refresh",
      config: {
        binaryPath: probeInput.binaryPath,
        launchArgs: codexAppServerArgs(probeInput.launchArgs),
      },
      cwd: probeInput.cwd,
      environment: resolvedEnvironment,
    }),
    timeoutMs: AUTH_PROBE_TIMEOUT_MS,
    onTimeout: timeoutDraft,
    load: (controller) =>
      interruptCodexRefreshOnAbort(
        Effect.gen(function* () {
          const signal = controller.signal;
          const deadlineAt = DateTime.toEpochMillis(yield* DateTime.now) + AUTH_PROBE_TIMEOUT_MS;
          const probeResult = yield* probe({ ...probeInput, signal }).pipe(
            Effect.scoped,
            Effect.catchCause((cause) => {
              if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
              const error = Cause.squash(cause);
              return Effect.fail(
                isCodexAppServerError(error)
                  ? error
                  : CodexErrors.CodexAppServerRequestError.internalError(
                      "Codex provider probe failed.",
                      undefined,
                      { method: "initialize", operation: "receive-response", cause: error },
                    ),
              );
            }),
            Effect.result,
          );
          if (Result.isFailure(probeResult)) {
            const error = probeResult.failure;
            const installed = !isCodexAppServerSpawnError(error);
            // 诊断属于本轮预算；截止时不再启动另一个进程。
            if (signal.aborted || DateTime.toEpochMillis(yield* DateTime.now) >= deadlineAt) {
              return timeoutDraft();
            }
            const damaged =
              installed &&
              (yield* detectDamagedInstall({
                binaryPath: probeInput.binaryPath,
                ...(homePath ? { homePath } : {}),
                cwd: probeInput.cwd,
                environment: resolvedEnvironment,
                signal,
              }).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(false),
                ),
              ));
            yield* Effect.logWarning("Codex app-server health check failed.", {
              errorTag: error._tag,
              binaryPath: probeInput.binaryPath,
              reason: damaged
                ? "installation-damaged"
                : installed
                  ? "execution-failed"
                  : "command-not-found",
            });
            return buildServerProvider({
              presentation: CODEX_PRESENTATION,
              enabled: true,
              checkedAt,
              models: [],
              skills: [],
              probe: {
                installed: installed && !damaged,
                version: null,
                status: "error",
                auth: { status: "unknown" },
                message: damaged
                  ? CODEX_INSTALLATION_DAMAGED_MESSAGE
                  : installed
                    ? `Codex app-server provider probe failed: ${error.message}.`
                    : "Codex CLI (`codex`) was not found in Code Work's server environment. Check the configured binary path or restart Code Work after updating PATH.",
              },
            });
          }
          const snapshot = probeResult.success;
          const accountStatus = accountProbeStatus(snapshot.account);
          return buildServerProvider({
            presentation: CODEX_PRESENTATION,
            enabled: true,
            checkedAt,
            models: snapshot.models,
            skills: snapshot.skills,
            slashCommands: [
              {
                name: "review",
                description: "Review changes with Codex",
                input: { hint: "Review instructions (optional; defaults to uncommitted changes)" },
              },
              {
                name: "feedback",
                description: "Send this thread and Codex logs to OpenAI",
                input: { hint: "Describe the issue (optional)" },
              },
            ],
            probe: {
              installed: true,
              version: snapshot.version ?? null,
              status:
                accountStatus.status === "ready" && snapshot.catalogMessage
                  ? "warning"
                  : accountStatus.status,
              auth: accountStatus.auth,
              ...(accountStatus.message || snapshot.catalogMessage
                ? { message: accountStatus.message ?? snapshot.catalogMessage }
                : {}),
            },
          });
        }),
        controller.signal,
      ),
  });
  return {
    ...native,
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    models: applyPreferredCodexDefaultModel(appendCustomCodexModels(native.models, customModels)),
  };
});

// NOTE: the singleton `CodexProviderLive` Layer has been removed as part of
// the per-instance-driver refactor. `CodexDriver.create()` builds a managed
// snapshot per instance (each with its own `CodexSettings`) and hands the
// resulting `ServerProviderShape` back as `ProviderInstance.snapshot`.
//
// The `makePendingCodexProvider` and `checkCodexProviderStatus` helpers are
// re-exported for use by `CodexDriver`.
export { makePendingCodexProvider };
