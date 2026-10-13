import * as NodeOS from "node:os";
import {
  ProviderDriverKind,
  type CursorSettings,
  type ModelCapabilities,
  type ProviderOptionSelection,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderState,
} from "@codework/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@codework/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import {
  createModelCapabilities,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
} from "@codework/shared/model";
import { resolveSpawnCommand } from "@codework/shared/shell";
import { HostProcessEnvironment, HostProcessWorkingDirectory } from "@codework/shared/hostProcess";

import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  providerModelsFromSettings,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { CursorListAvailableModelsResponse } from "../acp/CursorAcpExtension.ts";
import {
  cliProviderCatalogIdentity,
  makeCliProviderCatalog,
  withCatalogAbortSignal,
  type CliProviderCatalog,
} from "../CliProviderCatalog.ts";
import { makeNativeProviderCatalog, type NativeProviderCatalog } from "../NativeProviderCatalog.ts";

const decodeCursorListAvailableModelsResponse = Schema.decodeUnknownEffect(
  CursorListAvailableModelsResponse,
);
const CURSOR_PRESENTATION = {
  displayName: "Cursor",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const CURSOR_REFRESH_TIMEOUT_MS = 15_000;
const CURSOR_PARAMETERIZED_MODEL_PICKER_MIN_VERSION_DATE = 2026_04_08;
const CURSOR_CLI_INSTALLATION_DOCS_URL = "https://cursor.com/docs/cli/installation";
const CURSOR_ACP_MODEL_DISCOVERY_FAILED_MESSAGE = [
  "Cursor ACP model discovery failed.",
  "Cursor CLI setup may be incomplete; install or enable the Cursor CLI, restart Code Work, and try again.",
  `See ${CURSOR_CLI_INSTALLATION_DOCS_URL}.`,
  "Check server logs for ACP details.",
].join(" ");
export const CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES = {
  _meta: {
    parameterizedModelPicker: true,
  },
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

export function buildInitialCursorProviderSnapshot(
  cursorSettings: CursorSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = getCursorFallbackModels(cursorSettings);

    if (!cursorSettings.enabled) {
      return buildServerProvider({
        presentation: CURSOR_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Cursor is disabled in Code Work settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CURSOR_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Cursor Agent availability...",
      },
    });
  });
}

interface CursorSessionSelectOption {
  readonly value: string;
  readonly name: string;
}

interface CursorAcpDiscoveredModel {
  readonly slug: string;
  readonly name: string;
  readonly capabilities: ModelCapabilities;
}

function flattenSessionConfigSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<CursorSessionSelectOption> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry
      ? [
          {
            value: entry.value.trim(),
            name: entry.name.trim(),
          } satisfies CursorSessionSelectOption,
        ]
      : entry.options.map(
          (option) =>
            ({
              value: option.value.trim(),
              name: option.name.trim(),
            }) satisfies CursorSessionSelectOption,
        ),
  );
}

function normalizeCursorReasoningValue(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "low":
    case "medium":
    case "high":
    case "max":
      return normalized;
    case "xhigh":
    case "extra-high":
    case "extra high":
      return "xhigh";
    default:
      return undefined;
  }
}

function getCursorConfigOptionCategory(option: EffectAcpSchema.SessionConfigOption): string {
  return option.category?.trim().toLowerCase() ?? "";
}

function isCursorEffortConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return (
    id === "effort" ||
    id === "reasoning" ||
    name === "effort" ||
    name === "reasoning" ||
    name.includes("effort") ||
    name.includes("reasoning")
  );
}

function findCursorEffortConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  const candidates = configOptions.filter(
    (option) => option.type === "select" && isCursorEffortConfigOption(option),
  );
  return (
    candidates.find((option) => getCursorConfigOptionCategory(option) === "model_option") ??
    candidates.find((option) => option.id.trim().toLowerCase() === "effort") ??
    candidates.find((option) => getCursorConfigOptionCategory(option) === "thought_level") ??
    candidates[0]
  );
}

function isCursorContextConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "context" || id === "context_size" || name.includes("context");
}

function isCursorFastConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "fast" || name === "fast" || name.includes("fast mode");
}

function isCursorThinkingConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "thinking" || name.includes("thinking");
}

function isBooleanLikeConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  if (option.type === "boolean") {
    return true;
  }
  if (option.type !== "select") {
    return false;
  }
  const values = new Set(
    flattenSessionConfigSelectOptions(option).map((entry) => entry.value.trim().toLowerCase()),
  );
  return values.has("true") && values.has("false");
}

function getBooleanCurrentValue(
  option: EffectAcpSchema.SessionConfigOption | undefined,
): boolean | undefined {
  if (!option) {
    return undefined;
  }
  if (option.type === "boolean") {
    return option.currentValue;
  }
  if (option.type !== "select") {
    return undefined;
  }
  const normalized = option.currentValue?.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return undefined;
}

export function buildCursorCapabilitiesFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  if (!configOptions || configOptions.length === 0) {
    return EMPTY_CAPABILITIES;
  }

  const reasoningConfig = findCursorEffortConfigOption(configOptions);
  const reasoningEffortLevels =
    reasoningConfig?.type === "select"
      ? flattenSessionConfigSelectOptions(reasoningConfig).flatMap((entry) => {
          const normalizedValue = normalizeCursorReasoningValue(entry.value);
          if (!normalizedValue) {
            return [];
          }
          return [
            {
              value: normalizedValue,
              label: entry.name,
              ...(normalizeCursorReasoningValue(reasoningConfig.currentValue) === normalizedValue
                ? { isDefault: true }
                : {}),
            },
          ];
        })
      : [];

  const contextOption = configOptions.find(
    (option) => option.category === "model_config" && isCursorContextConfigOption(option),
  );
  const contextWindowOptions =
    contextOption?.type === "select"
      ? flattenSessionConfigSelectOptions(contextOption).map((entry) => {
          if (contextOption.currentValue === entry.value) {
            return {
              value: entry.value,
              label: entry.name,
              isDefault: true,
            };
          }
          return {
            value: entry.value,
            label: entry.name,
          };
        })
      : [];

  const fastOption = configOptions.find(
    (option) => option.category === "model_config" && isCursorFastConfigOption(option),
  );
  const thinkingOption = configOptions.find(
    (option) => option.category === "model_config" && isCursorThinkingConfigOption(option),
  );
  const fastCurrentValue = getBooleanCurrentValue(fastOption);
  const thinkingCurrentValue = getBooleanCurrentValue(thinkingOption);
  const optionDescriptors = [
    ...(reasoningEffortLevels.length > 0
      ? [
          buildSelectOptionDescriptor({
            id: "reasoning",
            label: reasoningConfig?.name?.trim() || "Reasoning",
            options: reasoningEffortLevels,
          }),
        ]
      : []),
    ...(contextWindowOptions.length > 0
      ? [
          buildSelectOptionDescriptor({
            id: "contextWindow",
            label: contextOption?.name?.trim() || "Context Window",
            options: contextWindowOptions,
          }),
        ]
      : []),
    ...(fastOption && isBooleanLikeConfigOption(fastOption)
      ? [
          typeof fastCurrentValue === "boolean"
            ? buildBooleanOptionDescriptor({
                id: "fastMode",
                label: fastOption.name?.trim() || "Fast Mode",
                currentValue: fastCurrentValue,
              })
            : buildBooleanOptionDescriptor({
                id: "fastMode",
                label: fastOption.name?.trim() || "Fast Mode",
              }),
        ]
      : []),
    ...(thinkingOption && isBooleanLikeConfigOption(thinkingOption)
      ? [
          typeof thinkingCurrentValue === "boolean"
            ? buildBooleanOptionDescriptor({
                id: "thinking",
                label: thinkingOption.name?.trim() || "Thinking",
                currentValue: thinkingCurrentValue,
              })
            : buildBooleanOptionDescriptor({
                id: "thinking",
                label: thinkingOption.name?.trim() || "Thinking",
              }),
        ]
      : []),
  ];

  return createModelCapabilities({
    optionDescriptors,
  });
}

