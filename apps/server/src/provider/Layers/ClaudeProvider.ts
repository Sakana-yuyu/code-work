import {
  type ClaudeSettings,
  type ModelCapabilities,
  type ModelSelection,
  ProviderDriverKind,
  type ServerProviderModel,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@codework/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@codework/shared/hostProcess";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  createModelCapabilities,
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@codework/shared/model";
import { resolveSpawnCommand } from "@codework/shared/shell";
import {
  query as claudeQuery,
  type Options as ClaudeQueryOptions,
  type SlashCommand as ClaudeSlashCommand,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";

import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerCustomModelSlugs,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  findClaudeNpmPackageEntry,
  isClaudeNpmPackageEntryDamaged,
  resolveClaudeSdkExecutablePath,
} from "../Drivers/ClaudeExecutable.ts";
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import { discoverClaudeSkills } from "../Drivers/ClaudeSkills.ts";
import {
  cliProviderCatalogIdentity,
  makeCliProviderCatalog,
  type CliProviderCatalog,
} from "../CliProviderCatalog.ts";
import { makeNativeProviderCatalog, type NativeProviderCatalog } from "../NativeProviderCatalog.ts";

const DEFAULT_CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const CLAUDE_PRESENTATION = {
  displayName: "Claude",
  showInteractionModeToggle: true,
} as const;

const CLAUDE_MODEL_CATALOG: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-fable-5",
    name: "Claude Fable 5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            {
              value: "ultracode",
              label: "Ultracode",
              description: "xhigh effort plus multi-agent workflow orchestration",
            },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k" },
            { value: "1m", label: "1M", isDefault: true },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-5",
    name: "Claude Opus 5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            {
              value: "ultracode",
              label: "Ultracode",
              description: "xhigh effort plus multi-agent workflow orchestration",
            },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          // Claude Code selects the 1M variant explicitly (`claude-opus-5[1m]`).
          options: [
            { value: "200k", label: "200k" },
            { value: "1m", label: "1M", isDefault: true },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            {
              value: "ultracode",
              label: "Ultracode",
              description: "xhigh effort plus multi-agent workflow orchestration",
            },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "xhigh", label: "Extra High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k" },
            { value: "1m", label: "1M", isDefault: true },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
          ],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
      ],
    }),
  },
  {
    slug: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          // Sonnet is 200k-default in Claude Code (1M is opt-in there too).
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          // Sonnet is 200k-default in Claude Code (1M is opt-in there too).
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildBooleanOptionDescriptor({
          id: "thinking",
          label: "Thinking",
        }),
      ],
    }),
  },
];

// Legacy classification and CLI-version gating happen at the driver boundary
// via `applyModelManifest`, so the catalog itself carries no `isLegacy` flags
// and no per-model version checks.
const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = CLAUDE_MODEL_CATALOG;

export function getClaudeModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = model?.trim();
  return (
    BUILT_IN_MODELS.find((candidate) => candidate.slug === slug)?.capabilities ??
    DEFAULT_CLAUDE_MODEL_CAPABILITIES
  );
}

export function resolveClaudeEffort(
  caps: ModelCapabilities,
  raw: string | null | undefined,
): string | undefined {
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "effort", value: raw }] } : {}),
  });
  const effortDescriptor = descriptors.find((descriptor) => descriptor.id === "effort");
  const value = getProviderOptionCurrentValue(effortDescriptor);
  return typeof value === "string" ? value : undefined;
}

/**
 * Claude Agent SDK `effort` 的合法取值与本地伪档位（ultracode/ultrathink
 * 由 normalizeClaudeCliEffort 归一）。
 */
const CLAUDE_PASSTHROUGH_EFFORTS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
  "ultrathink",
]);

/** 模型 slug 是否在内置目录中（目录内模型的能力边界以目录为准）。 */
export function isBuiltInClaudeModel(model: string | null | undefined): boolean {
  const slug = model?.trim();
  return slug !== undefined && slug.length > 0
    ? BUILT_IN_MODELS.some((candidate) => candidate.slug === slug)
    : false;
}

/**
 * 静态目录外的模型（BYOK 路由渠道）没有可校验的 effort 描述符，但选项
 * 本身就是路由快照下发的：枚举内的显式选择直接采信；"none"（显式关闭
 * 思考）与未知值一律视为未设置，不往 CLI 发。
 */
