/**
 * pi-family（Pi / OhMyPi）的 BYOK 受管配置。
 *
 * 这两个 Provider 只有 BYOK 一种形态：实例的受管 agent 目录
 * （`PI_CODING_AGENT_DIR` 指向 `stateDir/provider-homes/pi-family/...`）里
 * 只写一份 `models.json`，把 Code Work 网关注册为唯一的模型供应商——
 * 目录里没有 auth.json、进程环境清洗掉常见供应商密钥，CLI 因此物理上
 * 接触不到其他模型凭据（2026-09-10 用 omp 17.4.2 实测：受管目录下
 * `get_available_models` 只返回注册的 provider）。
 *
 * @module provider/pifamily/byokProviderConfig
 */
// @effect-diagnostics preferSchemaOverJson:off - 本模块生成 CLI 配置文件（models.json），JSON 序列化是正确工具。
// @effect-diagnostics nodeBuiltinImport:off - 纯路径计算，与 grokHome 同一模式。
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { ByokModelAdapter, ProviderInstanceId, ServerSettings } from "@codework/contracts";

import { writeFileStringAtomically } from "../../atomicWrite.ts";

/** models.json 里的两个网关 provider 名；按协议拆分，model id 用 BYOK adapter id。 */
export const PI_FAMILY_BYOK_PROVIDER_OPENAI = "codework-openai";
export const PI_FAMILY_BYOK_PROVIDER_ANTHROPIC = "codework-anthropic";

const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

/**
 * 受管 agent 目录（绝对路径）。`PI_CONFIG_DIR` 在 OMP 里是相对 home 拼接的
 * （绝对路径会被 join 出垃圾路径），所以隔离一律走支持绝对路径的
 * `PI_CODING_AGENT_DIR`。
 */
export function resolvePifamilyAgentDir(input: {
  readonly stateDir: string;
  readonly driverKind: "piAgent" | "ompAgent";
  readonly instanceId: ProviderInstanceId | string;
}): string {
  return NodePath.join(
    input.stateDir,
    "provider-homes",
    "pi-family",
    input.driverKind,
    `instance-${encodeURIComponent(input.instanceId).replace(/\./g, "%2E")}`,
    "agent",
  );
}

/**
 * 需要从子进程环境里剥掉的变量：第三方供应商密钥（否则 CLI 仍可能凭环境
 * 变量连上自己的账号，破坏 fail-closed），以及会把 OMP/pi 指回用户目录或
 * 其它模型角色的 pi-family 变量。
 */
const PI_FAMILY_SCRUBBED_ENV_KEYS: ReadonlySet<string> = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "GLAMA_API_KEY",
  "REQUESTY_API_KEY",
  "MOONSHOT_API_KEY",
  "ZHIPU_API_KEY",
  "DASHSCOPE_API_KEY",
  "PI_CONFIG_DIR",
  "OMP_PROFILE",
  "PI_PROFILE",
  "PI_SMOL_MODEL",
  "PI_SLOW_MODEL",
  "PI_PLAN_MODEL",
]);

export function scrubPifamilyEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const scrubbed: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (PI_FAMILY_SCRUBBED_ENV_KEYS.has(key)) continue;
    if (value === undefined) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}

export interface PifamilyModelRoute {
  /** BYOK adapter id —— 网关按它路由，models.json 的 model id 也用它。 */
  readonly adapterId: string;
  readonly protocol: "openai" | "anthropic";
  readonly displayName: string;
  readonly modelId: string;
  readonly contextWindowTokens: number;
}

/** 从任意 BYOK 实例配置里提取 adapterId → contextWindowTokens 的尽力查找表。 */
function contextWindowByAdapterId(settings: ServerSettings): Map<string, number> {
  const lookup = new Map<string, number>();
  for (const entry of Object.values(settings.providerInstances)) {
    if (entry.driver !== "byok") continue;
    const config = entry.config;
    if (config === null || typeof config !== "object" || Array.isArray(config)) continue;
    const adapters = (config as { readonly adapters?: unknown }).adapters;
    if (!Array.isArray(adapters)) continue;
    for (const adapter of adapters) {
      if (typeof adapter !== "object" || adapter === null) continue;
      const candidate = adapter as Partial<ByokModelAdapter>;
      if (typeof candidate.id !== "string") continue;
      if (
        typeof candidate.contextWindowTokens === "number" &&
        Number.isSafeInteger(candidate.contextWindowTokens) &&
        candidate.contextWindowTokens > 0
      ) {
        lookup.set(candidate.id, candidate.contextWindowTokens);
      }
    }
  }
  return lookup;
}

/**
 * 把网关路由整理成 pi-family 适配器可用的模型路由（gemini 协议不经网关，
 * 直接排除——这是网关的既有边界）。
 */