function buildCursorDiscoveredModels(
  discoveredModels: ReadonlyArray<CursorAcpDiscoveredModel>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return discoveredModels.flatMap((model) => {
    if (!model.slug || seen.has(model.slug)) {
      return [];
    }
    seen.add(model.slug);
    return [
      {
        slug: model.slug,
        name: model.name,
        isCustom: false,
        capabilities: model.capabilities,
      } satisfies ServerProviderModel,
    ];
  });
}

function buildCursorDiscoveredModelsFromAvailableModelsResponse(
  response: typeof CursorListAvailableModelsResponse.Type,
): ReadonlyArray<ServerProviderModel> {
  return buildCursorDiscoveredModels(
    response.models.flatMap((model) => {
      const slug = model.value.trim();
      const name = model.name.trim();
      if (!slug || !name) {
        return [];
      }

      return [
        {
          slug,
          name,
          capabilities: buildCursorCapabilitiesFromConfigOptions(model.configOptions),
        },
      ];
    }),
  );
}

const makeCursorAcpProbeRuntime = (
  cursorSettings: Pick<CursorSettings, "binaryPath" | "apiEndpoint">,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // 只约束目录探针及其 taskkill 终结器，不改变会话适配器的退出策略。
    const probeSpawner = ChildProcessSpawner.make((command) =>
      spawner.spawn(
        ChildProcess.isStandardCommand(command)
          ? ChildProcess.make(command.command, command.args, {
              ...command.options,
              forceKillAfter: "2 seconds",
            })
          : command,
      ),
    );
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn: {
          command: cursorSettings.binaryPath,
          args: [
            ...(cursorSettings.apiEndpoint ? (["-e", cursorSettings.apiEndpoint] as const) : []),
            "acp",
          ],
          cwd,
          env: environment,
          extendEnv: false,
        },
        cwd,
        clientInfo: { name: "code-work-provider-probe", version: "0.0.0" },
        authMethodId: "cursor_login",
        clientCapabilities: CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
      }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, probeSpawner))),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

const withCursorAcpProbeRuntime = <A, E, R>(
  cursorSettings: Pick<CursorSettings, "binaryPath" | "apiEndpoint">,
  useRuntime: (acp: AcpSessionRuntime.AcpSessionRuntime["Service"]) => Effect.Effect<A, E, R>,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) =>
  makeCursorAcpProbeRuntime(cursorSettings, environment, cwd).pipe(
    Effect.flatMap(useRuntime),
    Effect.scoped,
  );

function normalizeCursorConfigOptionToken(value: string | null | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-") ?? ""
  );
}

function findCursorSelectOptionValue(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
  matcher: (option: CursorSessionSelectOption) => boolean,
): string | undefined {
  return flattenSessionConfigSelectOptions(configOption).find(matcher)?.value;
}

function findCursorBooleanConfigValue(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
  requested: boolean,
): string | boolean | undefined {
  if (!configOption) {
    return undefined;
  }
  if (configOption.type === "boolean") {
    return requested;
  }
  return findCursorSelectOptionValue(
    configOption,
    (option) => normalizeCursorConfigOptionToken(option.value) === String(requested),
  );
}

export function resolveCursorAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "default";
  return base.includes("[") ? base.slice(0, base.indexOf("[")) : base;
}

