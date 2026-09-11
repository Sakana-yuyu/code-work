// @effect-diagnostics globalDateInEffect:off - 快照时间戳按墙上时间记录。
/**
 * GenericAcpDriver — 用户自配置的通用 ACP Agent 入口。
 *
 * 任意 `Agent Client Protocol` CLI（JSON-RPC over stdio）都能接入：设置里
 * 填完整启动命令即可。会话编排完整复用 Cursor/Kimi 的 ACP 适配层（fs /
 * terminal 请求经 ToolBroker，权限走 request.opened 审批链）。
 *
 * 模型路由由 agent 自身解释；开启 `routeThroughByok` 时注入标准
 * OpenAI/Anthropic 环境变量指向本地 BYOK 网关（fail-closed：读这些变量的
 * agent 全部走网关）。BYOK 强制只对 pi/omp 这类受管配置的 Provider 成立，
 * 通用 ACP 如实按「BYOK 优先注入」语义提供。
 *
 * @module provider/Drivers/GenericAcpDriver
 */
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  AcpAgentSettings,
  CursorSettings,
  ProviderDriverKind,
  type ServerProvider,
} from "@codework/contracts";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeCursorTextGeneration } from "../../textGeneration/CursorTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCursorAdapter } from "../Layers/CursorAdapter.ts";
import {
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import {
  anthropicGatewayEnv,
  ensureGatewayToken,
  gatewayOrigin,
  openaiGatewayBase,
} from "../byok/modelGateway.ts";
import { splitPifamilyLaunchArgs } from "../Layers/PiAdapter.ts";

const DRIVER_KIND = ProviderDriverKind.make("acpAgent");
const MAINTENANCE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER_KIND, packageName: null }),
);

const decodeAcpSettings = Schema.decodeSync(AcpAgentSettings);

export type GenericAcpDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService
  | ServerSecretStore;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

const PRESENTATION = {
  displayName: "ACP Agent",
  badgeLabel: "ACP",
  showInteractionModeToggle: true,
} as const;

export const GenericAcpDriver: ProviderDriver<AcpAgentSettings, GenericAcpDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "ACP Agent", supportsMultipleInstances: true },
  configSchema: AcpAgentSettings,
  defaultConfig: (): AcpAgentSettings => decodeAcpSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const secretStore = yield* ServerSecretStore;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);

      const commandParts = splitPifamilyLaunchArgs(config.command);
      const acpCommand = commandParts[0];
      if (acpCommand === undefined) {
        return yield* new ProviderDriverError({
          driver: DRIVER_KIND,
          instanceId,
          detail: "通用 ACP Agent 需要配置启动命令（例如 npx -y cline@3.0.46 --acp）。",
        });
      }
      const acpArgs = commandParts.slice(1);

      // BYOK 注入：标准 OpenAI/Anthropic 变量指向本地网关。
      const injectedEnv =
        config.routeThroughByok === true
          ? {
              ...processEnv,
              OPENAI_BASE_URL: openaiGatewayBase(
                gatewayOrigin(serverConfig.port),
                config.byokSourceInstanceId,
              ),
              OPENAI_API_KEY: yield* ensureGatewayToken(secretStore),
              ...anthropicGatewayEnv(
                gatewayOrigin(serverConfig.port),
                yield* ensureGatewayToken(secretStore),
                config.byokSourceInstanceId,
              ),
            }
          : processEnv;

      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies AcpAgentSettings;

      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
        MAINTENANCE,
        { binaryPath: acpCommand, env: injectedEnv },
      );

      // CursorSettings 兼容形状：customModels 透传，binaryPath 用于展示。
      const cursorCompatibleConfig = {
        enabled: effectiveConfig.enabled,
        binaryPath: acpCommand,
        apiEndpoint: "",
        customModels: effectiveConfig.customModels,
      } as unknown as CursorSettings;
      const adapter = yield* makeCursorAdapter(cursorCompatibleConfig, {
        provider: DRIVER_KIND,
        acpCommand,
        acpArgs,
        acpAuthMethodId: effectiveConfig.authMethodId,
        acpClientName: "code-work-acp",
        supportsModelSelection: effectiveConfig.supportsModelSelection,
        environment: injectedEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const textGeneration = yield* makeCursorTextGeneration(cursorCompatibleConfig, injectedEnv, {
        acpCommand,
        acpArgs,
        acpAuthMethodId: effectiveConfig.authMethodId,
        clientName: "code-work-acp-text",
        supportsModelSelection: effectiveConfig.supportsModelSelection,
      });

      // 探测：命令可执行且不抛 ENOENT 即视为 installed；模型目录来自 customModels。
      const checkProvider = Effect.gen(function* () {
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        const models = providerModelsFromSettings([], effectiveConfig.customModels, {
          optionDescriptors: [],
        });
        const probe = yield* Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(acpCommand, ["--version"], {
              env: injectedEnv,
              extendEnv: true,
            }),
          );
          return yield* Effect.all(
            [
              collectStreamAsString(child.stdout),
              collectStreamAsString(child.stderr),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
        }).pipe(Effect.timeout("8 seconds"), Effect.result, Effect.scoped);
        if (Result.isFailure(probe)) {
          const missing = isCommandMissingCause(probe.failure);
          return buildServerProvider({
            presentation: PRESENTATION,
            enabled: effectiveConfig.enabled,
            checkedAt,
            models,
            probe: {
              installed: !missing,
              version: null,
              status: "error",
              auth: { status: "unknown" },
              message: missing
                ? `启动命令 ${acpCommand} 未找到。`
                : "ACP Agent 启动命令探测失败或超时。",
            },
          });
        }
        const [stdout, stderr] = probe.success;
        const text = `${stdout}\n${stderr}`.trim();
        return buildServerProvider({
          presentation: PRESENTATION,
          enabled: effectiveConfig.enabled,
          checkedAt,
          models,
          probe: {
            installed: true,
            version: null,
            // 命令可用即可选：认证在 ACP 会话握手时确认，失败会在回合中明确报错；
            // warning 会被模型选择器判为「受限」，让显式配置的命令永远无法发起会话。
            status: "ready",
            auth: { status: "unknown" },
            message:
              text.length > 0
                ? `命令已配置；探测输出：${text.slice(0, 120)}`
                : "命令已配置；模型与登录由 ACP 会话确认。",
          },
        });
      }).pipe(Effect.map(stampIdentity));

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<AcpAgentSettings>>(
        {
          maintenanceCapabilities,
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: () =>
            Effect.gen(function* () {
              const checkedAt = DateTime.formatIso(yield* DateTime.now);
              return stampIdentity(
                buildServerProvider({
                  presentation: PRESENTATION,
                  enabled: effectiveConfig.enabled,
                  checkedAt,
                  models: providerModelsFromSettings([], effectiveConfig.customModels, {
                    optionDescriptors: [],
                  }),
                  probe: {
                    installed: commandParts.length > 0,
                    version: null,
                    status: "warning",
                    auth: { status: "unknown" },
                    message:
                      commandParts.length > 0
                        ? "ACP Agent 已配置；命令可用性由健康检查确认。"
                        : "尚未配置启动命令。",
                  },
                }),
              );
            }),
          checkProvider,
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build ACP Agent snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