export function pifamilyModelRoutes(
  routes: ReadonlyArray<{
    readonly id: string;
    readonly protocol: "openai" | "anthropic" | "gemini";
    readonly displayName: string;
    readonly modelId: string;
  }>,
  settings: ServerSettings,
): ReadonlyArray<PifamilyModelRoute> {
  const contextWindows = contextWindowByAdapterId(settings);
  const gatewayRoutable: ReadonlyArray<{
    readonly id: string;
    readonly protocol: "openai" | "anthropic";
    readonly displayName: string;
    readonly modelId: string;
  }> = routes.flatMap((route) =>
    route.protocol === "gemini" ? [] : [route as (typeof gatewayRoutable)[number]],
  );
  return gatewayRoutable.map((route) => ({
    adapterId: route.id,
    protocol: route.protocol,
    displayName: route.displayName.trim().length > 0 ? route.displayName : route.modelId,
    modelId: route.modelId,
    contextWindowTokens: contextWindows.get(route.id) ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
  }));
}

export function pifamilyProviderNameForProtocol(protocol: "openai" | "anthropic"): string {
  return protocol === "openai" ? PI_FAMILY_BYOK_PROVIDER_OPENAI : PI_FAMILY_BYOK_PROVIDER_ANTHROPIC;
}

interface PifamilyModelsJsonModel {
  readonly id: string;
  readonly name: string;
  readonly input: ReadonlyArray<string>;
  readonly contextWindow: number;
  readonly reasoning: boolean;
}

interface PifamilyModelsJsonProvider {
  readonly name: string;
  readonly baseUrl: string;
  readonly api: string;
  readonly apiKey: string;
  readonly models: ReadonlyArray<PifamilyModelsJsonModel>;
}

export interface PifamilyModelsJson {
  readonly providers: Record<string, PifamilyModelsJsonProvider>;
}

/**
 * 生成受管 `models.json` 内容。openai / anthropic 各注册一个 provider，
 * 指向本地 BYOK 网关；`apiKey` 是网关 token（不是真实供应商密钥），只落
 * 在 0600 的受管文件里，不进 argv、日志或事件。
 */
export function buildPifamilyModelsJson(input: {
  readonly routes: ReadonlyArray<PifamilyModelRoute>;
  readonly openaiBaseUrl: string;
  readonly anthropicBaseUrl: string;
  readonly gatewayToken: string;
}): PifamilyModelsJson {
  const openaiModels: PifamilyModelsJsonModel[] = [];
  const anthropicModels: PifamilyModelsJsonModel[] = [];
  for (const route of input.routes) {
    const model: PifamilyModelsJsonModel = {
      id: route.adapterId,
      name: route.displayName,
      input: ["text"],
      contextWindow: route.contextWindowTokens,
      reasoning: false,
    };
    if (route.protocol === "openai") {
      openaiModels.push(model);
    } else {
      anthropicModels.push(model);
    }
  }
  const providers: Record<string, PifamilyModelsJsonProvider> = {};
  if (openaiModels.length > 0) {
    providers[PI_FAMILY_BYOK_PROVIDER_OPENAI] = {
      name: "Code Work BYOK Gateway (OpenAI)",
      baseUrl: input.openaiBaseUrl,
      api: "openai-completions",
      apiKey: input.gatewayToken,
      models: openaiModels,
    };
  }
  if (anthropicModels.length > 0) {
    providers[PI_FAMILY_BYOK_PROVIDER_ANTHROPIC] = {
      name: "Code Work BYOK Gateway (Anthropic)",
      baseUrl: input.anthropicBaseUrl,
      api: "anthropic-messages",
      apiKey: input.gatewayToken,
      models: anthropicModels,
    };
  }
  return { providers };
}

export class PifamilyConfigWriteError extends Schema.TaggedErrorClass<PifamilyConfigWriteError>()(
  "PifamilyConfigWriteError",
  { agentDir: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Failed to write pi-family BYOK config under ${this.agentDir}: ${this.detail}`;
  }
}

/**
 * 把 models.json 原子写入受管 agent 目录（含父目录创建，0600 权限）。
 * 密钥只出现在这份本地文件里。
 */
export const writePifamilyByokConfig = Effect.fn("pifamily.writePifamilyByokConfig")(
  function* (input: {
    readonly agentDir: string;
    readonly modelsJson: PifamilyModelsJson;
  }): Effect.fn.Return<void, PifamilyConfigWriteError, FileSystem.FileSystem | Path.Path> {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(input.agentDir, "models.json");
    // 生成的是 CLI 配置文件，不是协议解析，JSON 序列化是正确工具。
    const contents = `${JSON.stringify(input.modelsJson, null, 2)}\n`;
    yield* writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.mapError(
        (cause) =>
          new PifamilyConfigWriteError({
            agentDir: input.agentDir,
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    );
    yield* fileSystem.chmod(filePath, 0o600).pipe(Effect.catchCause(() => Effect.void));
  },
);