export function resolveCursorAcpConfigUpdates(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<{
  readonly configId: string;
  readonly value: string | boolean;
}> {
  if (!configOptions || configOptions.length === 0) {
    return [];
  }

  const updates: Array<{
    readonly configId: string;
    readonly value: string | boolean;
  }> = [];

  const reasoningOption = findCursorEffortConfigOption(configOptions);
  const requestedReasoning = normalizeCursorReasoningValue(
    getProviderOptionStringSelectionValue(selections, "reasoning"),
  );
  if (reasoningOption && requestedReasoning) {
    const value = findCursorSelectOptionValue(reasoningOption, (option) => {
      const normalizedValue = normalizeCursorReasoningValue(option.value);
      const normalizedName = normalizeCursorReasoningValue(option.name);
      return normalizedValue === requestedReasoning || normalizedName === requestedReasoning;
    });
    if (value) {
      updates.push({ configId: reasoningOption.id, value });
    }
  }

  const contextOption = configOptions.find(
    (option) => option.category === "model_config" && isCursorContextConfigOption(option),
  );
  const requestedContextWindow = getProviderOptionStringSelectionValue(selections, "contextWindow");
  if (contextOption && requestedContextWindow) {
    const value = findCursorSelectOptionValue(
      contextOption,
      (option) =>
        normalizeCursorConfigOptionToken(option.value) ===
          normalizeCursorConfigOptionToken(requestedContextWindow) ||
        normalizeCursorConfigOptionToken(option.name) ===
          normalizeCursorConfigOptionToken(requestedContextWindow),
    );
    if (value) {
      updates.push({ configId: contextOption.id, value });
    }
  }

  const fastOption = configOptions.find(
    (option) => option.category === "model_config" && isCursorFastConfigOption(option),
  );
  const requestedFastMode = getProviderOptionBooleanSelectionValue(selections, "fastMode");
  if (fastOption && typeof requestedFastMode === "boolean") {
    const value = findCursorBooleanConfigValue(fastOption, requestedFastMode);
    if (value !== undefined) {
      updates.push({ configId: fastOption.id, value });
    }
  }

  const thinkingOption = configOptions.find(
    (option) => option.category === "model_config" && isCursorThinkingConfigOption(option),
  );
  const requestedThinking = getProviderOptionBooleanSelectionValue(selections, "thinking");
  if (thinkingOption && typeof requestedThinking === "boolean") {
    const value = findCursorBooleanConfigValue(thinkingOption, requestedThinking);
    if (value !== undefined) {
      updates.push({ configId: thinkingOption.id, value });
    }
  }

  return updates;
}

const discoverCursorModelsViaListAvailableModels = (
  cursorSettings: Pick<CursorSettings, "binaryPath" | "apiEndpoint">,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) =>
  withCursorAcpProbeRuntime(
    cursorSettings,
    (acp) =>
      Effect.gen(function* () {
        yield* acp.prepareClient();
        const response = yield* acp.request("cursor/list_available_models", {});
        const decoded = yield* decodeCursorListAvailableModelsResponse(response);
        return buildCursorDiscoveredModelsFromAvailableModelsResponse(decoded);
      }),
    environment,
    cwd,
  );

const snapshotCursorEnvironment = Effect.fn("snapshotCursorEnvironment")(function* (
  environment?: NodeJS.ProcessEnv,
) {
  const snapshot = { ...(yield* HostProcessEnvironment) };
  if (environment) {
    // 保留 ACP 原有夹具隔离：显式环境没有声明的测试开关不能从宿主泄漏。
    for (const key of Object.keys(snapshot)) {
      if (key.startsWith("CODEWORK_ACP_") && !Object.hasOwn(environment, key)) delete snapshot[key];
    }
    Object.assign(snapshot, environment);
  }
  return snapshot;
});

export const discoverCursorModelsViaAcp = Effect.fn("discoverCursorModelsViaAcp")(function* (
  inputSettings: CursorSettings,
  environment?: NodeJS.ProcessEnv,
  sharedCatalog?: CliProviderCatalog,
) {
  const cursorSettings = {
    binaryPath: inputSettings.binaryPath,
    apiEndpoint: inputSettings.apiEndpoint,
  };
  const cwd = yield* HostProcessWorkingDirectory;
  const resolvedEnvironment = yield* snapshotCursorEnvironment(environment);
  const catalog = sharedCatalog ?? (yield* makeCliProviderCatalog());
  // 独立入口没有实时版本和账号身份，只共享在途探针，不能复用完成目录。
  const load = Effect.gen(function* () {
    const controller = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (controller) => Effect.sync(() => controller.abort()),
    );
    return yield* withCatalogAbortSignal(
      discoverCursorModelsViaListAvailableModels(cursorSettings, resolvedEnvironment, cwd),
      controller.signal,
    );
  }).pipe(Effect.scoped, Effect.timeout(CURSOR_REFRESH_TIMEOUT_MS));
  const result = yield* catalog.fetchCatalog({
    key: cliProviderCatalogIdentity({
      driver: ProviderDriverKind.make("cursor"),
      operation: "cursor/list_available_models:unverified",
      config: {
        binaryPath: cursorSettings.binaryPath,
        apiEndpoint: cursorSettings.apiEndpoint,
        clientCapabilities: CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
      },
      cwd,
      environment: resolvedEnvironment,
    }),
    forceRefresh: true,
    load: load.pipe(Effect.map((models) => ({ models }))),
  });
  return result.models;
});

