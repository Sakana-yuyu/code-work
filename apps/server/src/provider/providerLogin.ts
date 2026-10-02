// @effect-diagnostics nodeBuiltinImport:off - 号池登录只需要预建一次性目录。
import { ProviderInstanceId, type ProviderInstanceConfig } from "@codework/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@codework/shared/hostProcess";
import { resolveSpawnCommand, SpawnExecutableResolution } from "@codework/shared/shell";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServerSettingsError } from "@codework/contracts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ServerConfig } from "../config.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { resolveGrokHome } from "./grokHome.ts";
import { resolveZCodeDataDir } from "./zcode/zcodeByokConfig.ts";
import * as NodeFSP from "node:fs/promises";
import {
  LOCAL_POOL_LOGIN_HOME_ENV,
  isLocalPoolLoginProvider,
  localPoolLoginHome,
  type LocalPoolLoginProvider,
} from "./localPoolLogin.ts";

const LoginConfig = Schema.Struct({
  binaryPath: Schema.optional(Schema.String),
  homePath: Schema.optional(Schema.String),
  shadowHomePath: Schema.optional(Schema.String),
});
const decodeLoginConfig = Schema.decodeUnknownEffect(LoginConfig);

export function providerLoginCommand(
  driver: string,
  deviceCode: boolean,
  loginProvider?: string | undefined,
) {
  switch (driver) {
    case "codex":
      return { binary: "codex", args: deviceCode ? ["login", "--device-auth"] : ["login"] };
    case "claudeAgent":
      return { binary: "claude", args: ["auth", "login"] };
    case "grok":
      return { binary: "grok", args: deviceCode ? ["login", "--device-auth"] : ["login"] };
    case "kimi":
      return { binary: "kimi", args: ["login"] };
    case "antigravity":
      return { binary: "agy", args: [] };
    case "zcodeAgent":
      // zcode login 支持 zai（国际）与 bigmodel（国内）两个域；--no-browser
      // 只打印授权 URL（远程/无浏览器场景）。
      return {
        binary: "zcode",
        args: [
          "login",
          loginProvider === "bigmodel" ? "bigmodel" : "zai",
          ...(deviceCode ? ["--no-browser" as const] : []),
        ],
      };
    default:
      return null;
  }
}

