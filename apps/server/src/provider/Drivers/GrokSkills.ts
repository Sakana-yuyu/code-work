/**
 * 通过 `grok inspect --json` 获取 `$` 选择器的技能目录，遵守 CLI 自己的
 * 忽略规则、停用设置和插件目录，避免另行扫描文件系统造成差异。
 * 旧 CLI、非零退出和格式错误按最佳努力返回空目录。独立调用最多四秒；
 * 完整刷新传入共享信号时由整轮预算负责超时，中断继续传递给整轮刷新。
 *
 * @module provider/Drivers/GrokSkills
 */
import type { GrokSettings, ServerProviderSkill } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@codework/shared/shell";
import { HostProcessEnvironment, HostProcessWorkingDirectory } from "@codework/shared/hostProcess";

import { spawnAndCollect } from "../providerSnapshot.ts";
import { withCatalogAbortSignal } from "../CliProviderCatalog.ts";

const GROK_SKILLS_PROBE_TIMEOUT_MS = 4_000;

/**
 * Map `grok inspect --json` output onto provider skills. Entries without a
 * name or a filesystem path are skipped; `userInvocable: false` skills are
 * kept but disabled so pickers that filter on `enabled` hide them.
 */
export function parseGrokInspectSkills(stdout: string): ReadonlyArray<ServerProviderSkill> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }
  const entries = (parsed as Record<string, unknown>).skills;
  if (!Array.isArray(entries)) {
    return [];
  }

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const source =
      typeof record.source === "object" && record.source !== null
        ? (record.source as Record<string, unknown>)
        : undefined;
    const path = typeof source?.path === "string" ? source.path.trim() : "";
    if (!name || !path) {
      continue;
    }
    const scope = typeof source?.type === "string" ? source.type.trim() : "";
    const description = typeof record.description === "string" ? record.description.trim() : "";
    skillsByName.set(name, {
      name,
      path,
      enabled: record.userInvocable !== false,
      ...(scope ? { scope } : {}),
      ...(description ? { description } : {}),
    });
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** 独立发现采用四秒最佳努力；共享刷新使用外层预算，取消保持中断。 */
export const discoverGrokSkills = Effect.fn("discoverGrokSkills")(function* (
  grokSettings: Pick<GrokSettings, "binaryPath">,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
  options?: { readonly signal?: AbortSignal; readonly completeEnvironment?: boolean },
): Effect.fn.Return<
  ReadonlyArray<ServerProviderSkill>,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const command = grokSettings.binaryPath || "grok";
  const workingDirectory = cwd ?? (yield* HostProcessWorkingDirectory);
  const processEnvironment = options?.completeEnvironment
    ? { ...environment }
    : { ...(yield* HostProcessEnvironment), ...environment };
  const inspect = Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(command, ["inspect", "--json"], {
      cwd: workingDirectory,
      env: processEnvironment,
      extendEnv: false,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: workingDirectory,
        env: processEnvironment,
        extendEnv: false,
        shell: spawnCommand.shell,
        forceKillAfter: "2 seconds",
      }),
    );
  });
  // 完整刷新已有唯一预算；独立技能入口仍保留四秒最佳努力上限。
  const inspectResult = yield* (
    options?.signal
      ? withCatalogAbortSignal(inspect, options.signal).pipe(Effect.map(Option.some))
      : inspect.pipe(Effect.timeoutOption(GROK_SKILLS_PROBE_TIMEOUT_MS))
  ).pipe(Effect.result);

  if (Result.isFailure(inspectResult) || Option.isNone(inspectResult.success)) {
    yield* Effect.logDebug("Grok skill discovery failed; continuing without skills.");
    return [];
  }
  const output = inspectResult.success.value;
  if (output.code !== 0) {
    yield* Effect.logDebug("Grok skill discovery exited non-zero; continuing without skills.", {
      exitCode: output.code,
    });
    return [];
  }
  return parseGrokInspectSkills(output.stdout);
});