export function getCursorFallbackModels(
  cursorSettings: Pick<CursorSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings([], cursorSettings.customModels, EMPTY_CAPABILITIES);
}

/** Strip ANSI escape sequences so we can parse plain key-value lines. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07/g, "");
}

/**
 * Extract a value from `agent about` key-value output.
 * Lines look like: `CLI Version         2026.03.20-44cb435`
 */
function extractAboutField(plain: string, key: string): string | undefined {
  const regex = new RegExp(`^${key}\\s{2,}(.+)$`, "mi");
  const match = regex.exec(plain);
  return match?.[1]?.trim();
}

export interface CursorAboutResult {
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

function joinProviderMessages(...messages: ReadonlyArray<string | undefined>): string | undefined {
  const parts: Array<string> = [];
  for (const message of messages) {
    const trimmed = message?.trim();
    if (trimmed) {
      parts.push(trimmed);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function buildCursorCliCommandMissingMessage(binaryPath: string): string {
  return [
    `Cursor CLI command \`${binaryPath}\` was not found.`,
    `Install or enable the Cursor CLI, make sure \`${binaryPath}\` is on PATH, then restart Code Work.`,
    `See ${CURSOR_CLI_INSTALLATION_DOCS_URL}.`,
  ].join(" ");
}

export function buildCursorProviderSnapshot(input: {
  readonly checkedAt: string;
  readonly cursorSettings: CursorSettings;
  readonly parsed: CursorAboutResult;
  readonly discoveredModels?: ReadonlyArray<ServerProviderModel>;
  readonly discoveryWarning?: string;
}): ServerProviderDraft {
  const message = joinProviderMessages(input.parsed.message, input.discoveryWarning);
  return buildServerProvider({
    presentation: CURSOR_PRESENTATION,
    enabled: input.cursorSettings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      input.discoveredModels ?? [],
      input.cursorSettings.customModels,
      EMPTY_CAPABILITIES,
    ),
    probe: {
      installed: true,
      version: input.parsed.version,
      status:
        input.discoveryWarning && input.parsed.status === "ready" ? "warning" : input.parsed.status,
      auth: input.parsed.auth,
      ...(message ? { message } : {}),
    },
  });
}

interface CursorAboutJsonPayload {
  readonly cliVersion?: unknown;
  readonly subscriptionTier?: unknown;
  readonly userEmail?: unknown;
}

export function parseCursorVersionDate(version: string | null | undefined): number | undefined {
  const match = version?.trim().match(/^(\d{4})\.(\d{2})\.(\d{2})(?:\b|-|$)/);
  if (!match) {
    return undefined;
  }
  const [, year, month, day] = match;
  return Number(`${year}${month}${day}`);
}

export function parseCursorCliConfigChannel(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "channel" in parsed &&
      typeof parsed.channel === "string"
    ) {
      const channel = parsed.channel.trim().toLowerCase();
      return channel.length > 0 ? channel : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function toTitleCaseWords(value: string): string {
  const parts: Array<string> = [];
  for (const part of value.split(/[\s_-]+/g)) {
    if (part.length > 0) {
      parts.push(part.charAt(0).toUpperCase() + part.slice(1).toLowerCase());
    }
  }
  return parts.join(" ");
}

function cursorSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    case "business":
      return "Business";
    case "enterprise":
      return "Enterprise";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function cursorAuthMetadata(
  subscriptionType: string | undefined,
): Pick<ServerProviderAuth, "label" | "type"> | undefined {
  if (!subscriptionType) {
    return undefined;
  }
  const subscriptionLabel = cursorSubscriptionLabel(subscriptionType);
  return {
    type: subscriptionType,
    label: `Cursor ${subscriptionLabel ?? toTitleCaseWords(subscriptionType)} Subscription`,
  };
}

function parseCursorAboutJsonPayload(raw: string): CursorAboutJsonPayload | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as CursorAboutJsonPayload;
  } catch {
    return undefined;
  }
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isCursorAboutJsonFormatUnsupported(result: CommandResult): boolean {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    lowerOutput.includes("unknown option '--format'") ||
    lowerOutput.includes("unexpected argument '--format'") ||
    lowerOutput.includes("unrecognized option '--format'") ||
    lowerOutput.includes("unknown argument '--format'")
  );
}

const readCursorCliConfigChannel = Effect.fn("readCursorCliConfigChannel")(function* (
  configPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem.readFileString(configPath).pipe(Effect.orElseSucceed(() => ""));
  return parseCursorCliConfigChannel(raw);
});

export function getCursorParameterizedModelPickerUnsupportedMessage(input: {
  readonly version: string | null | undefined;
  readonly channel: string | null | undefined;
}): string | undefined {
  const reasons: Array<string> = [];
  const versionDate = parseCursorVersionDate(input.version);
  if (
    versionDate !== undefined &&
    versionDate < CURSOR_PARAMETERIZED_MODEL_PICKER_MIN_VERSION_DATE
  ) {
    reasons.push(
      `Cursor Agent CLI version ${input.version} is too old for Cursor ACP parameterized model picker`,
    );
  }

  const normalizedChannel = input.channel?.trim().toLowerCase();
  if (
    normalizedChannel !== undefined &&
    normalizedChannel.length > 0 &&
    normalizedChannel !== "lab"
  ) {
    reasons.push(
      `Cursor Agent CLI channel is ${JSON.stringify(input.channel)}, but parameterized model picker is only available on the lab channel`,
    );
  }

  if (reasons.length === 0) {
    return undefined;
  }

  return `${reasons.join(". ")}. Run \`agent set-channel lab && agent update\` and use Cursor Agent CLI 2026.04.08 or newer.`;
}

/**
 * Parse the output of `agent about` to extract version and authentication
 * status in a single probe.
 *
 * Example output (logged in):
 * ```
 * About Cursor CLI
 *
 * CLI Version         2026.03.20-44cb435
 * User Email          user@example.com
 * ```
 *
 * Example output (logged out):
 * ```
 * About Cursor CLI
 *
 * CLI Version         2026.03.20-44cb435
 * User Email          Not logged in
 * ```
 */
export function parseCursorAboutOutput(result: CommandResult): CursorAboutResult {
  const jsonPayload = parseCursorAboutJsonPayload(result.stdout);
  if (jsonPayload) {
    const version =
      typeof jsonPayload.cliVersion === "string" ? jsonPayload.cliVersion.trim() : null;
    const hasUserEmailField = hasOwn(jsonPayload, "userEmail");
    const userEmail =
      typeof jsonPayload.userEmail === "string" ? jsonPayload.userEmail.trim() : undefined;
    const subscriptionType =
      typeof jsonPayload.subscriptionTier === "string"
        ? jsonPayload.subscriptionTier.trim()
        : undefined;
    const authMetadata = cursorAuthMetadata(subscriptionType);

    if (hasUserEmailField && jsonPayload.userEmail == null) {
      return {
        version,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
      };
    }

    if (!userEmail) {
      if (result.code === 0) {
        return {
          version,
          status: "ready",
          auth: {
            status: "unknown",
            ...authMetadata,
          },
        };
      }
      return {
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify Cursor Agent authentication status.",
      };
    }

    const lowerEmail = userEmail.toLowerCase();
    if (
      lowerEmail === "not logged in" ||
      lowerEmail.includes("login required") ||
      lowerEmail.includes("authentication required")
    ) {
      return {
        version,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
      };
    }

    return {
      version,
      status: "ready",
      auth: {
        status: "authenticated",
        email: userEmail,
        ...authMetadata,
      },
    };
  }

  const combined = `${result.stdout}\n${result.stderr}`;
  const lowerOutput = combined.toLowerCase();

  // If the command itself isn't recognised, we're on an old CLI version.
  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "The `agent about` command is unavailable in this version of the Cursor Agent CLI.",
    };
  }

