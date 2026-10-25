import { type CursorSettings, type ProviderOptionSelection } from "@codework/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
  resolveCursorAcpBaseModelId,
  resolveCursorAcpConfigUpdates,
} from "../Layers/CursorProvider.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import {
  collectSessionConfigOptionValues,
  extractModelConfigId,
  findSessionConfigOption,
} from "./AcpRuntimeModel.ts";

type CursorAcpRuntimeCursorSettings = Pick<CursorSettings, "apiEndpoint" | "binaryPath">;

export interface CursorAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly cursorSettings: CursorAcpRuntimeCursorSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly acpCommand?: string;
  readonly acpArgs?: ReadonlyArray<string>;
  readonly authMethodId?: string;
  readonly clientName?: string;
}

export interface CursorAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option" | "set-model";
  readonly configId?: string;
}

export function buildCursorAcpSpawnInput(
  cursorSettings: CursorAcpRuntimeCursorSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: cursorSettings?.binaryPath || "cursor-agent",
    args: [
      ...(cursorSettings?.apiEndpoint ? (["-e", cursorSettings.apiEndpoint] as const) : []),
      "acp",
    ],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeCursorAcpRuntime = (
  input: CursorAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const clientCapabilities = {
      ...input.clientCapabilities,
      _meta: {
        ...CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES._meta,
        ...input.clientCapabilities?._meta,
      },
    } satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: input.acpCommand
          ? {
              command: input.acpCommand,
              args: input.acpArgs ?? ["acp"],
              cwd: input.cwd,
              ...(input.environment ? { env: input.environment } : {}),
            }
          : buildCursorAcpSpawnInput(input.cursorSettings, input.cwd, input.environment),
        authMethodId: input.authMethodId ?? "cursor_login",
        clientInfo: {
          name: input.clientName ?? input.clientInfo.name,
          version: input.clientInfo.version,
        },
        clientCapabilities,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

interface CursorAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntime.AcpSessionRuntime["Service"]["getConfigOptions"];
  readonly getAvailableModels: AcpSessionRuntime.AcpSessionRuntime["Service"]["getAvailableModels"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export interface CursorAcpModelSelectionResult {
  /** 对齐当前目录后实际生效的模型 ID；目录整体撤回时为 undefined（未派发任何模型设置）。 */
  readonly appliedModel: string | undefined;
  /** 请求模型不在当前目录且被回退或丢弃时为请求的原始 ID。 */
  readonly withdrawnModel: string | undefined;
}

/** 重启/恢复后旧目录可能已撤回：请求值先按广告对齐到当前值或首个可选项，目录为空则不派发。 */
export function applyCursorAcpModelSelection<E>(input: {
  readonly runtime: CursorAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: CursorAcpModelSelectionErrorContext) => E;
}): Effect.Effect<CursorAcpModelSelectionResult, E> {
  return Effect.gen(function* () {
    const configOptions = yield* input.runtime.getConfigOptions;
    const requestedRaw = input.model?.trim() || "default";
    const requestedBase = resolveCursorAcpBaseModelId(input.model);
    const candidates =
      requestedRaw === requestedBase ? [requestedBase] : [requestedRaw, requestedBase];

    const modelConfigId = extractModelConfigId({ configOptions });
    const modelOption = modelConfigId
      ? findSessionConfigOption(configOptions, modelConfigId)
      : undefined;

    let appliedModel: string | undefined;
    let withdrawnModel: string | undefined;
    if (modelOption !== undefined) {
      const allowedValues = collectSessionConfigOptionValues(modelOption);
      appliedModel = candidates.find((candidate) => allowedValues.includes(candidate));
      if (appliedModel === undefined) {
        withdrawnModel = requestedRaw;
        const currentValue = modelOption.currentValue;
        appliedModel =
          typeof currentValue === "string" && allowedValues.includes(currentValue)
            ? currentValue
            : allowedValues[0];
      }
    } else {
      const advertisedModels = yield* input.runtime.getAvailableModels;
      if (advertisedModels === null) {
        // CLI 未提供模型目录信息，保持原透传语义让 CLI 自行校验。
        appliedModel = requestedBase;
      } else {
        appliedModel = candidates.find((candidate) =>
          advertisedModels.some((model) => model.slug === candidate),
        );
        if (appliedModel === undefined) {
          withdrawnModel = requestedRaw;
          appliedModel =
            advertisedModels.find((model) => model.isDefault)?.slug ?? advertisedModels[0]?.slug;
        }
      }
    }

    if (appliedModel !== undefined) {
      yield* input.runtime.setModel(appliedModel).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-model",
          }),
        ),
      );
    }

    // 模型切换后才出现 per-model 配置（reasoning/context/fast 等），必须以最新快照解析。
    const configUpdates = resolveCursorAcpConfigUpdates(
      yield* input.runtime.getConfigOptions,
      input.selections,
    );
    for (const update of configUpdates) {
      yield* input.runtime.setConfigOption(update.configId, update.value).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-config-option",
            configId: update.configId,
          }),
        ),
      );
    }

    return { appliedModel, withdrawnModel };
  });
}
