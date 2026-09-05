import { ProviderInstanceId, type ProviderInstanceConfig } from "@codework/contracts";
import { resolveSpawnCommand } from "@codework/shared/shell";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServerSettingsError } from "@codework/contracts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ServerConfig } from "../config.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import { expandHomePath } from "../pathExpansion.ts";

const LoginConfig = Schema.Struct({
  binaryPath: Schema.optional(Schema.String),
  homePath: Schema.optional(Schema.String),
  shadowHomePath: Schema.optional(Schema.String),
});
const decodeLoginConfig = Schema.decodeUnknownEffect(LoginConfig);

export function providerLoginCommand(driver: string, deviceCode: boolean) {
  switch (driver) {
    case "codex":
      return { binary: "codex", args: deviceCode ? ["login", "--device-auth"] : ["login"] };
    case "claudeAgent":
      return { binary: "claude", args: ["auth", "login"] };
    default:
      return null;
  }
}

export const startProviderLogin = Effect.fn("startProviderLogin")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly terminalId: string;
  readonly deviceCode: boolean;
}) {
  const settings = yield* (yield* ServerSettingsService).getSettings;
  const terminal = yield* TerminalManager;
  const server = yield* ServerConfig;
  const legacy = settings.providers as Record<string, unknown>;
  const instance: ProviderInstanceConfig | undefined = settings.providerInstances[input.instanceId];
  const driver = instance?.driver ?? String(input.instanceId);
  const command = providerLoginCommand(driver, input.deviceCode);
  if (!command || (!instance && legacy[driver] === undefined)) {
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
  const resolved = yield* resolveSpawnCommand(
    config.binaryPath?.trim() || command.binary,
    command.args,
    { env: environment },
  );
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