  const plain = stripAnsi(combined);
  const version = extractAboutField(plain, "CLI Version") ?? null;
  const userEmail = extractAboutField(plain, "User Email");

  // Determine auth from the User Email field.
  if (userEmail === undefined) {
    // Field missing entirely — can't determine auth.
    if (result.code === 0) {
      return { version, status: "ready", auth: { status: "unknown" } };
    }
    return {
      version,
      status: "warning",
      auth: { status: "unknown" },
      message: "Could not verify Cursor Agent authentication status.",
    };
  }

  const lowerEmail = userEmail.toLowerCase();
  if (
    lowerEmail === "not logged in" ||
    lowerEmail.includes("login required") ||
    lowerEmail.includes("authentication required")
  ) {
    return {
      version,
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
    };
  }

  // Any non-empty email value means authenticated.
  return {
    version,
    status: "ready",
    auth: { status: "authenticated", email: userEmail },
  };
}

const runCursorCommand = (
  cursorSettings: CursorSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawnCommand = yield* resolveSpawnCommand(cursorSettings.binaryPath, args, {
      env: environment,
      extendEnv: false,
      cwd,
    });
    const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      extendEnv: false,
      cwd,
      shell: spawnCommand.shell,
      forceKillAfter: "2 seconds",
    });

    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

