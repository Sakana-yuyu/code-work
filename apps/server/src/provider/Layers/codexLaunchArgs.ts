import { tokenizeCliArgs } from "@codework/shared/cliArgs";

export const CODEWORK_CODEX_LAUNCH_ARGS_ENV = "CODEWORK_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => {
  const existing = environment[CODEWORK_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";
  if (!environment.CODEWORK_CODEX_API_KEY?.trim()) return existing;
  // 只影响当前供应商进程；密钥通过环境读取，不写入参数或用户的全局 config.toml。
  const overrides = [
    'model_provider="codework_api"',
    'model_providers.codework_api.name="Code Work API"',
    `model_providers.codework_api.base_url=${JSON.stringify(environment.CODEWORK_CODEX_BASE_URL?.trim() || "https://api.openai.com/v1")}`,
    'model_providers.codework_api.env_key="CODEWORK_CODEX_API_KEY"',
    'model_providers.codework_api.wire_api="responses"',
    "model_providers.codework_api.requires_openai_auth=false",
  ];
  return [existing, ...overrides.map((value) => `-c ${JSON.stringify(value)}`)]
    .filter(Boolean)
    .join(" ");
};

export const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> =>
  tokenizeCliArgs(launchArgs);

export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
];

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};

export const codexSessionAppServerArgs = (
  appServerArgs: ReadonlyArray<string> | undefined,
  launchArgs: string | undefined,
) => {
  const launchAppServerArgs = codexAppServerArgs(launchArgs);
  return appServerArgs ? [...launchAppServerArgs, ...appServerArgs] : launchAppServerArgs;
};
