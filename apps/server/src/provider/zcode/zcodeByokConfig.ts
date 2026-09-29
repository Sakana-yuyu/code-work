// @effect-diagnostics preferSchemaOverJson:off - 本模块生成 CLI 配置文件（provider_config.json），JSON 序列化是正确工具。
// @effect-diagnostics nodeBuiltinImport:off - 纯路径计算，与 pifamily 同一模式。
/**
 * ZCode 的 BYOK 受管配置。
 *
 * ZCode 的数据根由 `ZCODE_DATA_BASE_DIR` 决定，个人 Provider 配置固定在
 * `<根>/.zcode/v2/provider_config.json`。受管根里只写一份文件：把 Code Work
 * 网关注册为唯一的个人 Provider（按协议拆成 openai / anthropic 两个），
 * 进程因此物理上接触不到其他模型凭据；号池（本地 CLI 账号）路由同样经网关
 * 发布，无需额外配置。
 *
 * 文件形状来自 zai-org/ZCode 的 `provider-config-file-codec`（schemaVersion 1），
 * 模型能力交给内置 `.*` 规则兜底，这里只覆盖上下文窗口。
 *
 * @module provider/zcode/zcodeByokConfig
 */
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { ProviderInstanceId } from "@codework/contracts";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import type { PifamilyModelRoute } from "../pifamily/byokProviderConfig.ts";

export const ZCODE_BYOK_PROVIDER_OPENAI = "codework-openai";
export const ZCODE_BYOK_PROVIDER_ANTHROPIC = "codework-anthropic";
/** 号池里的 Codex 官方账号只有 Responses 上游，chat-completions 走不通。 */
export const ZCODE_BYOK_PROVIDER_RESPONSES = "codework-responses";

/** 受管数据根（`ZCODE_DATA_BASE_DIR`）；每个实例独立，会话与凭据互不串。 */
export function resolveZCodeDataDir(input: {
  readonly stateDir: string;
  readonly instanceId: ProviderInstanceId | string;
}): string {
  return NodePath.join(
    input.stateDir,
    "provider-homes",
    "zcode",
    `instance-${encodeURIComponent(input.instanceId).replace(/\./g, "%2E")}`,
  );
}

export function zcodeProviderConfigPath(dataDir: string): string {
  return NodePath.join(dataDir, ".zcode", "v2", "provider_config.json");
}

/** 需要从子进程环境里剥掉的变量：否则 CLI 仍可能凭环境变量连上自己的账号。 */
const ZCODE_SCRUBBED_ENV_KEYS: ReadonlySet<string> = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "MOONSHOT_API_KEY",
  "ZHIPU_API_KEY",
  "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
  "ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE",
  "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
]);

export function scrubZCodeEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const scrubbed: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (ZCODE_SCRUBBED_ENV_KEYS.has(key) || value === undefined) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}

export function zcodeProviderIdForRoute(route: PifamilyModelRoute): string {
  if (route.protocol === "anthropic") return ZCODE_BYOK_PROVIDER_ANTHROPIC;
  return route.localProvider === "codex"
    ? ZCODE_BYOK_PROVIDER_RESPONSES
    : ZCODE_BYOK_PROVIDER_OPENAI;
}

/** `defaultModelSelection` 的目标；BYOK 通道与官方账号两种模式共用同一字段。 */
export interface ZCodeDefaultModelSelection {
  readonly providerId: string;
  readonly modelId: string;
}

/** 选中 BYOK 通道时的 defaultModelSelection。 */
export function zcodeByokSelection(route: PifamilyModelRoute): ZCodeDefaultModelSelection {
  return { providerId: zcodeProviderIdForRoute(route), modelId: route.adapterId };
}

/**
 * 生成 provider_config.json。`defaultModelSelection` 由调用方算好传入：ZCode
 * 没有 `--model` 参数，每轮启动前按本轮所选通道/官方模型重写该字段。
 */
export function buildZCodeProviderConfig(input: {
  readonly routes: ReadonlyArray<PifamilyModelRoute>;
  readonly openaiBaseUrl: string;
  readonly anthropicBaseUrl: string;
  readonly gatewayToken: string;
  readonly defaultModelSelection: ZCodeDefaultModelSelection | undefined;
}) {
  const groups = [
    {
      providerId: ZCODE_BYOK_PROVIDER_ANTHROPIC,
      providerName: "Code Work BYOK (Anthropic)",
      apiType: "anthropic-messages" as const,
      baseUrl: input.anthropicBaseUrl,
    },
    {
      providerId: ZCODE_BYOK_PROVIDER_OPENAI,
      providerName: "Code Work BYOK (OpenAI)",
      apiType: "openai-chat-completions" as const,
      baseUrl: input.openaiBaseUrl,
    },
    {
      providerId: ZCODE_BYOK_PROVIDER_RESPONSES,
      providerName: "Code Work 号池 (Responses)",
      apiType: "openai-responses" as const,
      baseUrl: input.openaiBaseUrl,
    },
  ]
    .map((group) => ({
      ...group,
      routes: input.routes.filter((route) => zcodeProviderIdForRoute(route) === group.providerId),
    }))
    .filter((group) => group.routes.length > 0);

  return {
    schemaVersion: 1,
    config: {
      providerOrder: groups.map((group) => group.providerId),
      providerConfigRules: {
        providerRules: groups.map((group) => ({
          providerId: group.providerId,
          providerName: group.providerName,
          enabled: true,
          config: {
            group: "standard-personal",
            access: { type: "api-key", apiKey: input.gatewayToken },
            api: { type: group.apiType, baseUrl: group.baseUrl },
            personalModelIds: group.routes.map((route) => route.adapterId),
            visibility: "visible",
          },
        })),
      },
      modelConfigRules: {
        providerModelRules: groups.flatMap((group) =>
          group.routes.map((route) => ({
            providerId: group.providerId,
            modelId: route.adapterId,
            config: { enabled: true, properties: { contextWindow: route.contextWindowTokens } },
          })),
        ),
        manualProviderModelRules: [],
      },
      ...(input.defaultModelSelection === undefined
        ? {}
        : {
            defaultModelSelection: {
              ...input.defaultModelSelection,
              options: { reasoningLevel: "enabled" },
            },
          }),
    },
  };
}

export class ZCodeConfigWriteError extends Schema.TaggedErrorClass<ZCodeConfigWriteError>()(
  "ZCodeConfigWriteError",
  { dataDir: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Failed to write ZCode BYOK config under ${this.dataDir}: ${this.detail}`;
  }
}

/** 原子写入受管配置（含父目录创建，0600 权限）；网关令牌只出现在这份本地文件里。 */
export const writeZCodeProviderConfig = Effect.fn("zcode.writeZCodeProviderConfig")(
  function* (input: {
    readonly dataDir: string;
    readonly config: ReturnType<typeof buildZCodeProviderConfig>;
  }): Effect.fn.Return<void, ZCodeConfigWriteError, FileSystem.FileSystem | Path.Path> {
    const fileSystem = yield* FileSystem.FileSystem;
    const filePath = zcodeProviderConfigPath(input.dataDir);
    yield* writeFileStringAtomically({
      filePath,
      contents: `${JSON.stringify(input.config, null, 2)}\n`,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ZCodeConfigWriteError({
            dataDir: input.dataDir,
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    );
    yield* fileSystem.chmod(filePath, 0o600).pipe(Effect.catchCause(() => Effect.void));
  },
);