const runCursorAboutCommand = (
  cursorSettings: CursorSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) =>
  Effect.gen(function* () {
    const jsonResult = yield* runCursorCommand(
      cursorSettings,
      ["about", "--format", "json"],
      environment,
      cwd,
    );
    if (!isCursorAboutJsonFormatUnsupported(jsonResult)) {
      return jsonResult;
    }
    return yield* runCursorCommand(cursorSettings, ["about"], environment, cwd);
  });

export const checkCursorProviderStatus = Effect.fn("checkCursorProviderStatus")(function* (
  inputSettings: CursorSettings,
  environment?: NodeJS.ProcessEnv,
  catalog?: CliProviderCatalog,
  nativeCatalog?: NativeProviderCatalog,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const cursorSettings = { ...inputSettings, customModels: [...inputSettings.customModels] };
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = getCursorFallbackModels(cursorSettings);
  const cwd = yield* HostProcessWorkingDirectory;
  const resolvedEnvironment = yield* snapshotCursorEnvironment(environment);

  if (!cursorSettings.enabled) {
    return buildServerProvider({
      presentation: CURSOR_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Cursor is disabled in Code Work settings.",
      },
    });
  }

  const path = yield* Path.Path;
  const configPath = path.join(NodeOS.homedir(), ".cursor", "cli-config.json");
  const providerCatalog = catalog ?? (yield* makeCliProviderCatalog());
  const native = nativeCatalog ?? (yield* makeNativeProviderCatalog());
  const nativeSettings = { ...cursorSettings, customModels: [] };
  let lastParsed: CursorAboutResult | undefined;
  const snapshot = yield* native.fetchCatalog({
    key: cliProviderCatalogIdentity({
      driver: ProviderDriverKind.make("cursor"),
      operation: "cursor/provider-refresh",
      config: {
        binaryPath: cursorSettings.binaryPath,
        apiEndpoint: cursorSettings.apiEndpoint,
        configPath,
        clientCapabilities: CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
      },
      cwd,
      environment: resolvedEnvironment,
    }),
    timeoutMs: CURSOR_REFRESH_TIMEOUT_MS,
    onTimeout: () =>
      buildCursorProviderSnapshot({
        checkedAt,
        cursorSettings: nativeSettings,
        parsed: lastParsed ?? {
          version: null,
          status: "error",
          auth: { status: "unknown" },
        },
        discoveryWarning: `Cursor provider refresh timed out after ${CURSOR_REFRESH_TIMEOUT_MS}ms.`,
      }),
    load: (controller) =>
      withCatalogAbortSignal(
        Effect.gen(function* () {
          const aboutProbe = yield* runCursorAboutCommand(
            nativeSettings,
            resolvedEnvironment,
            cwd,
          ).pipe(Effect.result);
          if (Result.isFailure(aboutProbe)) {
            const error = aboutProbe.failure;
            yield* Effect.logWarning("Cursor Agent CLI health check failed.", {
              errorTag: error._tag,
            });
            return buildServerProvider({
              presentation: CURSOR_PRESENTATION,
              enabled: true,
              checkedAt,
              models: [],
              probe: {
                installed: !isCommandMissingCause(error),
                version: null,
                status: "error",
                auth: { status: "unknown" },
                message: isCommandMissingCause(error)
                  ? buildCursorCliCommandMissingMessage(nativeSettings.binaryPath)
                  : "Failed to execute Cursor Agent CLI health check.",
              },
            });
          }
          const parsed = parseCursorAboutOutput(aboutProbe.success);
          lastParsed = parsed;
          const channel = yield* readCursorCliConfigChannel(configPath);
          const unsupportedMessage = getCursorParameterizedModelPickerUnsupportedMessage({
            version: parsed.version,
            channel,
          });
          if (unsupportedMessage) {
            return buildCursorProviderSnapshot({
              checkedAt,
              cursorSettings: nativeSettings,
              parsed: {
                ...parsed,
                status: "error",
                message:
                  parsed.auth.status === "unauthenticated" && parsed.message
                    ? `${unsupportedMessage} ${parsed.message}`
                    : unsupportedMessage,
              },
            });
          }
          let discoveredModels: ReadonlyArray<ServerProviderModel> = [];
          let discoveryWarning: string | undefined;
          if (parsed.auth.status !== "unauthenticated") {
            const discover = withCatalogAbortSignal(
              discoverCursorModelsViaListAvailableModels(nativeSettings, resolvedEnvironment, cwd),
              controller.signal,
            );
            // OAuth 邮箱是当前 about 可验证的稳定身份；未知身份不读写完成缓存。
            const stableIdentity =
              parsed.version?.trim() &&
              parsed.auth.status === "authenticated" &&
              parsed.auth.email?.trim();
            const result = yield* stableIdentity
              ? providerCatalog
                  .fetchCatalog({
                    key: cliProviderCatalogIdentity({
                      driver: ProviderDriverKind.make("cursor"),
                      operation: "cursor/list_available_models:verified",
                      config: {
                        binaryPath: nativeSettings.binaryPath,
                        apiEndpoint: nativeSettings.apiEndpoint,
                        configPath,
                        version: parsed.version,
                        channel,
                        auth: parsed.auth,
                        clientCapabilities: CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
                      },
                      cwd,
                      environment: resolvedEnvironment,
                    }),
                    shareInFlight: false,
                    load: discover.pipe(Effect.map((models) => ({ models }))),
                  })
                  .pipe(
                    Effect.map((result) => result.models),
                    Effect.result,
                  )
              : discover.pipe(Effect.result);
            if (result._tag === "Failure") {
              yield* Effect.logWarning("Cursor ACP model discovery failed", {
                errorTag: result.failure._tag,
              });
              discoveryWarning = CURSOR_ACP_MODEL_DISCOVERY_FAILED_MESSAGE;
            } else if (result.success.length === 0) {
              discoveryWarning = "Cursor ACP model discovery returned no built-in models.";
            } else {
              discoveredModels = result.success;
            }
          }
          return buildCursorProviderSnapshot({
            checkedAt,
            cursorSettings: nativeSettings,
            parsed,
            discoveredModels,
            ...(discoveryWarning ? { discoveryWarning } : {}),
          });
        }),
        controller.signal,
      ),
  });
  return {
    ...snapshot,
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    models: providerModelsFromSettings(
      snapshot.models,
      cursorSettings.customModels,
      EMPTY_CAPABILITIES,
    ),
  };
});

/**
 * Background maintenance enrichment for a Cursor snapshot.
 *
 * Used by `CursorDriver` as the `makeManagedServerProvider.enrichSnapshot`
 * hook: republishes update/version advisory metadata without performing any
 * model or capability discovery. Cursor model data comes exclusively from
 * `cursor/list_available_models` during provider status checks.
 */
export const enrichCursorSnapshot = (input: {
  readonly settings: CursorSettings;
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly stampIdentity?: (snapshot: ServerProvider) => ServerProvider;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { settings, snapshot, publishSnapshot } = input;
  const stampIdentity = input.stampIdentity ?? ((value) => value);

  if (!settings.enabled || snapshot.auth.status === "unauthenticated") {
    return Effect.void;
  }

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) =>
      publishSnapshot(stampIdentity(enrichedSnapshot)).pipe(Effect.as(enrichedSnapshot)),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Cursor version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.asVoid),
    ),
  );
};
