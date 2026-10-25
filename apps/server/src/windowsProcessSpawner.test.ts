// @effect-diagnostics nodeBuiltinImport:off - 验证实际 SDK 的原生进程启动边界。
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import { HostProcessExecutablePath, HostProcessPlatform } from "@codework/shared/hostProcess";

import * as ProcessRunner from "./processRunner.ts";

type Completion = (error: Error | null) => void;

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof NodeChildProcess>();
  return {
    ...actual,
    // 记录 SDK 请求的选项，底层始终隐藏，避免旧实现的红灯测试弹出控制台。
    spawn: vi.fn(
      (command: string, args: ReadonlyArray<string>, options: NodeChildProcess.SpawnOptions) =>
        actual.spawn(command, args, { ...options, windowsHide: true }),
    ),
    // 非零退出后的清理只核对调用，不向已退出、可能复用的 PID 执行 taskkill。
    // effect 4.0.6 起 taskkill 走 execFile（附 PID 复用守卫），旧 exec 一并保留。
    exec: vi.fn(
      (
        _command: string,
        optionsOrCallback: NodeChildProcess.ExecOptions | Completion,
        callback?: Completion,
      ) => {
        const complete = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
        queueMicrotask(() => complete?.(null));
        return new actual.ChildProcess();
      },
    ),
    execFile: vi.fn(
      (
        _command: string,
        _args: ReadonlyArray<string>,
        optionsOrCallback: NodeChildProcess.ExecOptions | Completion,
        callback?: Completion,
      ) => {
        const complete = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
        queueMicrotask(() => complete?.(null));
        return new actual.ChildProcess();
      },
    ),
  };
});

const runnerLayer = ProcessRunner.layer.pipe(
  Layer.provide(NodeChildProcessSpawner.layer.pipe(Layer.provide(NodeServices.layer))),
);
const decodeEchoed = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

const run = (input: Omit<ProcessRunner.ProcessRunInput, "command">) =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const executable = yield* HostProcessExecutablePath;
    return yield* runner.run({ command: executable, ...input });
  }).pipe(Effect.provide(runnerLayer));

afterEach(() => vi.clearAllMocks());

it.effect("后台进程隐藏控制台，完整保留引号、Unicode 参数和 stdout", () =>
  Effect.gen(function* () {
    const values = ['带空格和 "引号"', "组合字素：e\u0301 / 😀"];
    const result = yield* run({
      args: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...values],
    });

    expect(result.code).toBe(0);
    const echoed = yield* decodeEchoed(result.stdout);
    expect(echoed).toEqual(values);
    expect(vi.mocked(NodeChildProcess.spawn).mock.calls[0]?.[2]?.windowsHide).toBe(true);
  }),
);

it.effect("隐藏控制台时 stdin 与 stderr 仍可正常传输并结束", () =>
  Effect.gen(function* () {
    const input = "原生进程输入\n第二行 😀\n";
    const result = yield* run({
      args: [
        "-e",
        "let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>{process.stdout.write(text);process.stderr.write('错误流仍可读');});",
      ],
      stdin: input,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(input);
    expect(result.stderr).toBe("错误流仍可读");
    expect(vi.mocked(NodeChildProcess.spawn).mock.calls[0]?.[2]?.windowsHide).toBe(true);
  }),
);

it.effect("非零退出返回原退出码，已退出的 leader 不再执行清理命令", () =>
  Effect.gen(function* () {
    const result = yield* run({ args: ["-e", "process.exit(7)"] });

    expect(result.code).toBe(7);
    const platform = yield* HostProcessPlatform;
    if (platform === "win32") {
      // effect 4.0.6 的 taskkill 带 PID 复用守卫：leader 已退出（exitCode 非空）
      // 时直接跳过清理，不再对可能已被无关进程复用的 PID 执行 taskkill。
      const taskkillCalls = vi
        .mocked(NodeChildProcess.execFile)
        .mock.calls.filter((call) => String(call[0]).includes("taskkill"));
      expect(taskkillCalls.length).toBe(0);
    }
  }),
);