export function passthroughClaudeEffort(raw: string | null | undefined): string | undefined {
  return raw != null && CLAUDE_PASSTHROUGH_EFFORTS.has(raw) ? raw : undefined;
}

/**
 * Normalize a resolved Claude effort value into one suitable for the Claude
 * CLI's `--effort` flag.
 *
 * Mirrors the mapping used when invoking the Claude Agent SDK
 * ({@link getEffectiveClaudeAgentEffort} in ClaudeAdapter): `ultracode` is a
 * Claude Code setting that pairs with `xhigh`, `ultrathink` is filtered out
 * because it is a prompt-prefix mode, and older model compatibility mappings
 * are preserved for current Claude Code behavior.
 */
export function normalizeClaudeCliEffort(
  effort: string | null | undefined,
  model: string | null | undefined,
): string | undefined {
  if (!effort || effort === "ultrathink") {
    return undefined;
  }
  if (effort === "ultracode") {
    return "xhigh";
  }
  if (
    effort === "xhigh" &&
    model !== "claude-fable-5" &&
    model !== "claude-opus-5" &&
    model !== "claude-opus-4-8" &&
    model !== "claude-sonnet-5"
  ) {
    return "max";
  }
  if (effort === "max" && model === "claude-sonnet-4-6") {
    return "high";
  }
  return effort;
}

export function isClaudeUltracodeEffort(effort: string | null | undefined): boolean {
  return effort === "ultracode";
}

export function resolveClaudeContextWindow(
  modelSelection: ModelSelection | undefined,
): string | undefined {
  const caps = getClaudeModelCapabilities(modelSelection?.model);
  const raw = getModelSelectionStringOptionValue(modelSelection, "contextWindow");
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "contextWindow", value: raw }] } : {}),
  });
  const descriptor = descriptors.find((candidate) => candidate.id === "contextWindow");
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : undefined;
}

export function resolveClaudeApiModelId(modelSelection: ModelSelection): string {
  switch (resolveClaudeContextWindow(modelSelection)) {
    case "1m":
      return `${modelSelection.model}[1m]`;
    default:
      return modelSelection.model;
  }
}

function toTitleCaseWords(value: string): string {
  const parts: Array<string> = [];
  for (const part of value.split(/[\s_-]+/g)) {
    if (part.length > 0) {
      parts.push(part[0]!.toUpperCase() + part.slice(1).toLowerCase());
    }
  }
  return parts.join(" ");
}

function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "claudemaxsubscription":
      return "Max";
    case "claudemax5xsubscription":
      return "Max 5x";
    case "claudemax20xsubscription":
      return "Max 20x";
    case "claudeenterprisesubscription":
      return "Enterprise";
    case "claudeteamsubscription":
      return "Team";
    case "claudeprosubscription":
      return "Pro";
    case "claudefreesubscription":
      return "Free";
    case "max":
    case "maxplan":
      return "Max";
    case "max5":
      return "Max 5x";
    case "max20":
      return "Max 20x";
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function normalizeClaudeAuthMethod(authMethod: string | undefined): string | undefined {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (
    normalized === "apikey" ||
    normalized === "anthropicapikey" ||
    normalized === "anthropicauthtoken"
  ) {
    return "apiKey";
  }
  return undefined;
}

function formatClaudeSubscriptionAuthLabel(subscriptionType: string): string {
  const subscriptionLabel =
    claudeSubscriptionLabel(subscriptionType) ?? toTitleCaseWords(subscriptionType);
  const normalized = subscriptionLabel.toLowerCase().replace(/[\s_-]+/g, "");

  if (normalized.startsWith("claude") && normalized.endsWith("subscription")) {
    return subscriptionLabel;
  }
  if (normalized.startsWith("claude")) {
    return `${subscriptionLabel} Subscription`;
  }
  if (normalized.endsWith("subscription")) {
    return `Claude ${subscriptionLabel}`;
  }
  return `Claude ${subscriptionLabel} Subscription`;
}

function claudeAuthMetadata(input: {
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
}): { readonly type: string; readonly label: string } | undefined {
  if (normalizeClaudeAuthMethod(input.authMethod) === "apiKey") {
    return {
      type: "apiKey",
      label: "Claude API Key",
    };
  }

  if (input.subscriptionType) {
    return {
      type: input.subscriptionType,
      label: formatClaudeSubscriptionAuthLabel(input.subscriptionType),
    };
  }

  return undefined;
}

