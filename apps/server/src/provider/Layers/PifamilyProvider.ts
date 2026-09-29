/**
 * pi-family（Pi / OhMyPi）共享快照构建。
 *
 * 两个 Provider 都以 BYOK 为唯一模型来源：模型列表来自网关路由
 * （openai + anthropic，gemini 不经网关），auth 固定上报 byok。
 *
 * @module provider/Layers/PifamilyProvider
 */
import type {
  PiAgentSettings,
  OmpAgentSettings,
  ZCodeAgentSettings,
  ServerProvider,
  ServerProviderModel,
} from "@codework/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@codework/shared/shell";

import {
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  parseGenericCliVersion,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import type { PifamilyModelRoute } from "../pifamily/byokProviderConfig.ts";

export type PifamilyDriverKind = "piAgent" | "ompAgent" | "zcodeAgent";

type PifamilySnapshotSettings = PiAgentSettings | OmpAgentSettings | ZCodeAgentSettings;

const PRESENTATIONS: Record<PifamilyDriverKind, { displayName: string; badgeLabel: string }> = {
  piAgent: { displayName: "Pi", badgeLabel: "BYOK" },
  ompAgent: { displayName: "OhMyPi", badgeLabel: "BYOK" },
  zcodeAgent: { displayName: "ZCode", badgeLabel: "BYOK" },
};

export function pifamilyProviderModels(
  routes: ReadonlyArray<PifamilyModelRoute>,
): ReadonlyArray<ServerProviderModel> {
  return routes.map((route) => ({
    slug: route.adapterId,
    name: route.displayName,
    ...(route.modelId.trim().length > 0 ? { subProvider: route.modelId.trim() } : {}),
    isCustom: false,
    capabilities: null,
  }));
}

export function buildInitialPifamilyProviderSnapshot(input: {
  readonly driverKind: PifamilyDriverKind;
  readonly settings: PifamilySnapshotSettings;
  readonly routes: ReadonlyArray<PifamilyModelRoute>;
}): Effect.Effect<ServerProviderDraft> {
  return Effect.map(DateTime.now, (now) =>
    buildServerProvider({
      presentation: PRESENTATIONS[input.driverKind],
      enabled: input.settings.enabled,
      checkedAt: DateTime.formatIso(now),
      models: pifamilyProviderModels(input.routes),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: input.settings.enabled
          ? "正在检查 CLI；模型由 BYOK 网关提供。"
          : "该供应商已在 Code Work 设置中禁用。",
      },
    }),
  );
}

export const checkPifamilyProviderStatus = Effect.fn("checkPifamilyProviderStatus")(
  function* (input: {
    readonly driverKind: PifamilyDriverKind;
    readonly settings: PifamilySnapshotSettings;
    readonly routes: ReadonlyArray<PifamilyModelRoute>;
    readonly environment?: NodeJS.ProcessEnv;
    /** 探针命令前置参数（ZCode 内嵌运行时的 bundle 路径）。 */
    readonly spawnArgsPrefix?: ReadonlyArray<string>;
    /** 探针用错误/文案里的命令标识（替代裸 binaryPath）。 */
    readonly displayBinaryPath?: string;
    /** 运行时常驻内置（如 vendored ZCode bundle）：跳过 spawn 探针直接视为已安装。 */
    readonly assumeInstalled?: boolean;
  }): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = pifamilyProviderModels(input.routes);
    const label = PRESENTATIONS[input.driverKind].displayName;

    // 探测不受开关影响：禁用只决定状态文案，安装与否必须如实上报。
    // 内嵌运行时（vendored bundle 随包分发）不存在"CLI 未安装"状态，直接跳过探针。
    const probe =
      input.assumeInstalled === true
        ? Result.succeed({ stdout: "", stderr: "", code: 0 })
        : yield* Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const resolved = yield* resolveSpawnCommand(
              input.settings.binaryPath,
              [...(input.spawnArgsPrefix ?? []), "--version"],
              input.environment === undefined ? {} : { env: input.environment },
            );
            const child = yield* spawner.spawn(
              ChildProcess.make(resolved.command, resolved.args, {
                // 附加变量必须 extendEnv 合到父进程环境：ZCode 的 managed env 只有
                // ZCODE_DATA_BASE_DIR 等少数键，整体替换会丢 SYSTEMROOT/PATH，
                // 让 node/Electron 侧车在启动前就返回非零（"版本命令返回失败"）。
                ...(input.environment === undefined ? {} : { env: input.environment }),
                extendEnv: true,
                shell: resolved.shell,
              }),
            );
            const [stdout, stderr, code] = yield* Effect.all(
              [
                collectStreamAsString(child.stdout),
                collectStreamAsString(child.stderr),
                child.exitCode,
              ],
              { concurrency: "unbounded" },
            );
            return { stdout, stderr, code: Number(code) };
          }).pipe(Effect.scoped, Effect.result);

    if (!input.settings.enabled) {
      return buildServerProvider({
        presentation: PRESENTATIONS[input.driverKind],
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: Result.isSuccess(probe) && probe.success.code === 0,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: `${label} 已在 Code Work 设置中禁用。`,
        },
      });
    }

    if (Result.isFailure(probe)) {
      return buildServerProvider({
        presentation: PRESENTATIONS[input.driverKind],
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: !isCommandMissingCause(probe.failure),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(probe.failure)
            ? `${label} CLI ${input.displayBinaryPath ?? input.settings.binaryPath} 未找到。`
            : `${label} CLI 版本检查失败。`,
        },
      });
    }

    const version = parseGenericCliVersion(`${probe.success.stdout}\n${probe.success.stderr}`);
    const noRoutes = input.routes.length === 0;
    return buildServerProvider({
      presentation: PRESENTATIONS[input.driverKind],
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: probe.success.code === 0,
        version,
        status: probe.success.code === 0 ? (noRoutes ? "warning" : "ready") : "error",
        auth: noRoutes
          ? { status: "unknown" }
          : { status: "authenticated", type: "byok", label: "BYOK Gateway" },
        message:
          input.assumeInstalled === true
            ? noRoutes
              ? `${label} 运行时已内置；BYOK 网关没有可用的 OpenAI/Anthropic 模型通道。`
              : `${label} 运行时已内置；模型由 BYOK 网关提供。`
            : noRoutes
              ? `${label} CLI 已安装，但 BYOK 网关没有可用的 OpenAI/Anthropic 模型通道。`
              : probe.success.code === 0
                ? `${label} CLI 已安装；模型由 BYOK 网关提供。`
                : `${label} CLI 版本命令返回失败。`,
      },
    });
  },
);

export function enrichPifamilySnapshot(input: {
  readonly snapshot: ServerProvider;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<void> {
  return input.publishSnapshot(input.snapshot);
}