export const startProviderLogin = Effect.fn("startProviderLogin")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly terminalId: string;
  readonly deviceCode: boolean;
  readonly poolLogin?: boolean | undefined;
  readonly loginProvider?: string | undefined;
}) {
  const settings = yield* (yield* ServerSettingsService).getSettings;
  const terminal = yield* TerminalManager;
  const server = yield* ServerConfig;
  const legacy = settings.providers as Record<string, unknown>;
  const instance: ProviderInstanceConfig | undefined = settings.providerInstances[input.instanceId];
  const driver = instance?.driver ?? String(input.instanceId);
  const command = providerLoginCommand(driver, input.deviceCode, input.loginProvider);
  // 号池登录只用一次性目录，不要求该驱动存在实例或 legacy 配置（例如刚添加的 zcodeAgent）。
  if (!command || (!instance && input.poolLogin !== true && legacy[driver] === undefined)) {
    return yield* new ServerSettingsError({
      settingsPath: "providers",
      operation: "normalize",
      providerInstanceId: input.instanceId,
      cause: new Error("此供应商不支持原生 CLI 登录。"),
    });
  }
  const config = yield* decodeLoginConfig(instance?.config ?? legacy[driver] ?? {}).pipe(
    Effect.mapError(
      () =>
        new ServerSettingsError({
          settingsPath: "providers",
          operation: "normalize",
          providerInstanceId: input.instanceId,
          cause: new Error("供应商登录配置无效。"),
        }),
    ),
  );
  const environment = { ...mergeProviderInstanceEnvironment(instance?.environment) };
  // 官方登录不继承 API 网关凭据；保留实例的 HOME，避免登到了另一套账号目录。
  for (const key of [
    "CODEWORK_CODEX_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CURSOR_API_KEY",
    "CURSOR_AUTH_TOKEN",
    "XAI_API_KEY",
    "GROK_API_KEY",
    "KIMI_API_KEY",
    "KIMI_BASE_URL",
    "AGY_API_KEY",
    "AGY_BASE_URL",
    "CODEWORK_BYOK_GATEWAY_TOKEN",
  ]) {
    environment[key] = "";
  }
  const loginHome =
    driver === "codex"
      ? config.shadowHomePath?.trim() || config.homePath?.trim()
      : config.homePath?.trim();
  if (loginHome) {
    environment[driver === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] =
      expandHomePath(loginHome);
  }
  if (driver === "grok" && input.poolLogin !== true) {
    environment.GROK_HOME = resolveGrokHome({
      stateDir: server.stateDir,
      instanceId: input.instanceId,
      routed: false,
      explicitHome: environment.GROK_HOME,
    });
  }
  if (driver === "zcodeAgent" && input.poolLogin !== true) {
    // 官方登录落在实例自己的受管数据根；与其他实例/用户自己的 ~/.zcode 隔离。
    environment.ZCODE_DATA_BASE_DIR = resolveZCodeDataDir({
      stateDir: server.stateDir,
      instanceId: input.instanceId,
    });
  }
  if (input.poolLogin === true) {
    // 号池登录写进一次性目录，登完由 CliProxy 导入凭据；不碰实例自己的登录态。
    const poolProvider: LocalPoolLoginProvider | undefined =
      driver === "codex"
        ? "codex"
        : driver === "claudeAgent"
          ? "claude"
          : driver === "grok"
            ? "xai"
            : driver === "zcodeAgent"
              ? "zcode"
              : undefined;
    if (poolProvider === undefined || !isLocalPoolLoginProvider(poolProvider)) {
      return yield* new ServerSettingsError({
        settingsPath: "providers",
        operation: "normalize",
        providerInstanceId: input.instanceId,
        cause: new Error("此供应商不支持号池登录。"),
      });
    }
    const home = localPoolLoginHome(server.stateDir, input.terminalId);
    yield* Effect.tryPromise(() => NodeFSP.mkdir(home, { recursive: true })).pipe(
      Effect.mapError(
        () =>
          new ServerSettingsError({
            settingsPath: "providers",
            operation: "normalize",
            providerInstanceId: input.instanceId,
            cause: new Error("无法创建号池登录目录。"),
          }),
      ),
    );
    environment[LOCAL_POOL_LOGIN_HOME_ENV[poolProvider]] = home;
  }
  const loginBinary = config.binaryPath?.trim() || command.binary;
  // 预检可执行文件：CLI 没装时 PTY 会在终端里静默死掉，不如直接报错。
  const platform = yield* HostProcessPlatform;
  const hostEnvironment = yield* HostProcessEnvironment;
  const resolveExecutable = yield* SpawnExecutableResolution;
  const resolvedLoginBinary = resolveExecutable(loginBinary, platform, {
    ...hostEnvironment,
    ...environment,
  });
  if (resolvedLoginBinary === undefined) {
    return yield* new ServerSettingsError({
      settingsPath: "providers",
      operation: "normalize",
      providerInstanceId: input.instanceId,
      cause: new Error(`找不到 ${loginBinary} 命令，请确认 CLI 已安装且在 PATH 中。`),
    });
  }
  const resolved = yield* resolveSpawnCommand(loginBinary, command.args, {
    env: environment,
    extendEnv: true,
  });
  const env = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  // Windows npm shim 交给同一 shell 执行，参数由已有解析器转义。
  const snapshot = yield* terminal.runCommand({
    threadId: `provider-login:${input.instanceId}`,
    terminalId: input.terminalId,
    cwd: server.cwd,
    command: resolved.shell ? environment.ComSpec || "cmd.exe" : resolved.command,
    args: resolved.shell
      ? ["/d", "/s", "/c", `"${resolved.command} ${resolved.args.join(" ")}"`]
      : resolved.args,
    env,
    cols: 90,
    rows: 20,
  });
  // 浏览器断线也不能留下无限期登录进程；只清理此次随机终端。
  yield* terminal
    .close({ threadId: snapshot.threadId, terminalId: input.terminalId, deleteHistory: true })
    .pipe(Effect.delay("10 minutes"), Effect.ignoreCause, Effect.forkDetach);
  return snapshot;
});