function apiProviderAuthMetadata(
  apiProvider: string | undefined,
): { readonly type: string; readonly label: string } | undefined {
  return apiProvider === "bedrock" ? { type: "bedrock", label: "Amazon Bedrock" } : undefined;
}

// ── SDK capability probe ────────────────────────────────────────────

// Amazon Bedrock initializes far slower than first-party auth: the SDK boots the
// Bedrock backend and runs the `awsAuthRefresh` credential hook before returning
// account info. The previous 8s budget expired mid-init, so the probe returned
// `undefined` and left the provider unverified and unselectable in the picker.
const CAPABILITIES_PROBE_TIMEOUT_MS = 25_000;
/** 保留慢 Bedrock 初始化所需余量，版本、初始化与技能扫描共用这一次预算。 */
const CLAUDE_REFRESH_TIMEOUT_MS = 30_000;

/**
 * Keep workspace-scoped command discovery intact while isolating the periodic
 * health check from configured MCP servers.
 */
export const CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

/** Build the exact SDK options used by the periodic Claude capability probe. */
export function buildClaudeCapabilitiesProbeQueryOptions(input: {
  readonly executablePath: string;
  readonly abortController: AbortController;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
}): ClaudeQueryOptions {
  return {
    persistSession: false,
    pathToClaudeCodeExecutable: input.executablePath,
    abortController: input.abortController,
    settingSources: [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES],
    // The probe keeps filesystem setting sources for slash-command discovery,
    // but must not run the user's hooks: it fires every few minutes, so
    // SessionStart hooks would run on every health check.
    settings: { disableAllHooks: true },
    allowedTools: [],
    // Ignore MCP definitions from every filesystem setting source above. The
    // SDK combines this empty explicit map with --strict-mcp-config.
    mcpServers: {},
    strictMcpConfig: true,
    env: {
      ...input.environment,
      // Connected claude.ai MCP servers are discovered outside filesystem
      // config; disable them independently for this health check.
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    },
    ...(input.cwd ? { cwd: input.cwd } : {}),
    stderr: () => {},
  };
}

function nonEmptyProbeString(value: string): string | undefined {
  const candidate = value.trim();
  return candidate ? candidate : undefined;
}

type ClaudeCapabilitiesProbe = {
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  /**
   * Active API backend reported by the SDK's `AccountInfo`. Anthropic OAuth
   * login only applies when `"firstParty"`; for Amazon Bedrock (`"bedrock"`)
   * the subscription/token fields are absent and auth is external AWS creds.
   */
  readonly apiProvider: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
};

function parseClaudeInitializationCommands(
  commands: ReadonlyArray<ClaudeSlashCommand> | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  return dedupeSlashCommands(
    (commands ?? []).flatMap((command) => {
      const name = nonEmptyProbeString(command.name);
      if (!name) {
        return [];
      }

      const description = nonEmptyProbeString(command.description);
      const argumentHint = nonEmptyProbeString(command.argumentHint);

      return [
        {
          name,
          ...(description ? { description } : {}),
          ...(argumentHint ? { input: { hint: argumentHint } } : {}),
        } satisfies ServerProviderSlashCommand,
      ];
    }),
  );
}

function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = nonEmptyProbeString(command.name);
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = commandsByName.get(key);
    if (!existing) {
      commandsByName.set(key, {
        ...command,
        name,
      });
      continue;
    }

    commandsByName.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
      ...(existing.input?.hint
        ? {}
        : command.input?.hint
          ? { input: { hint: command.input.hint } }
          : {}),
    });
  }

  return [...commandsByName.values()];
}

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * 只读取 SDK 初始化中的当前账户与命令，不发送用户消息或创建持久会话。
 * Query 留在整次刷新 Scope 中，后续目录读取也完成后才统一关闭。
 */
