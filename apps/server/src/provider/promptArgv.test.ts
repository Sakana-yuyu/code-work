import { HostProcessEnvironment, HostProcessPlatform } from "@codework/shared/hostProcess";
import { SpawnExecutableResolution } from "@codework/shared/shell";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { vi } from "vite-plus/test";

import { resolvePromptSpawnCommand } from "./promptArgv.ts";

const resolve = (
  prompt: string,
  command = "ag.exe",
  args: ReadonlyArray<string> = ["-p", prompt],
  platform: NodeJS.Platform = "win32",
  lookup: (command: string) => string | undefined = (value) => value,
) =>
  resolvePromptSpawnCommand({
    provider: "antigravity",
    operation: "sendTurn",
    prompt,
    command,
    args,
  }).pipe(
    Effect.provideService(HostProcessPlatform, platform),
    Effect.provideService(HostProcessEnvironment, { COMSPEC: "cmd.exe" }),
    Effect.provideService(SpawnExecutableResolution, lookup),
  );

describe("Windows prompt argv长度", () => {
  it.effect("短正文保留直接参数，cmd/bat使用现有转义", () =>
    Effect.gen(function* () {
      expect(yield* resolve('短正文 "quoted"')).toEqual({
        command: "ag.exe",
        args: ["-p", '短正文 "quoted"'],
        shell: false,
      });
      for (const command of ["ag.cmd", "ag.BAT"]) {
        const result = yield* resolve("hello & world", command);
        expect(result.shell).toBe(true);
        expect(result.args[1]).toContain("^&");
      }
    }),
  );

  it.effect("明显过大的原始字节在解析可执行路径前拒绝，不回显正文", () =>
    Effect.gen(function* () {
      const lookup = vi.fn((value: string) => value);
      const prompt = "NEVER_ECHO_PROMPT_" + "中".repeat(32_767);
      const result = yield* Effect.result(resolve(prompt, "ag.exe", undefined, "win32", lookup));
      if (Result.isSuccess(result)) throw Error("应该拒绝超限正文");
      expect(result.failure).toMatchObject({
        _tag: "ProviderAdapterValidationError",
        code: "AGENT_PROMPT_TOO_LARGE",
      });
      expect(result.failure.message).toContain("原始正文 UTF-8 字节");
      expect(result.failure.message).not.toContain("NEVER_ECHO_PROMPT_");
      expect(lookup).not.toHaveBeenCalled();
    }),
  );

  it.effect("合法中文不受错误的UTF8单字节限额影响", () =>
    Effect.gen(function* () {
      const prompt = "中".repeat(20_000);
      expect((yield* resolve(prompt)).args[1]).toBe(prompt);
    }),
  );

  it.effect("同一正文的cmd和exe路径使用互斥限额", () =>
    Effect.gen(function* () {
      const prompt = "x".repeat(9_000);
      expect((yield* resolve(prompt)).shell).toBe(false);
      const shellResult = yield* Effect.result(resolve(prompt, "ag.cmd"));
      if (Result.isSuccess(shellResult)) throw Error("cmd应该拒绝");
      expect(shellResult.failure.message).toContain("cmd 展开后");
    }),
  );

  it.effect("按实际解析后的路径选择守卫，调用名不决定cmd/exe", () =>
    Effect.gen(function* () {
      const prompt = "x".repeat(9_000);
      expect((yield* resolve(prompt, "ag", undefined, "win32", () => "C:/bin/ag.exe")).shell).toBe(
        false,
      );
      const shellResult = yield* Effect.result(
        resolve(prompt, "ag.exe", undefined, "win32", () => "C:/bin/ag.cmd"),
      );
      if (Result.isSuccess(shellResult)) throw Error("解析后的cmd应该拒绝");
      expect(shellResult.failure.code).toBe("AGENT_PROMPT_TOO_LARGE");
    }),
  );

  it.effect("cmd转义后的空格和引号膨胀也计入", () =>
    Effect.gen(function* () {
      for (const prompt of [" ".repeat(5_000), '"'.repeat(3_000)]) {
        expect((yield* resolve(prompt)).shell).toBe(false);
        const result = yield* Effect.result(resolve(prompt, "ag.cmd"));
        if (Result.isSuccess(result)) throw Error("cmd转义超限应该拒绝");
        expect(result.failure.code).toBe("AGENT_PROMPT_TOO_LARGE");
      }
    }),
  );

  it.effect("直接exe计入引号和反斜线额外字符", () =>
    Effect.gen(function* () {
      expect((yield* resolve('"'.repeat(12_000))).shell).toBe(false);
      for (const prompt of ['"'.repeat(16_400), '"' + "\\".repeat(16_400)]) {
        const result = yield* Effect.result(resolve(prompt));
        if (Result.isSuccess(result)) throw Error("直接进程引号超限应该拒绝");
        expect(result.failure.message).toContain("直接进程命令行");
      }
    }),
  );

  it.effect("完整命令包括标志、附加参数和结尾空字符，边界不截断", () =>
    Effect.gen(function* () {
      const prompt = "x".repeat(32_756);
      expect((yield* resolve(prompt)).args[1]).toBe(prompt);
      const beyond = yield* Effect.result(resolve(prompt + "x"));
      if (Result.isSuccess(beyond)) throw Error("32768单元应该拒绝");
      expect(beyond.failure.message).toContain("32768/32767");
      const extra = yield* Effect.result(
        resolve("short", "ag.cmd", ["-p", "short", "--resume", "r".repeat(8_191)]),
      );
      expect(Result.isFailure(extra)).toBe(true);
    }),
  );

  it.effect("emoji按UTF16单元计数", () =>
    Effect.gen(function* () {
      expect((yield* resolve("😀".repeat(16_370))).shell).toBe(false);
      expect(Result.isFailure(yield* Effect.result(resolve("😀".repeat(16_384))))).toBe(true);
    }),
  );

  it.effect("cmd完整字符串8191边界包含外壳与转义，不额外扣除NULL", () =>
    Effect.gen(function* () {
      expect((yield* resolve("x".repeat(8_150), "ag.cmd")).shell).toBe(true);
      const result = yield* Effect.result(resolve("x".repeat(8_151), "ag.cmd"));
      if (Result.isSuccess(result)) throw Error("cmd8192字符应该拒绝");
      expect(result.failure.message).toContain("8192/8191");
    }),
  );

  it.effect("非Windows保持既有argv，不解析Windows路径或限制prompt", () =>
    Effect.gen(function* () {
      const lookup = vi.fn((value: string) => value);
      const prompt = "a\n".repeat(50_000);
      expect(yield* resolve(prompt, "ag.cmd", undefined, "linux", lookup)).toEqual({
        command: "ag.cmd",
        args: ["-p", prompt],
        shell: false,
      });
      expect(lookup).not.toHaveBeenCalled();
    }),
  );

  it.effect("cmd不支持的多行参数给类型化建议，exe仍保留完整换行", () =>
    Effect.gen(function* () {
      const prompt = "第一行\r\n第二行";
      expect((yield* resolve(prompt)).args[1]).toBe(prompt);
      const result = yield* Effect.result(resolve(prompt, "ag.cmd"));
      if (Result.isSuccess(result)) throw Error("cmd多行应该拒绝");
      expect(result.failure.code).toBe("AGENT_PROMPT_UNSUPPORTED");
      expect(result.failure.message).toContain("请改用 .exe 或内置运行时");
    }),
  );
});
