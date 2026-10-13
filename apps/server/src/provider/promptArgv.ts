import { HostProcessEnvironment, HostProcessPlatform } from "@codework/shared/hostProcess";
import { resolveSpawnCommand, type CommandAvailabilityOptions } from "@codework/shared/shell";
import * as Effect from "effect/Effect";

import { ProviderAdapterValidationError } from "./Errors.ts";

const WINDOWS_PROCESS_LIMIT = 32_767;
const WINDOWS_CMD_LIMIT = 8_191;
// 每个 UTF-16 单元最多编码为三个 UTF-8 字节；这里只早拒不可能装入进程命令行的正文。
const WINDOWS_RAW_PROMPT_LIMIT = (WINDOWS_PROCESS_LIMIT - 1) * 3;

/** 只计算 Node/libuv 引号转换后的长度，不生成或执行另一份命令行。 */
function windowsArgumentLength(argument: string): number {
  if (argument.length > 0 && !/[ \t"]/.test(argument)) return argument.length;
  let length = argument.length + 2;
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes += 1;
    } else {
      if (character === '"') length += backslashes + 1;
      backslashes = 0;
    }
  }
  return length + backslashes;
}

/** 只有正文经 argv 传递的入口使用；stdio/RPC/HTTP 不受 Windows 命令行限制。 */
export const resolvePromptSpawnCommand = Effect.fn("provider.resolvePromptSpawnCommand")(
  function* (input: {
    readonly provider: string;
    readonly operation: string;
    readonly prompt: string;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly options?: CommandAvailabilityOptions | undefined;
  }) {
    const platform = yield* HostProcessPlatform;
    const tooLarge = (stage: string, length: number, limit: number) =>
      new ProviderAdapterValidationError({
        provider: input.provider,
        operation: input.operation,
        code: "AGENT_PROMPT_TOO_LARGE",
        issue: `Windows ${stage}超出长度限制（${length}/${limit}）。请缩短输入或改用文件引用；也可选择通过 stdio/RPC/HTTP 发送正文的 provider。cmd/bat 入口可配置直接可执行文件或内置运行时。`,
      });
    if (platform === "win32") {
      const bytes = Buffer.byteLength(input.prompt, "utf8");
      if (bytes > WINDOWS_RAW_PROMPT_LIMIT) {
        return yield* tooLarge("原始正文 UTF-8 字节", bytes, WINDOWS_RAW_PROMPT_LIMIT);
      }
    }
    const resolved = yield* resolveSpawnCommand(input.command, input.args, input.options).pipe(
      Effect.catchDefect((cause) =>
        cause instanceof Error &&
        cause.message === "Windows cmd.exe shim 不支持包含换行的参数；请改用 .exe 或内置运行时。"
          ? Effect.fail(
              new ProviderAdapterValidationError({
                provider: input.provider,
                operation: input.operation,
                code: "AGENT_PROMPT_UNSUPPORTED",
                issue: cause.message,
              }),
            )
          : Effect.die(cause),
      ),
    );
    if (platform !== "win32") return resolved;
    if (resolved.shell) {
      const environment = yield* HostProcessEnvironment;
      const shell = environment.ComSpec || environment.COMSPEC || environment.comspec || "cmd.exe";
      // Node 的 Windows shell 路径把已经转义的参数合并并包在 /d /s /c 后；cmd 限额计命令字符串。
      const length =
        shell.length +
        ' /d /s /c "'.length +
        resolved.command.length +
        resolved.args.reduce((sum, argument) => sum + 1 + argument.length, 0) +
        '"'.length;
      if (length > WINDOWS_CMD_LIMIT)
        return yield* tooLarge("cmd 展开后命令行 UTF-16 单元", length, WINDOWS_CMD_LIMIT);
    } else {
      const length =
        windowsArgumentLength(resolved.command) +
        resolved.args.reduce((sum, argument) => sum + 1 + windowsArgumentLength(argument), 0) +
        1;
      if (length > WINDOWS_PROCESS_LIMIT)
        return yield* tooLarge("直接进程命令行 UTF-16 单元", length, WINDOWS_PROCESS_LIMIT);
    }
    return resolved;
  },
);