const probeResolvedClaudeCapabilities = Effect.fn("probeResolvedClaudeCapabilities")(function* (
  executablePath: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  abort: AbortController,
) {
  return yield* Effect.gen(function* () {
    // Query 跟随整次刷新 Scope；initialize 返回时技能扫描仍需要同一个有效信号。
    const q = yield* Effect.acquireRelease(
      Effect.try(() =>
        claudeQuery({
          // Never yield — we only need initialization data, not a conversation.
          // This prevents any prompt from reaching the Anthropic API.
          // oxlint-disable-next-line require-yield
          prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
            await waitForAbortSignal(abort.signal);
          })(),
          options: buildClaudeCapabilitiesProbeQueryOptions({
            executablePath,
            abortController: abort,
            environment,
            cwd,
          }),
        }),
      ),
      (query) => Effect.try(() => query.close()).pipe(Effect.ignore),
    );
    return yield* Effect.tryPromise(async () => {
      const init = await q.initializationResult();
      const account = init.account as
        | {
            readonly email?: string;
            readonly subscriptionType?: string;
            readonly tokenSource?: string;
            readonly apiProvider?: string;
          }
        | undefined;
      return {
        email: account?.email,
        subscriptionType: account?.subscriptionType,
        tokenSource: account?.tokenSource,
        apiProvider: account?.apiProvider,
        slashCommands: parseClaudeInitializationCommands(init.commands),
      } satisfies ClaudeCapabilitiesProbe;
    });
  }).pipe(
    Effect.result,
    Effect.map((result) => (Result.isSuccess(result) ? result.success : undefined)),
  );
});

const probeClaudeCapabilities = Effect.fn("probeClaudeCapabilities")(function* (
  settings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const resolvedEnvironment = yield* makeClaudeEnvironment(settings, {
    ...(yield* HostProcessEnvironment),
    ...environment,
  });
  const resolvedCwd = cwd ?? (yield* HostProcessWorkingDirectory);
  const executablePath = yield* resolveClaudeSdkExecutablePath(
    settings.binaryPath,
    resolvedEnvironment,
    resolvedCwd,
  );
  // 独立探针保持旧的 25 秒约定；整次刷新路径由外层唯一 owner 提供控制器与预算。
  const abort = new AbortController();
  return yield* probeResolvedClaudeCapabilities(
    executablePath,
    resolvedEnvironment,
    resolvedCwd,
    abort,
  ).pipe(
    Effect.ensuring(Effect.sync(() => abort.abort())),
    Effect.scoped,
    Effect.timeoutOption(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.map((result) => (Option.isSome(result) ? result.value : undefined)),
  );
});

interface ClaudeNativeCatalogInput<RCapabilities, RSkills> {
  readonly executablePath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly capabilities: Effect.Effect<ClaudeCapabilitiesProbe | undefined, never, RCapabilities>;
  readonly skills: Effect.Effect<ReadonlyArray<ServerProviderSkill>, never, RSkills>;
  readonly shareInFlight?: boolean;
}

/** 初始化的账户只属于本次检查；缓存仅持有已经脱离 SDK 生命周期的目录值。 */
export const fetchClaudeCatalog = Effect.fn("fetchClaudeCatalog")(function* <
  RCapabilities = never,
  RSkills = never,
>(
  settings: Pick<ClaudeSettings, "customModels">,
  catalog?: CliProviderCatalog,
  native?: ClaudeNativeCatalogInput<RCapabilities, RSkills>,
) {
  const builtInModels = BUILT_IN_MODELS;
  const customModels = providerCustomModelSlugs(builtInModels, settings.customModels);
  // SDK 将账户与命令合并在 initialize 响应中，读取当前账户必然也会收到当前命令。
  const capabilities = native ? yield* native.capabilities : undefined;
  const slashCommands = native
    ? dedupeSlashCommands([
        { name: "compact", description: "Summarize the conversation and reduce context usage" },
        ...(capabilities?.slashCommands ?? []),
      ])
    : undefined;
  const load = Effect.gen(function* () {
    return {
      models: providerModelsFromSettings(
        builtInModels,
        customModels,
        DEFAULT_CLAUDE_MODEL_CAPABILITIES,
      ),
      ...(native ? { skills: yield* native.skills, slashCommands: slashCommands ?? [] } : {}),
    };
  });
  const providerCatalog = catalog ?? (yield* makeCliProviderCatalog());
  // 初始化失败的降级目录不写缓存，不能覆盖或延长之前成功发现的目录。
  const data =
    native && !capabilities
      ? yield* load
      : yield* providerCatalog
          .fetchCatalog({
            key: cliProviderCatalogIdentity({
              driver: ProviderDriverKind.make("claudeAgent"),
              operation: native ? "native-directory" : "configured-models",
              config: {
                customModels,
                ...(native ? { binaryPath: native.executablePath, slashCommands } : {}),
              },
              ...(native ? { cwd: native.cwd, environment: native.environment } : {}),
            }),
            load,
            ...(native?.shareInFlight === false ? { shareInFlight: false } : {}),
          })
          .pipe(Effect.orDie);
  const account = capabilities
    ? {
        email: capabilities.email,
        subscriptionType: capabilities.subscriptionType,
        tokenSource: capabilities.tokenSource,
        apiProvider: capabilities.apiProvider,
      }
    : undefined;
  return { catalog: data, account };
});

const runClaudeCommand = Effect.fn("runClaudeCommand")(function* (
  claudeSettings: ClaudeSettings,
  args: ReadonlyArray<string>,
  claudeEnvironment: NodeJS.ProcessEnv,
  cwd: string,
) {
  const spawnCommand = yield* resolveSpawnCommand(claudeSettings.binaryPath, args, {
    env: claudeEnvironment,
    extendEnv: false,
    ...(cwd ? { cwd } : {}),
  });
  yield* Effect.annotateCurrentSpan({
    "claude.binary_path": claudeSettings.binaryPath,
    "claude.spawn_command": spawnCommand.command,
    "claude.spawn_shell": spawnCommand.shell,
    "claude.path_present": Boolean(
      claudeEnvironment.PATH ?? claudeEnvironment.Path ?? claudeEnvironment.path,
    ),
  });
  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: claudeEnvironment,
    extendEnv: false,
    ...(cwd ? { cwd } : {}),
    shell: spawnCommand.shell,
  });
  return yield* spawnAndCollect(claudeSettings.binaryPath, command);
});

const checkResolvedClaudeProviderStatus = Effect.fn("checkResolvedClaudeProviderStatus")(function* (
  claudeSettings: ClaudeSettings,
  resolvedEnvironment: NodeJS.ProcessEnv,
  resolvedCwd: string,
  executablePath: string,
  abort: AbortController,
  catalog: CliProviderCatalog,
  progress: { installed: boolean; version: string | null },
  resolveCapabilities?: (
    claudeSettings: ClaudeSettings,
  ) => Effect.Effect<ClaudeCapabilitiesProbe | undefined>,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const {
    catalog: { models: allModels },
  } = yield* fetchClaudeCatalog(claudeSettings, catalog);

  if (!claudeSettings.enabled) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: allModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude is disabled in Code Work settings.",
      },
    });
  }

  const claudeNpmPackageEntry = findClaudeNpmPackageEntry(
    resolvedEnvironment,
    yield* HostProcessPlatform,
    undefined,
    resolvedCwd,
  );
  if (claudeNpmPackageEntry && isClaudeNpmPackageEntryDamaged(claudeNpmPackageEntry)) {
    yield* Effect.logWarning("Claude Agent CLI installation appears damaged.", {
      binaryPath: claudeSettings.binaryPath,
      packageEntry: claudeNpmPackageEntry,
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Claude Agent CLI installation appears incomplete or damaged. Repair it from Provider settings, then refresh status.",
      },
    });
  }

  const versionProbe = yield* runClaudeCommand(
    claudeSettings,
    ["--version"],
    resolvedEnvironment,
    resolvedCwd,
  ).pipe(Effect.result);

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Claude Agent CLI health check failed.", {
      errorTag: error._tag,
      binaryPath: claudeSettings.binaryPath,
      reason: isCommandMissingCause(error) ? "command-not-found" : "execution-failed",
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Claude Agent CLI (`claude`) was not found in Code Work's server environment. Check the configured binary path or restart Code Work after updating PATH."
          : "Failed to execute Claude Agent CLI health check.",
      },
    });
  }

  const version = versionProbe.success;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  // SDK 或文件扫描超时不能抹掉版本阶段已经确认的安装信息。
  progress.installed = true;
  progress.version = parsedVersion;
  if (version.code !== 0) {
    yield* Effect.logWarning("Claude Agent CLI version probe exited with a non-zero status.", {
      exitCode: version.code,
      stdoutLength: version.stdout.length,
      stderrLength: version.stderr.length,
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: "Claude Agent CLI is installed but failed to run.",
      },
    });
  }

  const {
    catalog: { models, skills, slashCommands },
    account: capabilities,
  } = yield* fetchClaudeCatalog(claudeSettings, catalog, {
    executablePath,
    environment: resolvedEnvironment,
    cwd: resolvedCwd,
    capabilities: resolveCapabilities
      ? resolveCapabilities(claudeSettings).pipe(Effect.orElseSucceed(() => undefined))
      : probeResolvedClaudeCapabilities(executablePath, resolvedEnvironment, resolvedCwd, abort),
    skills: discoverClaudeSkills(claudeSettings, resolvedCwd, resolvedEnvironment),
    shareInFlight: false,
  });

  if (!capabilities) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      slashCommands: slashCommands ?? [],
      skills: skills ?? [],
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify Claude authentication status from initialization result.",
      },
    });
  }

  const authMetadata =
    claudeAuthMetadata({
      subscriptionType: capabilities.subscriptionType,
      authMethod: capabilities.tokenSource,
    }) ?? apiProviderAuthMetadata(capabilities.apiProvider);
  return buildServerProvider({
    presentation: CLAUDE_PRESENTATION,
    enabled: claudeSettings.enabled,
    checkedAt,
    models,
    slashCommands: slashCommands ?? [],
    skills: skills ?? [],
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: {
        status: "authenticated",
        ...(capabilities.email ? { email: capabilities.email } : {}),
        ...(authMetadata ? authMetadata : {}),
      },
    },
  });
});

export const checkClaudeProviderStatus = Effect.fn("checkClaudeProviderStatus")(function* (
  claudeSettings: ClaudeSettings,
  resolveCapabilities?: (
    settings: ClaudeSettings,
  ) => Effect.Effect<ClaudeCapabilitiesProbe | undefined>,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
  catalog?: CliProviderCatalog,
  nativeCatalog?: NativeProviderCatalog,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const settings = { ...claudeSettings, customModels: [...claudeSettings.customModels] };
  const providerCatalog = catalog ?? (yield* makeCliProviderCatalog());
  if (!settings.enabled) return yield* makePendingClaudeProvider(settings, providerCatalog);
  const resolvedEnvironment = yield* makeClaudeEnvironment(settings, {
    ...(yield* HostProcessEnvironment),
    ...environment,
  });
  const resolvedCwd = cwd ?? (yield* HostProcessWorkingDirectory);
  const executablePath = yield* resolveClaudeSdkExecutablePath(
    settings.binaryPath,
    resolvedEnvironment,
    resolvedCwd,
  );
  const nativeSettings = {
    ...settings,
    homePath: settings.homePath.trim()
      ? (resolvedEnvironment.CLAUDE_CONFIG_DIR ?? settings.homePath)
      : "",
    customModels: [],
  };
  const refreshes = nativeCatalog ?? (yield* makeNativeProviderCatalog());
  const initial = yield* makePendingClaudeProvider(nativeSettings, providerCatalog);
  const progress = { installed: false, version: null as string | null };
  const snapshot = yield* refreshes.fetchCatalog({
    key: cliProviderCatalogIdentity({
      driver: ProviderDriverKind.make("claudeAgent"),
      operation: "native-refresh",
      config: { binaryPath: settings.binaryPath, executablePath },
      environment: resolvedEnvironment,
      cwd: resolvedCwd,
    }),
    timeoutMs: CLAUDE_REFRESH_TIMEOUT_MS,
    onTimeout: () => ({
      ...initial,
      installed: progress.installed,
      version: progress.version,
      models: progress.installed ? BUILT_IN_MODELS : initial.models,
      status: "error",
      message: "Claude 原生刷新超时；版本、初始化与技能扫描共用 30 秒预算。",
    }),
    load: (abort) =>
      checkResolvedClaudeProviderStatus(
        nativeSettings,
        resolvedEnvironment,
        resolvedCwd,
        executablePath,
        abort,
        providerCatalog,
        progress,
        resolveCapabilities,
      ).pipe(Effect.scoped),
  });
  const customModels = providerCustomModelSlugs(snapshot.models, settings.customModels);
  return {
    ...snapshot,
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    models:
      customModels.length === 0
        ? snapshot.models
        : providerModelsFromSettings(
            snapshot.models,
            customModels,
            DEFAULT_CLAUDE_MODEL_CAPABILITIES,
          ),
  };
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makePendingClaudeProvider = (
  claudeSettings: ClaudeSettings,
  catalog?: CliProviderCatalog,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;
    const {
      catalog: { models },
    } = yield* fetchClaudeCatalog(claudeSettings, catalog);

    if (!claudeSettings.enabled) {
      return buildServerProvider({
        presentation: CLAUDE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Claude is disabled in Code Work settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude provider status has not been checked in this session yet.",
      },
    });
  });

export { probeClaudeCapabilities };
